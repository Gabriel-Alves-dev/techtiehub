// Roda o Claude (via Claude Agent SDK) na pasta de cada mesa. Vive no CONECTOR, no PC
// do usuário; a conversa, a memória e as sessões ficam no hub (o runner recebe uma
// cópia da conversa a cada pedido e manda as novidades de volta).
//
// Pedidos de permissão e perguntas (AskUserQuestion) ficam pendentes até o usuário
// responder pelo hub. Continuidade entre PCs: a sessão inteira é espelhada no hub
// (sessionStore), então pode ser retomada em outro computador e outra pasta; a
// "memória" é um resumo do projeto usado em sessões novas.
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const git = require('./git');

let sdk;
const loadSdk = async () => (sdk ??= await import('@anthropic-ai/claude-agent-sdk'));

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

const MEMORY_SYSTEM = 'Você mantém a memória de trabalho de um agente de programação que trabalha num projeto ' +
  'ao longo de várias sessões e computadores. Responda somente com a memória atualizada, em Markdown e em português, sem introdução.';

class Runner {
  // env: { id, name } deste PC; store: SessionStore (no hub)
  // hub: { push(projectId, role, text), update(projectId, fields),
  //        status(projectId, status, message, log), live(projectId, live|null) }
  constructor({ env, store, hub, describeTool }) {
    Object.assign(this, { env, store, hub, describeTool });
    this.runs = new Map(); // projectId -> { running, pending, abort }
    this.chats = new Map(); // projectId -> cópia local da conversa durante o pedido
  }

  // ---------- Conversa (cópia local + avisos ao hub) ----------
  push(projectId, role, text) {
    this.chats.get(projectId)?.entries.push({ t: Date.now(), role, text });
    this.hub.push(projectId, role, text);
  }

  update(projectId, fields) {
    Object.assign(this.chats.get(projectId) || {}, fields);
    this.hub.update(projectId, fields);
  }

  isRunning(projectId) {
    return !!this.runs.get(projectId)?.running;
  }

  // O que o navegador precisa saber de um pedido em andamento.
  liveOf(projectId) {
    const run = this.runs.get(projectId);
    if (!run?.running) return null;
    const p = run.pending;
    return {
      running: true,
      model: run.model || null,
      // o que está acontecendo agora (age: há quanto tempo, em ms — o relógio de cada PC é diferente)
      phase: run.phase && { kind: run.phase.kind, name: run.phase.name, age: Date.now() - run.phase.since },
      pending: p && {
        id: p.id,
        toolName: p.toolName,
        summary: p.toolName === 'AskUserQuestion' ? 'Tem uma pergunta' : this.describeTool(p.toolName, p.input),
        detail: p.toolName === 'AskUserQuestion' ? '' : this.preview(p.toolName, p.input),
        questions: p.toolName === 'AskUserQuestion' ? p.input.questions : undefined,
        canRemember: p.suggestions.length > 0,
      },
    };
  }

  emitLive(projectId) {
    this.hub.live(projectId, this.liveOf(projectId));
  }

  // depois de reconectar ao hub: reenvia o que está rodando
  resendLive() {
    for (const id of this.runs.keys()) if (this.isRunning(id)) this.emitLive(id);
  }

  preview(name, input = {}) {
    if (input.command) return clip(input.command, 800);
    if (name === 'Edit' && input.file_path) return `${input.file_path}\n\n- ${clip(input.old_string, 300)}\n+ ${clip(input.new_string, 300)}`;
    if (name === 'Write' && input.file_path) return `${input.file_path}\n\n${clip(input.content, 600)}`;
    if (input.file_path) return input.file_path;
    if (input.url) return input.url;
    return clip(JSON.stringify(input, null, 2), 600);
  }

  // ---------- Execução ----------
  // project.folder = pasta da mesa NESTE PC; chat = conversa atual (vinda do hub).
  // Devolve logo: o andamento chega ao hub pelos eventos.
  send(project, text, chat) {
    if (this.isRunning(project.id)) throw new Error('o agente ainda está trabalhando nesta mesa');
    chat = { entries: [], ...chat };
    this.chats.set(project.id, chat);
    const run = { running: true, pending: null, abort: new AbortController(), phase: { kind: 'thinking', since: Date.now() } };
    this.runs.set(project.id, run);
    this.push(project.id, 'user', text);
    this.hub.status(project.id, 'trabalhando', text, true);
    this.emitLive(project.id);

    (async () => {
      try {
        // sessões criadas antes do espelhamento só existem no disco do PC onde nasceram
        if (chat.sessionId && !(await this.store.has(chat.sessionId))) await this.importLocalSession(project.id);

        let prompt = text;
        const moved = chat.sessionId && chat.lastFolder &&
          (chat.lastEnv !== this.env.id || path.resolve(chat.lastFolder) !== path.resolve(project.folder));
        if (moved) {
          const where = chat.lastEnv !== this.env.id ? `no computador "${chat.lastEnvName || 'outro PC'}"` : 'em outra pasta';
          this.push(project.id, 'system', `Continuando a conversa neste PC (${this.env.name}). Antes estava ${where}.`);
          prompt = `[Techtie Hub] Esta conversa continua agora em outro ambiente: computador "${this.env.name}", ` +
            `pasta de trabalho ${project.folder} (antes: ${chat.lastFolder}, ${where}). Caminhos de arquivos citados ` +
            `antes nesta conversa podem não valer mais — use a pasta atual. O código pode ter mudado desde a última vez.\n\n${text}`;
        }

        let ok = await this.runQuery(project, prompt, run);
        if (ok === 'resume-failed') {
          // plano B: sessão nova, com a memória atualizada a partir do histórico
          this.push(project.id, 'system', 'Não consegui retomar a sessão completa — continuando com a memória do agente.');
          await this.refreshMemory(project, chat).then((m) => this.update(project.id, m)).catch(() => {});
          this.update(project.id, { sessionId: null });
          ok = await this.runQuery(project, text, run);
        }
        if (ok === true) {
          this.update(project.id, {
            lastCommit: (await git.head(project.folder)) || chat.lastCommit || null,
            lastEnv: this.env.id, lastEnvName: this.env.name, lastFolder: project.folder,
          });
        }
      } catch (e) {
        if (!run.abort.signal.aborted) {
          this.push(project.id, 'system', `Erro: ${e.message}`);
          this.hub.status(project.id, 'bloqueado', 'Erro: ' + clip(e.message, 120), true);
        }
      } finally {
        if (run.abort.signal.aborted) {
          this.push(project.id, 'system', 'Interrompido por você.');
          this.hub.status(project.id, 'ocioso', 'Parou', true);
        }
        run.running = false;
        run.pending = null;
        this.emitLive(project.id);
      }
    })();
    return { ok: true };
  }

  // Uma rodada do Claude. Devolve true (sucesso), false (terminou com erro)
  // ou 'resume-failed' (a sessão salva não pôde ser retomada).
  async runQuery(project, prompt, run) {
    const { query } = await loadSdk();
    const chat = this.chats.get(project.id);
    const resuming = !!chat.sessionId;
    if (!resuming) this.update(project.id, { sessionAppend: this.memoryPrompt(chat) });
    let started = false, success = false;
    try {
      const q = query({
        prompt,
        options: {
          cwd: project.folder,
          resume: chat.sessionId || undefined,
          sessionStore: this.store,
          // snapshot:false = o prompt de sistema é montado a cada pedido, com a pasta e o
          // git do PC atual (gravado na sessão, ele carregaria a pasta do PC antigo)
          systemPrompt: { type: 'preset', preset: 'claude_code', append: chat.sessionAppend || undefined, snapshot: false },
          // modelo e esforço escolhidos para o agente; vazio = o padrão do Claude Code deste PC
          model: project.model || undefined,
          effort: project.effort || undefined,
          abortController: run.abort,
          canUseTool: (name, input, opts) => this.ask(project.id, run, name, input, opts),
        },
      });
      for await (const m of q) {
        if (m.type === 'assistant') started = true;
        if (m.type === 'result') success = m.subtype === 'success';
        this.handle(project.id, m);
      }
    } catch (e) {
      if (resuming && !started && !run.abort.signal.aborted) return 'resume-failed';
      throw e;
    }
    return success;
  }

  // fase atual (pensando / esperando uma ferramenta), mostrada com cronômetro na mesa
  setPhase(projectId, kind, name) {
    const run = this.runs.get(projectId);
    if (!run?.running) return;
    run.phase = { kind, name, since: Date.now() };
    this.emitLive(projectId);
  }

  handle(projectId, m) {
    if (m.type === 'system' && m.subtype === 'init') {
      this.update(projectId, { sessionId: m.session_id, lastModel: m.model });
      const run = this.runs.get(projectId);
      if (run) run.model = m.model;
      this.emitLive(projectId);
    } else if (m.type === 'assistant') {
      let tool = null;
      for (const c of m.message.content) {
        if (c.type === 'text' && c.text.trim()) this.push(projectId, 'assistant', c.text);
        if (c.type === 'tool_use' && c.name !== 'AskUserQuestion') {
          const what = this.describeTool(c.name, c.input);
          this.push(projectId, 'tool', what);
          this.hub.status(projectId, 'trabalhando', what, false);
          tool = c.name.replace(/^mcp__/, '').replace(/__/g, ' › '); // mcp__bitrix__get_task → bitrix › get_task
        }
      }
      this.setPhase(projectId, tool ? 'tool' : 'thinking', tool);
    } else if (m.type === 'user') {
      this.setPhase(projectId, 'thinking'); // a ferramenta respondeu: o Claude volta a pensar
    } else if (m.type === 'result') {
      if (m.subtype === 'success') this.hub.status(projectId, 'concluido', 'Terminou — aguardando você', true);
      else {
        this.push(projectId, 'system', `Parou com erro (${m.subtype}).`);
        this.hub.status(projectId, 'bloqueado', `Parou com erro (${m.subtype})`, true);
      }
    }
  }

  async importLocalSession(projectId) {
    const chat = this.chats.get(projectId);
    try {
      const { importSessionToStore } = await loadSdk();
      await importSessionToStore(chat.sessionId, this.store);
    } catch {
      // o arquivo local não está neste PC: segue com sessão nova + memória
      this.update(projectId, { sessionId: null });
    }
  }

  // canUseTool: fica esperando até o usuário responder no hub.
  ask(projectId, run, toolName, input, { signal, suggestions } = {}) {
    return new Promise((resolve) => {
      const id = crypto.randomBytes(4).toString('hex');
      run.pending = { id, toolName, input, suggestions: suggestions || [], resolve };
      const isQuestion = toolName === 'AskUserQuestion';
      this.hub.status(projectId, 'bloqueado',
        isQuestion ? 'Tem uma pergunta para você' : 'Pedindo permissão: ' + this.describeTool(toolName, input), true);
      this.emitLive(projectId);
      signal?.addEventListener('abort', () => {
        if (run.pending?.id !== id) return;
        run.pending = null;
        resolve({ behavior: 'deny', message: 'Cancelado' });
      });
    });
  }

  answer(projectId, { requestId, decision, answers, message }) {
    const run = this.runs.get(projectId);
    const p = run?.pending;
    if (!p || p.id !== requestId) throw new Error('esse pedido já foi respondido');
    run.pending = null;

    let result;
    if (p.toolName === 'AskUserQuestion') {
      // respostas chegam na ordem das perguntas; a chave tem que ser o texto exato da pergunta
      const map = {};
      p.input.questions.forEach((q, i) => {
        const a = Array.isArray(answers) ? answers[i] : answers?.[q.question];
        if (a) map[q.question] = [].concat(a).join(', ');
      });
      result = { behavior: 'allow', updatedInput: { questions: p.input.questions, answers: map } };
      this.push(projectId, 'user', Object.entries(map).map(([q, a]) => `${q}\n→ ${a}`).join('\n\n'));
    } else if (decision === 'deny') {
      result = { behavior: 'deny', message: message || 'O usuário negou essa ação.' };
      this.push(projectId, 'system', `Você negou: ${this.describeTool(p.toolName, p.input)}`);
    } else {
      result = { behavior: 'allow', updatedInput: p.input };
      if (decision === 'always') {
        const local = p.suggestions.filter((s) => s.destination === 'localSettings');
        result.updatedPermissions = local.length ? local : p.suggestions;
      }
      this.push(projectId, 'system', `Você ${decision === 'always' ? 'permitiu sempre' : 'permitiu'}: ${this.describeTool(p.toolName, p.input)}`);
    }
    this.hub.status(projectId, 'trabalhando', 'Continuando…', false);
    p.resolve(result);
    this.emitLive(projectId);
    return { ok: true };
  }

  stop(projectId) {
    this.runs.get(projectId)?.abort.abort();
    return { ok: true };
  }

  // ---------- Memória do agente ----------
  memoryPrompt(chat) {
    if (!chat.memory?.trim()) return '';
    return '# Memória deste projeto (Techtie Hub)\n' +
      'Você já trabalhou neste projeto antes, talvez em outro computador. Este é o resumo do que você sabe ' +
      `até agora. Use como contexto, mas confira o código atual antes de agir.${chat.lastCommit ? ` Último commit em que você trabalhou: ${chat.lastCommit}.` : ''}\n\n` +
      chat.memory.trim();
  }

  // Junta a memória atual com o que aconteceu desde a última atualização (uma chamada
  // curta ao Claude, sem ferramentas e sem as configurações/hooks do usuário).
  // Devolve { memory, memoryAt } — quem chamou salva.
  async refreshMemory(project, chat) {
    const fresh = (chat.entries || []).filter((e) => e.t > (chat.memoryAt || 0));
    if (!fresh.length) return { memory: chat.memory || '', memoryAt: chat.memoryAt || null };
    const label = { user: 'Usuário', assistant: 'Agente', tool: 'Ação', system: 'Hub' };
    const convo = fresh.map((e) => `${label[e.role] || e.role}: ${clip(e.text, e.role === 'tool' ? 150 : 1500)}`)
      .join('\n\n').slice(-60000);
    const prompt = `Projeto: ${project.name}${project.description ? ` — ${project.description}` : ''}\n\n` +
      `Memória atual:\n<memoria>\n${chat.memory?.trim() || '(vazia)'}\n</memoria>\n\n` +
      `O que aconteceu desde a última atualização:\n<conversa>\n${convo}\n</conversa>\n\n` +
      'Escreva a memória atualizada com estas seções: ## Projeto, ## Feito até agora, ## Decisões e preferências do usuário, ' +
      '## Em andamento e próximos passos, ## Observações. Seja conciso (até ~400 palavras): mantenha o que continua ' +
      'relevante e descarte o que ficou obsoleto.';
    const { query } = await loadSdk();
    let out = '';
    for await (const m of query({
      prompt,
      options: { cwd: os.tmpdir(), tools: [], maxTurns: 1, settingSources: [], persistSession: false, systemPrompt: MEMORY_SYSTEM },
    })) {
      if (m.type === 'result' && m.subtype === 'success') out = m.result || '';
    }
    if (!out.trim()) throw new Error('não consegui gerar a memória');
    return { memory: out.trim(), memoryAt: fresh[fresh.length - 1].t };
  }
}

module.exports = { Runner };

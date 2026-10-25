// Roda o Claude (via Claude Agent SDK) na pasta de cada mesa.
// Pedidos de permissão e perguntas (AskUserQuestion) ficam pendentes até o usuário responder pelo hub.
//
// Continuidade entre PCs: a sessão inteira é espelhada em data/sessions/ (session-store.js),
// então a conversa pode ser retomada em outro computador e outra pasta. A "memória" é um
// resumo do projeto mantido pelo hub; ela entra no prompt de sistema de sessões novas
// (Nova conversa, ou quando a sessão completa não pode ser retomada).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const git = require('./git');
const { FileSessionStore } = require('./session-store');

let sdk;
const loadSdk = async () => (sdk ??= await import('@anthropic-ai/claude-agent-sdk'));

const MAX_ENTRIES = 500;
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

const MEMORY_SYSTEM = 'Você mantém a memória de trabalho de um agente de programação que trabalha num projeto ' +
  'ao longo de várias sessões e computadores. Responda somente com a memória atualizada, em Markdown e em português, sem introdução.';

class Runner {
  // env: { id, name } do computador atual
  // onStatus(projectId, status, message, log) — atualiza o agente da mesa
  // onLive() — estado de execução mudou (rodando / pedido pendente)
  // onChat(projectId, entry) — nova linha na conversa
  constructor({ dir, sessionsDir, env, describeTool, onStatus, onLive, onChat }) {
    Object.assign(this, { dir, env, describeTool, onStatus, onLive, onChat });
    this.store = new FileSessionStore(sessionsDir);
    this.runs = new Map(); // projectId -> { running, pending, abort }
    this.chats = new Map(); // projectId -> conversa (ver chat())
    this.hubSessions = new Set(); // sessões criadas pelo hub (os hooks delas são ignorados)
    fs.mkdirSync(dir, { recursive: true });
  }

  // ---------- Conversa salva em disco ----------
  // { sessionId, sessionAppend, entries, memory, memoryAt, lastCommit, lastEnv, lastEnvName, lastFolder }
  chat(projectId) {
    if (!this.chats.has(projectId)) {
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(path.join(this.dir, projectId + '.json'), 'utf8'));
      } catch {}
      data.entries ??= [];
      if (data.sessionId) this.hubSessions.add(data.sessionId);
      this.chats.set(projectId, data);
    }
    return this.chats.get(projectId);
  }

  saveChat(projectId) {
    fs.writeFileSync(path.join(this.dir, projectId + '.json'), JSON.stringify(this.chat(projectId)));
  }

  push(projectId, role, text) {
    const chat = this.chat(projectId);
    const entry = { t: Date.now(), role, text };
    chat.entries.push(entry);
    if (chat.entries.length > MAX_ENTRIES) chat.entries.splice(0, chat.entries.length - MAX_ENTRIES);
    this.saveChat(projectId);
    this.onChat(projectId, entry);
  }

  isHubSession(sessionId) {
    return !!sessionId && this.hubSessions.has(sessionId);
  }

  isRunning(projectId) {
    return !!this.runs.get(projectId)?.running;
  }

  // Resumo do que está rodando, enviado ao navegador junto com o estado.
  live() {
    const out = {};
    for (const [id, run] of this.runs) {
      if (!run.running) continue;
      const p = run.pending;
      out[id] = {
        running: true,
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
    return out;
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
  // project.folder já é a pasta da mesa NESTE computador.
  async send(project, text) {
    if (this.isRunning(project.id)) throw new Error('o agente ainda está trabalhando nesta mesa');
    const chat = this.chat(project.id);
    const run = { running: true, pending: null, abort: new AbortController() };
    this.runs.set(project.id, run);
    this.push(project.id, 'user', text);
    this.onStatus(project.id, 'trabalhando', text, true);
    this.onLive();

    (async () => {
      try {
        // sessões criadas antes do espelhamento só existem no disco do PC onde nasceram
        if (chat.sessionId && !this.store.has(chat.sessionId)) await this.importLocalSession(project.id);

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
          // plano B: sessão nova, com a memória atualizada a partir do histórico do hub
          this.push(project.id, 'system', 'Não consegui retomar a sessão completa — continuando com a memória do agente.');
          await this.refreshMemory(project).catch(() => {});
          chat.sessionId = null;
          ok = await this.runQuery(project, text, run);
        }
        if (ok === true) {
          chat.lastCommit = (await git.head(project.folder)) || chat.lastCommit || null;
          Object.assign(chat, { lastEnv: this.env.id, lastEnvName: this.env.name, lastFolder: project.folder });
          this.saveChat(project.id);
        }
      } catch (e) {
        if (!run.abort.signal.aborted) {
          this.push(project.id, 'system', `Erro: ${e.message}`);
          this.onStatus(project.id, 'bloqueado', 'Erro: ' + clip(e.message, 120), true);
        }
      } finally {
        if (run.abort.signal.aborted) {
          this.push(project.id, 'system', 'Interrompido por você.');
          this.onStatus(project.id, 'ocioso', 'Parou', true);
        }
        run.running = false;
        run.pending = null;
        this.onLive();
      }
    })();
  }

  // Uma rodada do Claude. Devolve true (sucesso), false (terminou com erro)
  // ou 'resume-failed' (a sessão salva não pôde ser retomada).
  async runQuery(project, prompt, run) {
    const { query } = await loadSdk();
    const chat = this.chat(project.id);
    const resuming = !!chat.sessionId;
    if (!resuming) chat.sessionAppend = this.memoryPrompt(chat);
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

  handle(projectId, m) {
    if (m.type === 'system' && m.subtype === 'init') {
      const chat = this.chat(projectId);
      chat.sessionId = m.session_id;
      this.hubSessions.add(m.session_id);
      this.saveChat(projectId);
    } else if (m.type === 'assistant') {
      for (const c of m.message.content) {
        if (c.type === 'text' && c.text.trim()) this.push(projectId, 'assistant', c.text);
        if (c.type === 'tool_use' && c.name !== 'AskUserQuestion') {
          const what = this.describeTool(c.name, c.input);
          this.push(projectId, 'tool', what);
          this.onStatus(projectId, 'trabalhando', what, false);
        }
      }
    } else if (m.type === 'result') {
      if (m.subtype === 'success') this.onStatus(projectId, 'concluido', 'Terminou — aguardando você', true);
      else {
        this.push(projectId, 'system', `Parou com erro (${m.subtype}).`);
        this.onStatus(projectId, 'bloqueado', `Parou com erro (${m.subtype})`, true);
      }
    }
  }

  async importLocalSession(projectId) {
    const chat = this.chat(projectId);
    try {
      const { importSessionToStore } = await loadSdk();
      await importSessionToStore(chat.sessionId, this.store);
    } catch {
      // o arquivo local não está neste PC: segue com sessão nova + memória
      chat.sessionId = null;
      this.saveChat(projectId);
    }
  }

  // canUseTool: fica esperando até o usuário responder no hub.
  ask(projectId, run, toolName, input, { signal, suggestions } = {}) {
    return new Promise((resolve) => {
      const id = crypto.randomBytes(4).toString('hex');
      run.pending = { id, toolName, input, suggestions: suggestions || [], resolve };
      const isQuestion = toolName === 'AskUserQuestion';
      this.onStatus(projectId, 'bloqueado',
        isQuestion ? 'Tem uma pergunta para você' : 'Pedindo permissão: ' + this.describeTool(toolName, input), true);
      this.onLive();
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
    this.onStatus(projectId, 'trabalhando', 'Continuando…', false);
    p.resolve(result);
    this.onLive();
  }

  stop(projectId) {
    this.runs.get(projectId)?.abort.abort();
  }

  // Nova conversa: guarda o que importa na memória e começa uma sessão limpa.
  async reset(project) {
    if (this.isRunning(project.id)) throw new Error('pare o agente antes de começar outra conversa');
    const chat = this.chat(project.id);
    await this.refreshMemory(project).catch(() => {});
    if (chat.sessionId) await this.store.delete({ sessionId: chat.sessionId });
    this.chats.set(project.id, { entries: [], memory: chat.memory, memoryAt: Date.now(), lastCommit: chat.lastCommit });
    this.saveChat(project.id);
    this.onLive();
  }

  // ---------- Memória do agente ----------
  memoryPrompt(chat) {
    if (!chat.memory?.trim()) return '';
    return '# Memória deste projeto (Techtie Hub)\n' +
      'Você já trabalhou neste projeto antes, talvez em outro computador. Este é o resumo do que você sabe ' +
      `até agora. Use como contexto, mas confira o código atual antes de agir.${chat.lastCommit ? ` Último commit em que você trabalhou: ${chat.lastCommit}.` : ''}\n\n` +
      chat.memory.trim();
  }

  setMemory(projectId, memory) {
    const chat = this.chat(projectId);
    chat.memory = String(memory || '').slice(0, 20000);
    chat.memoryAt = Date.now(); // o que foi editado à mão conta como atualizado
    this.saveChat(projectId);
  }

  // Junta a memória atual com o que aconteceu desde a última atualização (uma chamada
  // curta ao Claude, sem ferramentas e sem as configurações/hooks do usuário).
  async refreshMemory(project) {
    const chat = this.chat(project.id);
    const fresh = chat.entries.filter((e) => e.t > (chat.memoryAt || 0));
    if (!fresh.length) return chat.memory || '';
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
    chat.memory = out.trim();
    chat.memoryAt = fresh[fresh.length - 1].t;
    this.saveChat(project.id);
    return chat.memory;
  }

  // ---------- Exportar / importar ----------
  exportAll() {
    const chats = {};
    for (const f of fs.readdirSync(this.dir)) {
      if (f.endsWith('.json')) chats[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
    }
    return { chats, sessions: this.store.exportAll() };
  }

  importAll({ chats, sessions }) {
    for (const [id, chat] of Object.entries(chats || {})) {
      if (!/^[\w-]+$/.test(id)) continue;
      fs.writeFileSync(path.join(this.dir, id + '.json'), JSON.stringify(chat));
    }
    this.store.importAll(sessions);
    this.chats.clear();
  }
}

module.exports = { Runner };

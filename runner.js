// Roda o Claude (via Claude Agent SDK) na pasta de cada mesa.
// Pedidos de permissão e perguntas (AskUserQuestion) ficam pendentes até o usuário responder pelo hub.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let sdk;
const loadSdk = async () => (sdk ??= await import('@anthropic-ai/claude-agent-sdk'));

const MAX_ENTRIES = 500;
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

class Runner {
  // onStatus(projectId, status, message, log) — atualiza o agente da mesa
  // onLive() — estado de execução mudou (rodando / pedido pendente)
  // onChat(projectId, entry) — nova linha na conversa
  constructor({ dir, describeTool, onStatus, onLive, onChat }) {
    Object.assign(this, { dir, describeTool, onStatus, onLive, onChat });
    this.runs = new Map(); // projectId -> { running, pending, abort }
    this.chats = new Map(); // projectId -> { sessionId, entries }
    this.hubSessions = new Set(); // sessões criadas pelo hub (os hooks delas são ignorados)
    fs.mkdirSync(dir, { recursive: true });
  }

  // ---------- Conversa salva em disco ----------
  chat(projectId) {
    if (!this.chats.has(projectId)) {
      let data = { sessionId: null, entries: [] };
      try {
        data = JSON.parse(fs.readFileSync(path.join(this.dir, projectId + '.json'), 'utf8'));
      } catch {}
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
  async send(project, text) {
    if (this.runs.get(project.id)?.running) throw new Error('o agente ainda está trabalhando nesta mesa');
    const { query } = await loadSdk();
    const chat = this.chat(project.id);
    const run = { running: true, pending: null, abort: new AbortController() };
    this.runs.set(project.id, run);
    this.push(project.id, 'user', text);
    this.onStatus(project.id, 'trabalhando', text, true);
    this.onLive();

    const resumed = !!chat.sessionId;
    (async () => {
      try {
        const q = query({
          prompt: text,
          options: {
            cwd: project.folder,
            resume: chat.sessionId || undefined,
            abortController: run.abort,
            canUseTool: (name, input, opts) => this.ask(project.id, run, name, input, opts),
          },
        });
        for await (const m of q) this.handle(project.id, m);
      } catch (e) {
        if (!run.abort.signal.aborted) {
          const hint = resumed ? ' — se persistir, clique em "Nova conversa".' : '';
          this.push(project.id, 'system', `Erro: ${e.message}${hint}`);
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

  reset(projectId) {
    if (this.runs.get(projectId)?.running) throw new Error('pare o agente antes de começar outra conversa');
    this.chats.set(projectId, { sessionId: null, entries: [] });
    this.saveChat(projectId);
    this.onLive();
  }
}

module.exports = { Runner };

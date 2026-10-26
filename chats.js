// Conversas das mesas, guardadas no hub (data/chats/<projectId>.json).
// O conector manda as novidades (linhas da conversa, sessão, commit, memória) e o hub
// salva e repassa aos navegadores. Assim qualquer PC conectado continua de onde parou.
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 500;
// campos que o conector pode atualizar
const FIELDS = ['sessionId', 'sessionAppend', 'lastCommit', 'lastEnv', 'lastEnvName', 'lastFolder', 'lastModel', 'memory', 'memoryAt'];

class ChatStore {
  // onChat(projectId, entry) — nova linha (o hub repassa por SSE)
  constructor(dir, onChat) {
    this.dir = dir;
    this.onChat = onChat;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  // { sessionId, sessionAppend, entries, memory, memoryAt, lastCommit, lastEnv, lastEnvName, lastFolder }
  get(projectId) {
    if (!this.cache.has(projectId)) {
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(path.join(this.dir, projectId + '.json'), 'utf8'));
      } catch {}
      data.entries ??= [];
      this.cache.set(projectId, data);
    }
    return this.cache.get(projectId);
  }

  save(projectId) {
    fs.writeFileSync(path.join(this.dir, projectId + '.json'), JSON.stringify(this.get(projectId)));
  }

  // images: nomes de arquivos já guardados no escritório (ver Office.saveUpload)
  push(projectId, role, text, images) {
    const chat = this.get(projectId);
    const entry = { t: Date.now(), role, text: String(text) };
    if (images?.length) entry.images = images;
    chat.entries.push(entry);
    if (chat.entries.length > MAX_ENTRIES) chat.entries.splice(0, chat.entries.length - MAX_ENTRIES);
    this.save(projectId);
    this.onChat(projectId, entry);
    return entry;
  }

  update(projectId, fields) {
    const chat = this.get(projectId);
    for (const f of FIELDS) if (fields[f] !== undefined) chat[f] = fields[f];
    this.save(projectId);
  }

  setMemory(projectId, memory) {
    this.update(projectId, { memory: String(memory || '').slice(0, 20000), memoryAt: Date.now() });
  }

  // Nova conversa: limpa a conversa e a sessão, mas a memória e o último commit ficam.
  reset(projectId) {
    const old = this.get(projectId);
    this.cache.set(projectId, { entries: [], memory: old.memory, memoryAt: Date.now(), lastCommit: old.lastCommit });
    this.save(projectId);
    return old.sessionId;
  }

  // sessões criadas pelo hub (os hooks delas são ignorados: o conector já informa tudo)
  hasSession(sessionId) {
    if (!sessionId) return false;
    for (const f of fs.readdirSync(this.dir)) {
      if (f.endsWith('.json') && this.get(f.slice(0, -5)).sessionId === sessionId) return true;
    }
    return false;
  }

  exportAll() {
    const out = {};
    for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.json')) out[f.slice(0, -5)] = this.get(f.slice(0, -5));
    return out;
  }

  importAll(chats) {
    for (const [id, chat] of Object.entries(chats || {})) {
      if (!/^[\w-]+$/.test(id)) continue;
      fs.writeFileSync(path.join(this.dir, id + '.json'), JSON.stringify(chat));
    }
    this.cache.clear();
  }
}

module.exports = { ChatStore };

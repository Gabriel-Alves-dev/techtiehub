// SessionStore do Claude Agent SDK gravando em arquivos (data/sessions/).
// O SDK espelha aqui cada linha da sessão e, ao retomar, carrega daqui — por isso a
// conversa continua inteira em outro PC ou outra pasta, desde que data/ vá junto.
// A chave é só o id da sessão: o projectKey do SDK depende do cwd, que muda entre PCs.
const fs = require('fs');
const path = require('path');

const enc = encodeURIComponent;

class FileSessionStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file({ sessionId, subpath }) {
    return path.join(this.dir, enc(sessionId) + (subpath ? '~' + enc(subpath) : '') + '.jsonl');
  }

  has(sessionId) {
    return fs.existsSync(this.file({ sessionId }));
  }

  async append(key, entries) {
    if (!entries.length) return;
    fs.appendFileSync(this.file(key), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  async load(key) {
    try {
      return fs.readFileSync(this.file(key), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return null;
    }
  }

  async listSubkeys({ sessionId }) {
    const prefix = enc(sessionId) + '~';
    return fs.readdirSync(this.dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
      .map((f) => decodeURIComponent(f.slice(prefix.length, -'.jsonl'.length)));
  }

  async delete({ sessionId }) {
    const main = enc(sessionId);
    for (const f of fs.readdirSync(this.dir)) {
      if (f === main + '.jsonl' || f.startsWith(main + '~')) fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }

  // exportar/importar (levar o escritório para outro PC)
  exportAll() {
    const out = {};
    for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.jsonl')) out[f] = fs.readFileSync(path.join(this.dir, f), 'utf8');
    return out;
  }

  importAll(files) {
    for (const [name, content] of Object.entries(files || {})) {
      if (path.basename(name) !== name || !name.endsWith('.jsonl')) continue; // nada de caminhos
      fs.writeFileSync(path.join(this.dir, name), content);
    }
  }
}

module.exports = { FileSessionStore };

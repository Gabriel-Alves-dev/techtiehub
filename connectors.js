// Lado do hub: conectores dos PCs ligados por um stream SSE (hub → conector, comandos)
// e requisições HTTP (conector → hub, respostas e eventos). O conector é quem abre a
// conexão, então o PC não precisa de porta aberta nem IP público.
const crypto = require('crypto');

class Connectors {
  // onChange() — algum PC entrou/saiu; onDisconnect(envId) — PC caiu
  constructor({ onChange, onDisconnect }) {
    Object.assign(this, { onChange, onDisconnect });
    this.byEnv = new Map(); // envId -> { name, res, since }
    this.pending = new Map(); // id do comando -> { resolve, reject, timer, envId }
  }

  attach(envId, name, req, res, version = null) {
    this.byEnv.get(envId)?.res.end(); // a mesma identidade conectou de novo: fica a conexão nova
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': conectado\n\n');
    const entry = { name, res, since: Date.now(), version };
    this.byEnv.set(envId, entry);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000); // proxies derrubam conexões paradas
    req.on('close', () => {
      clearInterval(ping);
      if (this.byEnv.get(envId) !== entry) return; // já substituída por uma conexão nova
      this.byEnv.delete(envId);
      for (const [id, p] of this.pending) {
        if (p.envId !== envId) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error(`o PC "${name}" desconectou`));
      }
      this.onDisconnect(envId);
      this.onChange();
    });
    this.onChange();
  }

  has(envId) {
    return this.byEnv.has(envId);
  }

  online() {
    const out = {};
    for (const [id, c] of this.byEnv) out[id] = { name: c.name, since: c.since, version: c.version };
    return out;
  }

  rename(envId, name) {
    const c = this.byEnv.get(envId);
    if (c) c.name = name;
  }

  // Manda um comando ao conector do PC e espera a resposta.
  rpc(envId, type, payload = {}, timeout = 30000) {
    const c = this.byEnv.get(envId);
    if (!c) return Promise.reject(new Error('esse PC não está conectado ao hub'));
    const id = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`o PC "${c.name}" não respondeu a tempo`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, envId });
      c.res.write(`event: cmd\ndata: ${JSON.stringify({ id, type, payload })}\n\n`);
    });
  }

  reply({ id, ok, data, error }) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (ok) p.resolve(data);
    else p.reject(new Error(error || 'erro no PC'));
  }
}

module.exports = { Connectors };

// SessionStore do Claude Agent SDK que guarda as sessões NO HUB (lado do conector).
// O SDK espelha cada linha da sessão aqui e, ao retomar, carrega daqui — então a
// conversa continua inteira em qualquer PC conectado ao mesmo hub.
class RemoteSessionStore {
  // call(op, body) → Promise com a resposta do hub
  constructor(call) {
    this.call = call;
  }

  append(key, entries) {
    return entries.length ? this.call('append', { key, entries }) : Promise.resolve();
  }

  load(key) {
    return this.call('load', { key });
  }

  listSubkeys(key) {
    return this.call('subkeys', { key });
  }

  delete(key) {
    return this.call('delete', { key });
  }

  has(sessionId) {
    return this.call('has', { sessionId });
  }
}

module.exports = { RemoteSessionStore };

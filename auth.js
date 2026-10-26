// Contas, login e credenciais dos conectores.
//
// - Usuários com senha (scrypt + sal). Cada usuário é dono de um escritório; o escritório
//   é separado da conta para, no futuro, poder ter vários membros.
// - Sessões de login: token aleatório no cookie; no disco fica só o hash (sha256).
// - Convites: depois da primeira conta, só entra quem tem um código de convite.
// - Conectores: o PC é pareado com um código curto (10 min) e recebe um token próprio,
//   ligado a um escritório e a um PC; pode ser revogado.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_DAYS = 30;
const PAIR_MINUTES = 10;
const INVITE_DAYS = 7;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
// código fácil de digitar: sem 0/O, 1/I/L
const shortCode = () => {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from(crypto.randomBytes(4), (b) => abc[b % abc.length]).join('');
  return `${pick()}-${pick()}`;
};

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

class Auth {
  constructor(dir, { setupCode } = {}) {
    this.setupCode = setupCode ? String(setupCode).trim().toUpperCase() : null;
    this.file = path.join(dir, 'auth.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      this.db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.db = {};
    }
    // users: [{ id, email, name, salt, hash, offices: [officeId], createdAt }]
    // sessions: { sha(token): { userId, exp } }      invites: { sha(code): { by, exp } }
    // connectors: { sha(token): { id, officeId, envId, name, createdAt, lastSeen } }
    for (const k of ['users']) this.db[k] ??= [];
    for (const k of ['sessions', 'invites', 'connectors']) this.db[k] ??= {};
    this.pairings = new Map(); // código -> { officeId, exp } (só em memória: vale 10 min)
    this.failures = new Map(); // ip -> { n, until } (freio contra adivinhar senha)
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.db, null, 2));
  }

  hasUsers() {
    return this.db.users.length > 0;
  }

  publicUser(u) {
    return u && { id: u.id, email: u.email, name: u.name, offices: u.offices };
  }

  // ---------- Contas ----------
  // setupCode: exigido na PRIMEIRA conta quando o hub está exposto (ver server.js);
  // sem ele, qualquer um que achasse o endereço poderia tomar o hub.
  createUser({ email, name, password, invite, setup, officeId }, ip) {
    this.guard(ip, 'signup');
    email = String(email || '').trim().toLowerCase();
    name = String(name || '').trim().slice(0, 40) || email.split('@')[0];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('e-mail inválido');
    if (String(password || '').length < 8) throw new Error('a senha precisa de pelo menos 8 caracteres');
    if (this.db.users.some((u) => u.email === email)) throw new Error('já existe uma conta com esse e-mail');
    if (!this.hasUsers() && this.setupCode && String(setup || '').trim().toUpperCase() !== this.setupCode) {
      this.fail(ip, 'signup');
      throw new Error('código de instalação inválido (veja nos logs do servidor)');
    }
    if (this.hasUsers()) {
      // depois da primeira conta, só com convite
      const inv = this.db.invites[sha(String(invite || '').trim().toUpperCase())];
      if (!inv || inv.exp < Date.now()) {
        this.fail(ip, 'signup');
        throw new Error('convite inválido ou vencido');
      }
      delete this.db.invites[sha(String(invite).trim().toUpperCase())];
    }
    const user = { id: 'u' + token(6), email, name, ...hashPassword(password), offices: [officeId], createdAt: Date.now() };
    this.db.users.push(user);
    this.save();
    return user;
  }

  findUser(id) {
    return this.db.users.find((u) => u.id === id) || null;
  }

  changePassword(userId, current, next) {
    const user = this.findUser(userId);
    if (!user || !checkPassword(current, user)) throw new Error('senha atual incorreta');
    if (String(next || '').length < 8) throw new Error('a nova senha precisa de pelo menos 8 caracteres');
    Object.assign(user, hashPassword(next));
    // derruba as outras sessões
    for (const [h, s] of Object.entries(this.db.sessions)) if (s.userId === userId) delete this.db.sessions[h];
    this.save();
  }

  // ---------- Freio contra tentativas repetidas (senha, convite, código de PC) ----------
  // 8 erros do mesmo IP no mesmo tipo de tentativa bloqueiam por 15 minutos.
  guard(ip, kind) {
    const f = this.failures.get(kind + ip);
    if (f && f.n >= 8 && f.until > Date.now()) throw new Error('muitas tentativas; espere alguns minutos');
  }

  fail(ip, kind) {
    const f = this.failures.get(kind + ip);
    const n = (f && f.until > Date.now() ? f.n : 0) + 1;
    this.failures.set(kind + ip, { n, until: Date.now() + 15 * 60 * 1000 });
  }

  // ---------- Login ----------
  login(email, password, ip) {
    this.guard(ip, 'login');
    const user = this.db.users.find((u) => u.email === String(email || '').trim().toLowerCase());
    // sem usuário, calcula um hash mesmo assim: o tempo de resposta não revela quais e-mails existem
    const ok = user ? checkPassword(password, user) : (hashPassword(password), false);
    if (!ok) {
      this.fail(ip, 'login');
      throw new Error('e-mail ou senha incorretos');
    }
    this.failures.delete('login' + ip);
    return this.startSession(user.id);
  }

  startSession(userId) {
    const t = token();
    this.db.sessions[sha(t)] = { userId, exp: Date.now() + SESSION_DAYS * 86400000 };
    this.prune();
    this.save();
    return t;
  }

  userForSession(t) {
    const s = t && this.db.sessions[sha(t)];
    if (!s || s.exp < Date.now()) return null;
    return this.findUser(s.userId);
  }

  logout(t) {
    if (t) delete this.db.sessions[sha(t)];
    this.save();
  }

  prune() {
    const now = Date.now();
    for (const [h, s] of Object.entries(this.db.sessions)) if (s.exp < now) delete this.db.sessions[h];
    for (const [h, i] of Object.entries(this.db.invites)) if (i.exp < now) delete this.db.invites[h];
  }

  createInvite(userId) {
    const code = shortCode();
    this.db.invites[sha(code)] = { by: userId, exp: Date.now() + INVITE_DAYS * 86400000 };
    this.save();
    return { code, exp: this.db.invites[sha(code)].exp };
  }

  // ---------- Conectores ----------
  createPairing(officeId) {
    const code = shortCode();
    this.pairings.set(code, { officeId, exp: Date.now() + PAIR_MINUTES * 60000 });
    return { code, exp: Date.now() + PAIR_MINUTES * 60000 };
  }

  // O conector troca o código (uso único) por um token permanente para aquele PC.
  pair(code, envId, name, ip) {
    this.guard(ip, 'pair');
    const p = this.pairings.get(String(code || '').trim().toUpperCase());
    if (!p || p.exp < Date.now()) {
      this.fail(ip, 'pair');
      throw new Error('código inválido ou vencido; gere outro no hub');
    }
    if (!/^[\w-]{3,40}$/.test(String(envId || ''))) throw new Error('identidade do PC inválida');
    this.pairings.delete(String(code).trim().toUpperCase());
    return this.issueConnector(p.officeId, envId, name);
  }

  issueConnector(officeId, envId, name) {
    // um token por PC por escritório: parear de novo substitui o anterior
    for (const [h, c] of Object.entries(this.db.connectors)) {
      if (c.officeId === officeId && c.envId === envId) delete this.db.connectors[h];
    }
    const t = token();
    this.db.connectors[sha(t)] = { id: token(6), officeId, envId, name: String(name || 'PC').slice(0, 40), createdAt: Date.now(), lastSeen: null };
    this.save();
    return t;
  }

  connectorFor(t) {
    return (t && this.db.connectors[sha(t)]) || null;
  }

  touchConnector(t) {
    const c = this.connectorFor(t);
    if (c) c.lastSeen = Date.now(); // gravado junto com a próxima alteração
  }

  listConnectors(officeId) {
    return Object.values(this.db.connectors).filter((c) => c.officeId === officeId)
      .map(({ id, envId, name, createdAt, lastSeen }) => ({ id, envId, name, createdAt, lastSeen }));
  }

  revokeConnector(officeId, id) {
    const entry = Object.entries(this.db.connectors).find(([, c]) => c.officeId === officeId && c.id === id);
    if (!entry) throw new Error('PC não encontrado');
    delete this.db.connectors[entry[0]];
    this.save();
    return entry[1];
  }
}

module.exports = { Auth, sha, token, shortCode };

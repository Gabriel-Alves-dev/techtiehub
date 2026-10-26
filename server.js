// Techtie Hub — o escritório central.
// Contas com login; cada conta tem o seu escritório (office.js): salas, mesas, agentes,
// conversas, memória e sessões dos agentes. O hub serve a interface (public/) e a API,
// mas NÃO roda o Claude nem mexe em pastas: isso é trabalho dos conectores
// (conector.js), um em cada PC, pareados com a conta. Por padrão o hub sobe com um
// conector embutido para este PC (modo local).
const http = require('http');
const fs = require('fs');
const path = require('path');
const git = require('./git');
const { Auth, token } = require('./auth');
const { Office, HttpError, STATUSES, FLOORS, AREAS } = require('./office');
const conector = require('./conector');

const PORT = process.env.PORT || 4321;
const HOST = process.env.HUB_HOST || '127.0.0.1'; // na VPS: atrás de um proxy HTTPS (ver docs)
const EMBEDDED = process.env.HUB_SEM_CONECTOR !== '1'; // conector deste PC dentro do hub
const PUBLIC_URL = process.env.HUB_PUBLIC_URL || null; // ex.: https://hub.seudominio.com
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.dirname(process.env.HUB_DATA || path.join(__dirname, 'data', 'state.json'));
const COOKIE = 'hub_sessao';

const auth = new Auth(DATA_DIR);
const LOCAL_ENV = EMBEDDED ? conector.loadEnv() : null;

// ---------- Escritórios ----------
const offices = new Map();
function getOffice(id) {
  if (!offices.has(id)) offices.set(id, new Office(id, path.join(DATA_DIR, 'offices', id), { legacyEnvId: LOCAL_ENV?.id }));
  return offices.get(id);
}

// Cria o escritório de uma conta nova. A primeira conta herda os dados de antes das
// contas existirem (data/state.json, data/chats, data/sessions).
function createOfficeDir() {
  const id = 'o' + token(6);
  const dir = path.join(DATA_DIR, 'offices', id);
  fs.mkdirSync(dir, { recursive: true });
  if (!auth.hasUsers()) {
    for (const name of ['state.json', 'chats', 'sessions']) {
      const from = path.join(DATA_DIR, name);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, name));
    }
    fs.rmSync(path.join(DATA_DIR, 'hub.json'), { force: true }); // chave antiga dos conectores
  }
  return id;
}

// ---------- Utilidades HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 200e6) req.destroy(); // importação e sessões podem ser grandes
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';')
  .map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const isHttps = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || PUBLIC_URL?.startsWith('https');
const publicUrl = (req) => PUBLIC_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer /, '') || null;
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();

function setSession(req, res, value) {
  const parts = [`${COOKIE}=${value ? encodeURIComponent(value) : ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${value ? 30 * 86400 : 0}`];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ---------- Conector embutido (modo local) ----------
let embeddedStarted = false;
function startEmbedded(officeId) {
  if (!EMBEDDED || embeddedStarted) return;
  embeddedStarted = true;
  const hub = `http://127.0.0.1:${PORT}`;
  const hubFile = path.join(DATA_DIR, 'hub.json');
  let saved = conector.readJson(hubFile);
  const valid = saved?.embeddedToken && auth.connectorFor(saved.embeddedToken)?.officeId === officeId;
  if (!valid) {
    saved = { embeddedToken: auth.issueConnector(officeId, LOCAL_ENV.id, LOCAL_ENV.name) };
    conector.writeJson(hubFile, saved);
  }
  // o hub-hook.js deste PC usa a mesma configuração (só sobrescreve se apontar para este hub)
  const cfg = conector.readJson(conector.CONFIG_FILE);
  if (!cfg || /^http:\/\/(127\.0\.0\.1|localhost):/.test(cfg.hub || '')) {
    conector.writeJson(conector.CONFIG_FILE, { hub, token: saved.embeddedToken });
  }
  conector.start({ hub, token: saved.embeddedToken, log: (...a) => console.log('[conector]', ...a) });
}

// ---------- Contas ----------
async function authApi(req, res, action, body) {
  const session = cookies(req)[COOKIE];
  const user = auth.userForSession(session);

  if (action === 'status') return send(res, 200, { setup: !auth.hasUsers(), user: auth.publicUser(user) });

  if (action === 'signup' && req.method === 'POST') {
    const first = !auth.hasUsers();
    const officeId = createOfficeDir();
    let created;
    try {
      created = auth.createUser({ ...body, officeId });
    } catch (e) {
      fs.rmSync(path.join(DATA_DIR, 'offices', officeId), { recursive: true, force: true });
      return send(res, 400, { error: e.message });
    }
    setSession(req, res, auth.startSession(created.id));
    if (first) startEmbedded(officeId); // o dono deste computador
    return send(res, 201, { user: auth.publicUser(created) });
  }

  if (action === 'login' && req.method === 'POST') {
    try {
      setSession(req, res, auth.login(body.email, body.password, clientIp(req)));
    } catch (e) {
      return send(res, 401, { error: e.message });
    }
    return send(res, 200, { ok: true });
  }

  if (action === 'logout' && req.method === 'POST') {
    auth.logout(session);
    setSession(req, res, null);
    return send(res, 200, { ok: true });
  }

  if (!user) return send(res, 401, { error: 'faça login' });

  if (action === 'password' && req.method === 'POST') {
    try {
      auth.changePassword(user.id, body.current, body.next);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    setSession(req, res, auth.startSession(user.id)); // as outras sessões caíram; esta continua
    return send(res, 200, { ok: true });
  }

  if (action === 'invite' && req.method === 'POST') return send(res, 201, auth.createInvite(user.id));

  send(res, 404, { error: 'rota desconhecida' });
}

// ---------- Rotas dos conectores (autenticadas pelo token do PC) ----------
async function connectorApi(req, res, url, op, sub) {
  if (op === 'pair' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      return send(res, 200, { token: auth.pair(body.code, req.headers['x-hub-env'], body.name) });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  const c = auth.connectorFor(bearer(req));
  const envId = req.headers['x-hub-env'];
  if (!c || c.envId !== envId) return send(res, 401, { error: 'este PC não está pareado com o hub (ou foi removido)' });
  const o = getOffice(c.officeId);

  if (op === 'stream' && req.method === 'GET') {
    const name = String(url.searchParams.get('name') || 'PC').slice(0, 40);
    auth.touchConnector(bearer(req));
    o.state.environments[envId] = { name, lastSeen: Date.now() };
    o.connectors.attach(envId, name, req, res);
    o.save();
    o.backfillRepos(envId);
    return;
  }

  const body = await readBody(req);
  if (op === 'reply') {
    o.connectors.reply(body);
    return send(res, 200, { ok: true });
  }

  if (op === 'event') {
    const { type, projectId } = body;
    if (!o.state.projects.some((p) => p.id === projectId)) return send(res, 200, { ignored: true });
    if (type === 'chat-push') o.chats.push(projectId, body.role, body.text);
    else if (type === 'chat-update') o.chats.update(projectId, body.fields || {});
    else if (type === 'status') o.setStatus(projectId, body.status, body.message, body.log);
    else if (type === 'live') {
      if (body.live) o.live[projectId] = { ...body.live, envId };
      else delete o.live[projectId];
      o.broadcast(null, o.snapshot());
    }
    return send(res, 200, { ok: true });
  }

  if (op === 'sessions') {
    // sessões do Claude espelhadas no hub (ver remote-store.js / session-store.js)
    if (sub === 'append') await o.sessions.append(body.key, body.entries || []);
    else if (sub === 'load') return send(res, 200, await o.sessions.load(body.key));
    else if (sub === 'subkeys') return send(res, 200, await o.sessions.listSubkeys(body.key));
    else if (sub === 'delete') await o.sessions.delete(body.key);
    else if (sub === 'has') return send(res, 200, o.sessions.has(body.sessionId));
    else return send(res, 404, { error: 'operação desconhecida' });
    return send(res, 200, null);
  }

  send(res, 404, { error: 'rota desconhecida' });
}

// ---------- Rotas do navegador (escritório da conta logada) ----------
const newId = (prefix) => prefix + token(6);

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

const FIELDS = {
  projects: ['name', 'description', 'color', 'agentId', 'roomId'], // pasta: tratada à parte (uma por PC)
  agents: ['name', 'role', 'shirt', 'hair', 'skin', 'status', 'message'],
  rooms: ['name', 'cols', 'floor', 'areas'],
};

// Aceita id ou nome (sem diferenciar maiúsculas), para facilitar o uso por scripts.
function find(list, key) {
  if (!key) return null;
  const k = String(key).toLowerCase();
  return list.find((x) => x.id === key || x.name.toLowerCase() === k) || null;
}

// Uma mesa tem no máximo um agente: ao atribuir, libera a mesa anterior do agente.
function assign(o, project, agentId) {
  if (agentId) for (const p of o.state.projects) if (p.agentId === agentId && p !== project) p.agentId = null;
  project.agentId = agentId || null;
}

function report(o, body, res) {
  const agent = find(o.state.agents, body.agent);
  if (!agent) return send(res, 404, { error: `agente "${body.agent}" não encontrado` });
  if (body.status && !STATUSES.includes(body.status)) return send(res, 400, { error: `status inválido; use: ${STATUSES.join(', ')}` });
  if (body.project) {
    const project = find(o.state.projects, body.project);
    if (!project) return send(res, 404, { error: `projeto "${body.project}" não encontrado` });
    assign(o, project, agent.id);
  }
  if (body.status) agent.status = body.status;
  if (body.message !== undefined) agent.message = String(body.message).slice(0, 200);
  const desk = o.state.projects.find((p) => p.agentId === agent.id);
  o.addLog(agent.id, desk?.id ?? null, `[${agent.status}] ${agent.message || ''}`.trim());
  o.save();
  return send(res, 200, agent);
}

async function officeApi(req, res, url, o, user) {
  const [, , resource, id, action] = url.pathname.split('/');
  const method = req.method;
  const { state, live, chats, sessions, connectors } = o;

  if (resource === 'state' && method === 'GET') return send(res, 200, o.snapshot());
  if (resource === 'events' && method === 'GET') return o.attachBrowser(req, res);

  if (resource === 'export' && method === 'GET') {
    const bundle = { app: 'techtie-hub', version: 2, exportedAt: new Date().toISOString(), state, chats: chats.exportAll(), sessions: sessions.exportAll() };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="techtie-hub-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    return res.end(JSON.stringify(bundle));
  }

  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);

  // ---------- PCs da conta ----------
  if (resource === 'pairing' && method === 'POST') return send(res, 201, { ...auth.createPairing(o.id), hub: publicUrl(req) });
  if (resource === 'connectors' && method === 'GET') return send(res, 200, auth.listConnectors(o.id));
  if (resource === 'connectors' && method === 'DELETE') {
    const removed = auth.revokeConnector(o.id, id);
    connectors.byEnv.get(removed.envId)?.res.end(); // derruba a conexão; o conector não volta sem parear de novo
    return send(res, 204, {});
  }

  if (resource === 'pick-folder' && method === 'POST') {
    return send(res, 200, await connectors.rpc(o.needEnv(req), 'pick-folder', {}, 10 * 60 * 1000));
  }

  if (resource === 'environment' && method === 'PATCH') {
    const envId = o.needEnv(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return send(res, 400, { error: 'nome vazio' });
    await connectors.rpc(envId, 'rename', { name });
    connectors.rename(envId, name);
    state.environments[envId] = { name, lastSeen: Date.now() };
    o.save();
    return send(res, 200, { ok: true });
  }

  if (resource === 'import' && method === 'POST') {
    if (body.app !== 'techtie-hub' || !body.state?.projects) return send(res, 400, { error: 'arquivo não é uma exportação do Techtie Hub' });
    if (Object.keys(live).length) return send(res, 409, { error: 'pare os agentes antes de importar' });
    // pastas e PCs já configurados aqui continuam valendo
    const known = Object.fromEntries(state.projects.map((p) => [p.id, p.folders]));
    const envs = state.environments;
    chats.importAll(body.chats);
    sessions.importAll(body.sessions);
    fs.writeFileSync(o.file, JSON.stringify(body.state));
    o.state = o.load();
    o.state.environments = { ...envs, ...o.state.environments };
    for (const p of o.state.projects) p.folders = { ...known[p.id], ...p.folders };
    o.addLog(null, null, 'Escritório importado de um backup');
    o.save();
    return send(res, 200, { ok: true });
  }

  // ---------- Mesa: conversa, memória, git, pasta ----------
  if (resource === 'projects' && ['chat', 'answer', 'stop', 'reset', 'memory', 'git', 'open'].includes(action)) {
    const project = state.projects.find((p) => p.id === id);
    if (!project) return send(res, 404, { error: 'não encontrado' });
    const chat = chats.get(id);
    const brief = (folder) => ({ id, name: project.name, description: project.description, folder });

    if (action === 'chat' && method === 'GET') return send(res, 200, chat);
    if (action === 'memory' && method === 'GET') {
      return send(res, 200, { memory: chat.memory || '', memoryAt: chat.memoryAt || null, lastCommit: chat.lastCommit || null });
    }
    if (action === 'memory' && method === 'PUT') {
      chats.setMemory(id, body.memory);
      return send(res, 200, { ok: true });
    }
    if (action === 'git' && method === 'GET') {
      const envId = o.envFor(req);
      if (!envId || !project.folders[envId]) return send(res, 200, { git: false });
      return send(res, 200, await connectors.rpc(envId, 'git', { folder: project.folders[envId], last: chat.lastCommit }));
    }
    if (method !== 'POST') return send(res, 405, { error: 'método não permitido' });

    // pedidos em andamento vão para o PC onde estão rodando, venha de onde vier a resposta
    if (action === 'answer' || action === 'stop') {
      if (!live[id]) return send(res, 409, { error: 'nada rodando nesta mesa' });
      return send(res, 200, await connectors.rpc(live[id].envId, action, { projectId: id, ...body }));
    }

    const envId = o.needEnv(req);
    if (action === 'open') return send(res, 200, await connectors.rpc(envId, 'open', { folder: project.folders[envId], app: body.app }));

    if (action === 'chat') {
      if (live[id]) return send(res, 409, { error: 'o agente ainda está trabalhando nesta mesa' });
      const folder = project.folders[envId];
      if (!folder) return send(res, 400, { error: `defina a pasta desta mesa no PC "${o.envName(envId)}" em ⚙ Mesa` });
      const text = String(body.message || '').trim();
      if (!text) return send(res, 400, { error: 'mensagem vazia' });
      live[id] = { running: true, pending: null, envId }; // reserva a mesa até o conector confirmar
      try {
        await connectors.rpc(envId, 'run', { project: brief(folder), text, chat });
      } catch (e) {
        delete live[id];
        o.broadcast(null, o.snapshot());
        throw e;
      }
      return send(res, 200, { ok: true });
    }

    if (live[id]) return send(res, 409, { error: 'espere o agente terminar' });
    // memória e nova conversa: o resumo é feito pelo Claude do PC escolhido
    const refresh = async () => {
      const m = await connectors.rpc(envId, 'memory', { project: brief(project.folders[envId]), chat }, 5 * 60 * 1000);
      chats.update(id, m);
      return m.memory;
    };
    if (action === 'memory') return send(res, 200, { memory: await refresh() });
    // reset: guarda o que importa na memória e começa uma sessão limpa
    await refresh().catch(() => {});
    const oldSession = chats.reset(id);
    if (oldSession) await sessions.delete({ sessionId: oldSession });
    return send(res, 200, { ok: true });
  }

  if (FIELDS[resource]) {
    const list = state[resource];
    const fields = FIELDS[resource];

    // A pasta vale só para o PC escolhido: o conector confere se existe e qual o repositório.
    let folderEnv = null, folderRemote = null;
    if (resource === 'projects' && typeof body.folder === 'string') {
      folderEnv = o.needEnv(req);
      if (body.folder.trim()) {
        const info = await connectors.rpc(folderEnv, 'folder-info', { folder: body.folder });
        if (!info.exists) return send(res, 400, { error: `a pasta "${info.folder || body.folder}" não existe no PC "${o.envName(folderEnv)}"` });
        body.folder = info.folder;
        folderRemote = info.remote;
        const current = id && list.find((x) => x.id === id);
        if (current?.repo && folderRemote && !git.sameRepo(current.repo, folderRemote) && !body.forceFolder) {
          return send(res, 409, {
            code: 'repo_mismatch',
            error: `Essa pasta é de outro repositório (${folderRemote}). A mesa "${current.name}" trabalha em ${current.repo}.`,
          });
        }
      } else body.folder = null;
    }
    const applyFolder = (item) => {
      if (!folderEnv) return;
      item.folders ??= {};
      if (body.folder) item.folders[folderEnv] = body.folder;
      else delete item.folders[folderEnv];
      if (folderRemote && (!item.repo || body.forceFolder)) item.repo = folderRemote;
    };
    if (body.roomId !== undefined && !state.rooms.some((r) => r.id === body.roomId)) {
      return send(res, 400, { error: 'sala não encontrada' });
    }
    if (body.cols !== undefined) body.cols = Math.max(2, Math.min(8, parseInt(body.cols, 10) || 4));
    if (body.floor !== undefined && !FLOORS.includes(body.floor)) body.floor = 'madeira';
    if (body.areas !== undefined) {
      // sempre sobra ao menos uma área, para os agentes ociosos terem para onde ir
      body.areas = AREAS.filter((a) => [].concat(body.areas).includes(a));
      if (!body.areas.length) body.areas = ['copa'];
    }

    if (method === 'POST' && !id) {
      if (!body.name) return send(res, 400, { error: 'nome é obrigatório' });
      const item = { id: newId(resource[0]), ...pick(body, fields) };
      if (resource === 'agents') item.status ??= 'ocioso';
      if (resource === 'rooms') {
        item.cols ??= 4;
        item.floor ??= 'carpete';
        item.areas ??= [...AREAS];
      }
      if (resource === 'projects') {
        item.roomId ??= state.rooms[0].id;
        item.agentId = null;
        item.folders = {};
        applyFolder(item);
        list.push(item);
        assign(o, item, body.agentId);
      } else {
        list.push(item);
      }
      const what = { agents: `${item.name} foi contratado(a)`, projects: `Nova mesa: ${item.name}`, rooms: `Nova sala: ${item.name}` };
      o.addLog(resource === 'agents' ? item.id : null, resource === 'projects' ? item.id : null, what[resource]);
      o.save();
      return send(res, 201, item);
    }

    const item = list.find((x) => x.id === id);
    if (!item) return send(res, 404, { error: 'não encontrado' });

    if (method === 'PATCH') {
      const changes = pick(body, fields);
      if (changes.status && !STATUSES.includes(changes.status)) return send(res, 400, { error: 'status inválido' });
      if (resource === 'projects' && 'agentId' in changes) {
        assign(o, item, changes.agentId);
        delete changes.agentId;
      }
      Object.assign(item, changes);
      applyFolder(item);
      o.save();
      return send(res, 200, item);
    }

    if (method === 'DELETE') {
      if (resource === 'rooms') {
        if (state.rooms.length === 1) return send(res, 400, { error: 'o escritório precisa de pelo menos uma sala' });
        // as mesas da sala removida vão para a primeira sala que sobrar
        const target = state.rooms.find((r) => r !== item);
        for (const p of state.projects) if (p.roomId === item.id) p.roomId = target.id;
      }
      if (resource === 'projects' && live[item.id]) connectors.rpc(live[item.id].envId, 'stop', { projectId: item.id }).catch(() => {});
      state[resource] = list.filter((x) => x !== item);
      if (resource === 'agents') for (const p of state.projects) if (p.agentId === item.id) p.agentId = null;
      o.save();
      return send(res, 204, {});
    }
  }

  send(res, 404, { error: 'rota desconhecida' });
}

async function api(req, res, url) {
  const [, , resource, id, action] = url.pathname.split('/');

  if (resource === 'connector') return connectorApi(req, res, url, id, action);

  // Só aceita JSON: impede que um site qualquer dispare a API com um <form>.
  if (req.method !== 'GET' && req.method !== 'DELETE' && !String(req.headers['content-type']).startsWith('application/json')) {
    return send(res, 415, { error: 'use Content-Type: application/json' });
  }

  if (resource === 'auth') return authApi(req, res, id, req.method === 'POST' ? await readBody(req) : {});

  // hooks e report.js se identificam pelo token do conector do PC
  if (resource === 'hook' || resource === 'report') {
    const c = auth.connectorFor(bearer(req));
    const user = auth.userForSession(cookies(req)[COOKIE]);
    if (!c && !(resource === 'report' && user)) return send(res, 401, { error: 'não autorizado' });
    const o = getOffice(c ? c.officeId : user.offices[0]);
    const body = await readBody(req);
    return resource === 'hook' ? send(res, 200, o.handleHook(body, c.envId)) : report(o, body, res);
  }

  const user = auth.userForSession(cookies(req)[COOKIE]);
  if (!user) return send(res, 401, { error: 'faça login' });
  return officeApi(req, res, url, getOffice(user.offices[0]), user);
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveStatic(res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'proibido' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'não encontrado' });
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else serveStatic(res, url);
    } catch (e) {
      if (!res.headersSent) send(res, e instanceof HttpError ? e.code : 400, { error: e.message, ...e.extra });
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`Techtie Hub rodando em http://localhost:${PORT}`);
    if (!auth.hasUsers()) console.log('Abra o endereço acima e crie a sua conta.');
    // modo local: o conector deste PC pertence ao dono (primeira conta)
    else startEmbedded(auth.db.users[0].offices[0]);
  });

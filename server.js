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
const { Auth, token, shortCode } = require('./auth');
const { Office, HttpError, STATUSES, FLOORS, AREAS } = require('./office');
const conector = require('./conector');
const { createZip } = require('./zip');
const { Secrets, isMask, mask } = require('./secrets');

// ---------- Pacote do conector (baixado pelo navegador) ----------
// Os arquivos que rodam no PC + o atalho de Windows (pacote/) + a configuração com o
// endereço do hub e um código de pareamento. Arquivos de Windows vão com CRLF.
const { FILES: PACKAGE_FILES, versionOf } = require('./connector-files');
// versão do conector que este hub entrega; conectores diferentes se atualizam sozinhos
const CONNECTOR_VERSION = versionOf(__dirname);
const PACKAGE_EXTRAS = ['Iniciar Techtie.bat', 'baixar-node.ps1', 'LEIA-ME.txt'];

// package.json do conector: só o SDK do Claude
function packageJsonFor() {
  const sdk = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).dependencies['@anthropic-ai/claude-agent-sdk'];
  const zod = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).dependencies.zod;
  return JSON.stringify({ name: 'techtie-conector', private: true, dependencies: { '@anthropic-ai/claude-agent-sdk': sdk, ...(zod && { zod }) } }, null, 2);
}

function connectorPackage(hub, code) {
  const root = 'Techtie Conector/';
  const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
  return createZip([
    ...PACKAGE_FILES.map((f) => ({ name: root + f, data: fs.readFileSync(path.join(__dirname, f)) })),
    ...PACKAGE_EXTRAS.map((f) => ({ name: root + f, data: crlf(fs.readFileSync(path.join(__dirname, 'pacote', f), 'utf8')) })),
    { name: root + 'package.json', data: packageJsonFor() },
    { name: root + 'conector-config.json', data: JSON.stringify({ hub, code }, null, 2) },
  ]);
}

const PORT = process.env.PORT || 4321;
const HOST = process.env.HUB_HOST || '127.0.0.1'; // na VPS: atrás de um proxy HTTPS (ver docs)
const EMBEDDED = process.env.HUB_SEM_CONECTOR !== '1'; // conector deste PC dentro do hub
const PUBLIC_URL = process.env.HUB_PUBLIC_URL || null; // ex.: https://hub.seudominio.com
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.dirname(process.env.HUB_DATA || path.join(__dirname, 'data', 'state.json'));
const COOKIE = 'hub_sessao';

const EXPOSED = !['127.0.0.1', 'localhost', '::1'].includes(HOST); // acessível de fora desta máquina
const TRUST_PROXY = process.env.HUB_TRUST_PROXY === '1'; // atrás de proxy (Coolify/Traefik): IP real vem no X-Forwarded-For

// Exposto na rede, a PRIMEIRA conta exige um código de instalação (HUB_SETUP_CODE ou um
// gerado e mostrado nos logs) — senão quem achasse o endereço antes poderia tomar o hub.
const secrets = new Secrets(DATA_DIR);
const auth = new Auth(DATA_DIR, { setupCode: process.env.HUB_SETUP_CODE || (EXPOSED ? shortCode() : null) });
const LOCAL_ENV = EMBEDDED ? conector.loadEnv() : null;

// ---------- Escritórios ----------
const offices = new Map();
function getOffice(id) {
  if (!offices.has(id)) {
    const o = new Office(id, path.join(DATA_DIR, 'offices', id), { legacyEnvId: LOCAL_ENV?.id, connectorVersion: CONNECTOR_VERSION, secrets });
    o.onIdle = (projectId) => processQueue(o, projectId); // mesa livre: próxima demanda da fila
    offices.set(id, o);
  }
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
// limit: rotas sem login aceitam pouco; com login, importação e sessões podem ser grandes
function readBody(req, limit = 200e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) {
        reject(new Error('requisição grande demais'));
        req.destroy();
      }
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
const clientIp = (req) => String((TRUST_PROXY && req.headers['x-forwarded-for']) || req.socket.remoteAddress).split(',')[0].trim();

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
  conector.start({ hub, token: saved.embeddedToken, embedded: true, log: (...a) => console.log('[conector]', ...a) });
}

// ---------- Contas ----------
async function authApi(req, res, action, body) {
  const session = cookies(req)[COOKIE];
  const user = auth.userForSession(session);

  if (action === 'status') {
    return send(res, 200, { setup: !auth.hasUsers(), setupCode: !auth.hasUsers() && !!auth.setupCode, user: auth.publicUser(user) });
  }

  if (action === 'signup' && req.method === 'POST') {
    const first = !auth.hasUsers();
    const officeId = createOfficeDir();
    let created;
    try {
      created = auth.createUser({ ...body, officeId }, clientIp(req));
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
    const body = await readBody(req, 10e3);
    try {
      return send(res, 200, { token: auth.pair(body.code, req.headers['x-hub-env'], body.name, clientIp(req)) });
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
    const version = String(url.searchParams.get('v') || '').slice(0, 20) || null; // conectores antigos não mandam
    auth.touchConnector(bearer(req));
    o.state.environments[envId] = { name, lastSeen: Date.now() };
    o.connectors.attach(envId, name, req, res, version);
    // demandas que esperavam um PC com a pasta (depois do live-sync, para não atropelar)
    setTimeout(() => Object.keys(o.state.queue).forEach((pid) => processQueue(o, pid)), 3000);
    // desatualizado: avisa para ele se atualizar (conectores antigos ignoram — precisam baixar de novo)
    if (version !== CONNECTOR_VERSION) res.write(`event: update\ndata: ${JSON.stringify({ version: CONNECTOR_VERSION })}\n\n`);
    o.onReconnect(envId);
    o.save();
    o.backfillRepos(envId);
    return;
  }

  // ferramentas da secretária: só para uma mesa marcada como secretária neste escritório
  if (op === 'office') {
    const body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
    const sec = o.state.projects.find((p) => p.id === body.secretaria && p.role === 'secretaria');
    if (!sec) return send(res, 403, { error: 'só a mesa da secretária usa estas ferramentas' });
    if (sub === 'desks') return send(res, 200, o.roster().filter((d) => !d.secretaria));
    if (sub === 'desk') {
      const found = o.findDesk(body.q);
      if (found.error) return send(res, 404, { error: found.error });
      const p = found.project;
      const chat = o.chats.get(p.id);
      return send(res, 200, {
        ...o.roster().find((d) => d.id === p.id),
        memoria: chat.memory || '(vazia)',
        memoriaNoEscritorio: o.state.officeMemory.projects[p.id]?.text || null,
        ultimasMensagens: chat.entries.slice(-12).map((e) => `${e.role}: ${String(e.text).slice(0, 400)}`),
      });
    }
    if (sub === 'delegate' && req.method === 'POST') {
      const found = o.findDesk(body.mesa);
      if (found.error) return send(res, 404, { error: found.error });
      const pedido = String(body.pedido || '').trim();
      if (!pedido) return send(res, 400, { error: 'o pedido está vazio' });
      const r = await delegate(o, found.project, pedido, { from: 'secretária', preferredEnv: envId });
      return send(res, 200, { mesa: found.project.name, agente: o.agentOf(found.project.id)?.name || null, ...r });
    }
    if (sub === 'reports') return send(res, 200, o.state.reports[body.dia || o.day()] || {});
    if (sub === 'note' && req.method === 'POST') {
      const nota = String(body.nota || '').trim();
      if (!nota) return send(res, 400, { error: 'nota vazia' });
      const mem = o.state.officeMemory;
      mem.general = `${(mem.general || '').trim()}\n- (${o.day()}) ${nota}`.trim();
      o.save();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'ferramenta desconhecida' });
  }

  // arquivos novos para o conector se atualizar
  if (op === 'update' && req.method === 'GET') {
    const files = Object.fromEntries(PACKAGE_FILES.map((f) => [f, fs.readFileSync(path.join(__dirname, f), 'utf8')]));
    return send(res, 200, { version: CONNECTOR_VERSION, files, packageJson: packageJsonFor() });
  }

  const body = await readBody(req);
  if (op === 'reply') {
    o.connectors.reply(body);
    return send(res, 200, { ok: true });
  }

  if (op === 'event') {
    const { type, projectId } = body;
    if (type === 'live-sync') {
      o.syncLive(envId, body.lives || {});
      return send(res, 200, { ok: true });
    }
    if (!o.state.projects.some((p) => p.id === projectId)) return send(res, 200, { ignored: true });
    if (type === 'chat-push') o.chats.push(projectId, body.role, body.text, [].concat(body.images || []).filter((n) => o.hasUpload(n)));
    else if (type === 'chat-update') o.chats.update(projectId, body.fields || {});
    else if (type === 'status') o.setStatus(projectId, body.status, body.message, body.log);
    else if (type === 'live') {
      o.setLive(projectId, body.live, envId);
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

// imagens aceitas nos pedidos (as mesmas da API do Claude) → extensão do arquivo guardado
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const MAX_IMAGES = 6;
// '' = perguntar; acceptEdits = edita sem pedir; auto = o Claude decide; bypassPermissions = nunca pede
const PERMISSION_MODES = ['', 'acceptEdits', 'auto', 'bypassPermissions'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

const FIELDS = {
  projects: ['name', 'description', 'color', 'agentId', 'roomId', 'permissionMode', 'role'], // pasta: tratada à parte (uma por PC)
  agents: ['name', 'role', 'shirt', 'hair', 'skin', 'status', 'message', 'model', 'effort'],
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

// ---------- Começar um pedido numa mesa (chat, delegação da secretária, fila) ----------
const SECRETARY_FOLDER = '@secretaria'; // a secretária não precisa de pasta: o conector usa uma dele

const folderFor = (project, envId) => project.folders?.[envId] || (project.role === 'secretaria' ? SECRETARY_FOLDER : null);

// O que o conector precisa saber da mesa para rodar o pedido.
function briefFor(o, project, folder) {
  const agent = o.agentOf(project.id);
  return {
    id: project.id, name: project.name, description: project.description, folder,
    model: agent?.model || '', effort: agent?.effort || '', permissionMode: project.permissionMode || '',
    mcpServers: o.mcpFor(project.id), // servidores MCP do hub para esta mesa (segredos abertos, só para o conector)
    // a secretária recebe, a cada pedido, a visão atualizada do escritório
    secretary: project.role === 'secretaria' ? { context: o.secretaryContext() } : undefined,
  };
}

async function startRun(o, project, envId, text, { images = [], imageRefs = [] } = {}) {
  const folder = folderFor(project, envId);
  if (!folder) throw new HttpError(400, `defina a pasta desta mesa no PC "${o.envName(envId)}" em ⚙ Mesa`);
  o.live[project.id] = { running: true, pending: null, envId }; // reserva a mesa até o conector confirmar
  try {
    await o.connectors.rpc(envId, 'run', { project: briefFor(o, project, folder), text, chat: o.chats.get(project.id), images, imageRefs }, 60000);
  } catch (e) {
    delete o.live[project.id];
    o.broadcast(null, o.snapshot());
    throw e;
  }
}

// PC para uma demanda delegada: o da secretária, se a mesa tiver pasta lá; senão outro PC conectado com a pasta.
function envForDesk(o, project, preferred) {
  const online = Object.keys(o.connectors.online());
  if (preferred && online.includes(preferred) && folderFor(project, preferred)) return preferred;
  return online.find((e) => folderFor(project, e)) || null;
}

// Passa uma demanda para a mesa: começa agora ou entra na fila (e começa sozinha depois).
async function delegate(o, project, text, { from = 'secretária', preferredEnv } = {}) {
  const msg = `📨 Demanda da ${from}:\n\n${text}`;
  const envId = !o.live[project.id] && envForDesk(o, project, preferredEnv);
  if (envId) {
    try {
      await startRun(o, project, envId, msg);
      o.addLog(null, project.id, `Demanda da ${from} passada para ${project.name}`);
      o.save();
      return { iniciada: true, pc: o.envName(envId) };
    } catch {} // não conseguiu começar: vai para a fila
  }
  (o.state.queue[project.id] ??= []).push({ text: msg, from, at: Date.now(), preferredEnv });
  const busy = !!o.live[project.id];
  o.chats.push(project.id, 'system', `📨 Demanda da ${from} na fila: começa sozinha quando ${busy ? 'a tarefa atual terminar' : 'um PC com a pasta desta mesa conectar'}.`);
  o.addLog(null, project.id, `Demanda da ${from} na fila de ${project.name}`);
  o.save();
  return { naFila: true, posicao: o.state.queue[project.id].length, motivo: busy ? 'a mesa está trabalhando' : 'nenhum PC conectado tem a pasta desta mesa' };
}

async function processQueue(o, projectId) {
  const q = o.state.queue[projectId];
  const project = o.state.projects.find((p) => p.id === projectId);
  if (!q?.length || !project || o.live[projectId]) return;
  const next = q[0];
  const envId = envForDesk(o, project, next.preferredEnv);
  if (!envId) return;
  q.shift();
  if (!q.length) delete o.state.queue[projectId];
  try {
    await startRun(o, project, envId, next.text);
  } catch {
    (o.state.queue[projectId] ??= []).unshift(next);
  }
  o.save();
}

// ---------- Servidores MCP ----------
const mcpScans = new Map(); // resultados de "procurar neste PC" (com segredos) — nunca vão para o navegador

const MCP_TYPES = ['http', 'sse', 'stdio'];
const strMap = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {})
  .filter(([k]) => /^[\w.-]{1,80}$/.test(k)).map(([k, v]) => [k, String(v ?? '')]));

function mcpValidate(o, body, current) {
  const name = body.name ?? current?.name;
  if (!/^[\w-]{1,40}$/.test(String(name || ''))) throw new HttpError(400, 'nome do servidor: só letras, números, _ e - (até 40)');
  if (o.state.mcpServers.some((s) => s.name === name && s !== current)) throw new HttpError(400, `já existe um servidor "${name}"`);
  const type = body.type ?? current?.type;
  if (!MCP_TYPES.includes(type)) throw new HttpError(400, 'tipo inválido (http, sse ou stdio)');
  if (body.projects !== undefined && body.projects !== 'all' &&
    !(Array.isArray(body.projects) && body.projects.every((id) => o.state.projects.some((p) => p.id === id)))) {
    throw new HttpError(400, 'lista de mesas inválida');
  }
}

// segredos: valor mascarado ("••••") = manter o que já estava guardado
function mergeSecretMap(next, old = {}) {
  const out = {};
  for (const [k, v] of Object.entries(strMap(next))) out[k] = isMask(v) ? old[k] : secrets.encrypt(v);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

function mcpCreate(o, body) {
  mcpValidate(o, body, null);
  const s = {
    id: 'm' + token(6), name: body.name, type: body.type, enabled: body.enabled !== false,
    projects: body.projects || 'all', createdAt: Date.now(),
  };
  if (s.type === 'stdio') {
    if (!String(body.command || '').trim()) throw new HttpError(400, 'informe o comando do servidor');
    Object.assign(s, { command: String(body.command).trim(), args: [].concat(body.args || []).map(String), env: mergeSecretMap(body.env) });
  } else {
    if (!/^https?:\/\//i.test(String(body.url || ''))) throw new HttpError(400, 'informe a URL do servidor (http:// ou https://)');
    Object.assign(s, { url: secrets.encrypt(String(body.url).trim()), headers: mergeSecretMap(body.headers) });
  }
  o.state.mcpServers.push(s);
  return s;
}

async function mcpApi(req, res, o, id, action, method, body) {
  if (!id && method === 'GET') return send(res, 200, o.mcpPublic());
  if (!id && method === 'POST') {
    mcpCreate(o, body);
    o.save();
    return send(res, 201, { ok: true });
  }
  const s = o.state.mcpServers.find((x) => x.id === id);
  if (!s) return send(res, 404, { error: 'servidor não encontrado' });

  if (action === 'test' && method === 'POST') {
    // liga o servidor no PC escolhido e lista as ferramentas (sem gastar uso do plano)
    const result = await o.connectors.rpc(o.needEnv(req), 'mcp-test', { name: s.name, config: o.mcpConfig(s) }, 60000);
    s.lastTest = { status: result.status, error: result.error || null, tools: result.tools.length, at: Date.now() };
    o.save();
    return send(res, 200, result);
  }
  if (method === 'PATCH') {
    mcpValidate(o, body, s);
    if (body.name !== undefined) s.name = body.name;
    if (body.type !== undefined) s.type = body.type;
    if (body.enabled !== undefined) s.enabled = !!body.enabled;
    if (body.projects !== undefined) s.projects = body.projects;
    if (s.type === 'stdio') {
      if (body.command !== undefined) s.command = String(body.command).trim();
      if (body.args !== undefined) s.args = [].concat(body.args).map(String);
      if (body.env !== undefined) s.env = mergeSecretMap(body.env, s.env);
      delete s.url;
      delete s.headers;
    } else {
      if (body.url !== undefined && !isMask(body.url)) {
        if (!/^https?:\/\//i.test(String(body.url))) throw new HttpError(400, 'URL inválida');
        s.url = secrets.encrypt(String(body.url).trim());
      }
      if (body.headers !== undefined) s.headers = mergeSecretMap(body.headers, s.headers);
      delete s.command;
      delete s.args;
      delete s.env;
    }
    delete s.lastTest;
    o.save();
    return send(res, 200, { ok: true });
  }
  if (method === 'DELETE') {
    o.state.mcpServers = o.state.mcpServers.filter((x) => x !== s);
    o.save();
    return send(res, 204, {});
  }
  send(res, 405, { error: 'método não permitido' });
}

async function officeApi(req, res, url, o, user) {
  const [, , resource, id, action] = url.pathname.split('/');
  const method = req.method;
  const { state, live, chats, sessions, connectors } = o;

  if (resource === 'state' && method === 'GET') return send(res, 200, o.snapshot());

  // imagens da conversa (só do escritório da conta logada)
  if (resource === 'files' && method === 'GET') {
    const file = o.uploadPath(id);
    if (!file) return send(res, 404, { error: 'não encontrado' });
    const type = Object.entries(IMAGE_TYPES).find(([, ext]) => file.endsWith(ext))?.[0] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable' });
    return fs.createReadStream(file).pipe(res);
  }
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
  if (resource === 'connector-download' && method === 'GET') {
    // pacote pronto para Windows, já ligado a esta conta (código de 24 h, uso único)
    const { code } = auth.createPairing(o.id, 24 * 60);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="techtie-conector.zip"',
      'Cache-Control': 'no-store',
    });
    return res.end(connectorPackage(publicUrl(req), code));
  }
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
  if (resource === 'projects' && ['chat', 'answer', 'stop', 'reset', 'memory', 'git', 'open', 'share', 'report'].includes(action)) {
    const project = state.projects.find((p) => p.id === id);
    if (!project) return send(res, 404, { error: 'não encontrado' });
    const chat = chats.get(id);
    const agent = state.agents.find((a) => a.id === project.agentId);
    // modelo e esforço do agente da mesa (vazio = padrão do Claude Code do PC)
    const brief = (envId) => briefFor(o, project, folderFor(project, envId));

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
    if (action === 'answer') {
      if (!live[id]) return send(res, 409, { error: 'nada rodando nesta mesa' });
      return send(res, 200, await connectors.rpc(live[id].envId, 'answer', { projectId: id, ...body }));
    }
    // Parar sempre destrava a mesa: se o PC não responde ou já tinha terminado, limpa no hub
    if (action === 'stop') {
      if (!live[id]) return send(res, 200, { ok: true });
      const name = o.envName(live[id].envId);
      let r = null;
      try {
        r = await connectors.rpc(live[id].envId, 'stop', { projectId: id }, 15000);
      } catch {}
      if (!r) o.forceStop(id, `Parado. O PC "${name}" não respondia; a mesa foi liberada.`);
      // wasRunning !== true: já tinha terminado lá (ou conector antigo, que não informa) — se ainda
      // estivesse rodando, o próprio PC avisaria o fim logo depois de abortar
      else if (r.wasRunning !== true) o.forceStop(id, 'Parado. A tarefa já tinha terminado no PC; a mesa foi liberada.');
      return send(res, 200, { ok: true });
    }

    const envId = o.needEnv(req);
    if (action === 'open') return send(res, 200, await connectors.rpc(envId, 'open', { folder: project.folders[envId], app: body.app }));

    // 🏢 manda a memória desta mesa para a memória do escritório
    if (action === 'share') {
      if (!chat.memory?.trim()) return send(res, 400, { error: 'a memória desta mesa está vazia: atualize-a primeiro (🧠 Memória → Atualizar com a conversa)' });
      state.officeMemory.projects[id] = { text: chat.memory, at: Date.now(), agent: agent?.name || null };
      o.addLog(agent?.id || null, id, 'Memória enviada para o escritório');
      o.save();
      return send(res, 200, { ok: true });
    }

    if (action === 'chat') {
      if (live[id]) return send(res, 409, { error: 'o agente ainda está trabalhando nesta mesa' });
      if (!folderFor(project, envId)) return send(res, 400, { error: `defina a pasta desta mesa no PC "${o.envName(envId)}" em ⚙ Mesa` });
      // imagens coladas/anexadas: [{ mediaType, data (base64) }] — limites da API do Claude
      const images = [].concat(body.images || []);
      if (images.length > MAX_IMAGES) return send(res, 400, { error: `no máximo ${MAX_IMAGES} imagens por pedido` });
      for (const img of images) {
        if (!IMAGE_TYPES[img?.mediaType] || typeof img.data !== 'string') return send(res, 400, { error: 'formato de imagem não suportado (use PNG, JPEG, GIF ou WebP)' });
        if (Buffer.byteLength(img.data, 'base64') > 5 * 1024 * 1024) return send(res, 400, { error: 'imagem grande demais (máximo 5 MB cada)' });
      }
      const text = String(body.message || '').trim() || (images.length ? 'Veja a imagem anexada.' : '');
      if (!text) return send(res, 400, { error: 'mensagem vazia' });
      // guardadas no escritório para aparecerem no histórico da conversa
      const imageRefs = images.map((img) => o.saveUpload(Buffer.from(img.data, 'base64'), IMAGE_TYPES[img.mediaType]));
      await startRun(o, project, envId, text, { images, imageRefs });
      return send(res, 200, { ok: true });
    }

    // 📋 relatório do dia: o agente resume o que aconteceu hoje nesta mesa para a secretária
    if (action === 'report') {
      const today = o.day();
      const entries = chat.entries.filter((e) => o.day(e.t) === today);
      if (!entries.length) return send(res, 400, { error: 'nada registrado hoje nesta mesa' });
      const { text } = await connectors.rpc(envId, 'report', { project: brief(envId), entries }, 5 * 60 * 1000);
      (state.reports[today] ??= {})[id] = { text, at: Date.now(), agent: agent?.name || null };
      chats.push(id, 'system', '📋 Relatório do dia enviado para a secretária.');
      o.addLog(agent?.id || null, id, 'Relatório do dia enviado');
      o.save();
      return send(res, 200, { text });
    }

    if (live[id]) return send(res, 409, { error: 'espere o agente terminar' });
    // memória e nova conversa: o resumo é feito pelo Claude do PC escolhido
    const refresh = async () => {
      const m = await connectors.rpc(envId, 'memory', { project: brief(envId), chat }, 5 * 60 * 1000);
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

  // ---------- Memória do escritório ----------
  if (resource === 'office-memory') {
    const mem = state.officeMemory;
    if (!id && method === 'PUT') mem.general = String(body.general || '').slice(0, 50000);
    else if (id && method === 'PUT') {
      if (!state.projects.some((p) => p.id === id)) return send(res, 404, { error: 'mesa não encontrada' });
      mem.projects[id] = { ...mem.projects[id], text: String(body.text || '').slice(0, 20000), at: Date.now() };
    } else if (id && method === 'DELETE') delete mem.projects[id];
    else return send(res, 405, { error: 'método não permitido' });
    o.save();
    return send(res, 200, { ok: true });
  }

  // ---------- Servidores MCP do escritório ----------
  if (resource === 'mcp') return mcpApi(req, res, o, id, action, method, body);
  if (resource === 'mcp-scan' && method === 'POST') {
    // procura no PC escolhido os MCPs que o Claude Code de lá já conhece
    const envId = o.needEnv(req);
    const folders = state.projects.map((p) => p.folders?.[envId]).filter(Boolean);
    const items = await connectors.rpc(envId, 'mcp-scan', { folders }, 30000);
    const scanId = token(8);
    mcpScans.set(scanId, { officeId: o.id, items, exp: Date.now() + 10 * 60000 });
    const names = new Set(state.mcpServers.map((s) => s.name));
    return send(res, 200, {
      scanId,
      items: items.map((it, i) => ({
        i, name: it.name, source: it.source, type: it.config.command ? 'stdio' : it.config.type || 'http',
        target: it.config.command ? [it.config.command, ...(it.config.args || [])].join(' ') : mask(it.config.url),
        exists: names.has(it.name),
      })),
    });
  }
  if (resource === 'mcp-import' && method === 'POST') {
    const scan = mcpScans.get(body.scanId);
    if (!scan || scan.officeId !== o.id || scan.exp < Date.now()) return send(res, 400, { error: 'busca expirada; procure de novo' });
    const created = [];
    for (const i of [].concat(body.picks || [])) {
      const it = scan.items[i];
      if (!it) continue;
      let name = String(it.name).replace(/[^\w-]/g, '_').slice(0, 40);
      while (state.mcpServers.some((s) => s.name === name)) name += '_2';
      const c = it.config;
      created.push(mcpCreate(o, {
        name, type: c.command ? 'stdio' : c.type === 'sse' ? 'sse' : 'http',
        url: c.url, command: c.command, args: c.args, headers: c.headers, env: c.env, projects: 'all',
      }));
    }
    o.save();
    return send(res, 201, { created: created.length });
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
    // modelo/esforço do agente: '' = padrão do Claude Code do PC
    if (body.model !== undefined && !['', 'opus', 'sonnet', 'haiku'].includes(body.model)) body.model = '';
    // modo de permissão da mesa: '' = perguntar sempre
    if (body.permissionMode !== undefined && !PERMISSION_MODES.includes(body.permissionMode)) body.permissionMode = '';
    // papel da mesa: '' = projeto; 'secretaria' = recebe a memória do escritório e delega para as outras
    if (body.role !== undefined && !['', 'secretaria'].includes(body.role)) body.role = '';
    if (body.effort !== undefined && !['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort)) body.effort = '';
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
      // mudou o modo com um pedido rodando: vale na hora (libera o que estiver esperando)
      if (resource === 'projects' && 'permissionMode' in changes && live[item.id]) {
        connectors.rpc(live[item.id].envId, 'set-mode', { projectId: item.id, mode: item.permissionMode }).catch(() => {});
      }
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
      if (resource === 'projects') {
        delete state.queue[item.id];
        delete state.officeMemory.projects[item.id];
      }
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

  if (resource === 'auth') return authApi(req, res, id, req.method === 'POST' ? await readBody(req, 100e3) : {});

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
    // a interface tem botões de "Permitir": não pode ser embutida em outro site (clickjacking)
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
      "img-src 'self' data:", "connect-src 'self'",
    ].join('; '));
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
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
    if (!auth.hasUsers()) {
      console.log('Abra o endereço do hub e crie a sua conta.');
      if (auth.setupCode) console.log(`Código de instalação (pedido ao criar a primeira conta): ${auth.setupCode}`);
    }
    // modo local: o conector deste PC pertence ao dono (primeira conta)
    else startEmbedded(auth.db.users[0].offices[0]);
  });

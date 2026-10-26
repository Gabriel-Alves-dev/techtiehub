// Techtie Hub — o escritório central.
// Guarda o estado (salas, mesas, agentes), as conversas, a memória e as sessões dos
// agentes, serve a interface (public/) e a API. NÃO roda o Claude nem mexe em pastas:
// isso é trabalho dos conectores (conector.js), um em cada PC, que se ligam ao hub.
// Por padrão o hub sobe com um conector embutido para este PC (modo local).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const git = require('./git');
const { ChatStore } = require('./chats');
const { Connectors } = require('./connectors');
const { FileSessionStore } = require('./session-store');
const { describeTool } = require('./describe');
const conector = require('./conector');

const PORT = process.env.PORT || 4321;
const HOST = process.env.HUB_HOST || '127.0.0.1'; // só esta máquina, até existir login (etapa 3)
const EMBEDDED = process.env.HUB_SEM_CONECTOR !== '1'; // conector deste PC dentro do hub
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.HUB_DATA || path.join(__dirname, 'data', 'state.json');
const DATA_DIR = path.dirname(DATA_FILE);
const STATUSES = ['trabalhando', 'ocioso', 'bloqueado', 'concluido'];
const MAX_LOG = 300;

const FLOORS = ['madeira', 'carpete', 'piso', 'escuro'];
const AREAS = ['copa', 'reuniao', 'descanso']; // blocos da coluna lateral de cada sala

const SEED = {
  rooms: [{ id: 'r1', name: 'Escritório', cols: 4, floor: 'madeira', areas: [...AREAS] }],
  projects: [
    { id: 'p1', roomId: 'r1', name: 'Site Techtie', description: 'Landing page e blog', color: '#4f8cff', agentId: 'a1' },
    { id: 'p2', roomId: 'r1', name: 'Automação Jurídica', description: 'Geração de petições e prazos', color: '#f2a93b', agentId: 'a2' },
    { id: 'p3', roomId: 'r1', name: 'App Mobile', description: 'MVP do aplicativo', color: '#3fbf7f', agentId: 'a3' },
  ],
  agents: [
    { id: 'a1', name: 'Ana', role: 'Dev Front-end', shirt: '#4f8cff', hair: '#3b2416', skin: '#f1c7a0', status: 'trabalhando', message: 'Ajustando o header' },
    { id: 'a2', name: 'Leo', role: 'Pesquisador', shirt: '#f2a93b', hair: '#111111', skin: '#c68a5c', status: 'bloqueado', message: 'Preciso do modelo de contrato' },
    { id: 'a3', name: 'Bia', role: 'Designer', shirt: '#3fbf7f', hair: '#c0392b', skin: '#f6d5b8', status: 'ocioso', message: '' },
  ],
  log: [],
};

// ---------- Chave dos conectores ----------
// Todo conector se identifica com ela. Fica em data/hub.json (ou na variável HUB_KEY).
const HUB_FILE = path.join(DATA_DIR, 'hub.json');
const HUB_KEY = process.env.HUB_KEY || (() => {
  const saved = conector.readJson(HUB_FILE);
  if (saved?.key) return saved.key;
  const key = crypto.randomBytes(24).toString('base64url');
  conector.writeJson(HUB_FILE, { key });
  return key;
})();

// No modo local, este PC é conhecido desde já (para migrar dados antigos de pasta única).
const LOCAL_ENV = EMBEDDED ? conector.loadEnv() : null;

function load() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    s = structuredClone(SEED);
  }
  // dados de versões sem salas: tudo vai para uma sala "Escritório"
  if (!s.rooms?.length) s.rooms = [{ id: 'r1', name: 'Escritório', cols: 4, floor: 'madeira' }];
  for (const r of s.rooms) r.areas ??= [...AREAS];
  for (const p of s.projects) if (!s.rooms.some((r) => r.id === p.roomId)) p.roomId = s.rooms[0].id;
  for (const p of s.projects) {
    p.folders ??= {};
    // pasta única (versões antigas) vira a pasta deste PC
    if (p.folder && LOCAL_ENV) p.folders[LOCAL_ENV.id] ??= p.folder;
    delete p.folder;
  }
  s.environments ??= {};
  return s;
}

let state = load();
const browsers = new Set();
const live = {}; // projectId -> { running, pending, envId } — pedidos em andamento (não salvo)

// O navegador recebe o estado salvo + o que está rodando + os PCs conectados.
const snapshot = () => ({ ...state, live, connectors: connectors.online() });

function broadcast(event, data) {
  const payload = `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
  for (const res of browsers) res.write(payload);
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  broadcast(null, snapshot());
}

const chats = new ChatStore(path.join(DATA_DIR, 'chats'), (projectId, entry) => broadcast('chat', { projectId, entry }));
const sessions = new FileSessionStore(path.join(DATA_DIR, 'sessions'));
const connectors = new Connectors({
  onChange: () => broadcast(null, snapshot()),
  onDisconnect(envId) {
    // pedidos que estavam rodando nesse PC não têm mais como terminar
    const name = state.environments[envId]?.name || 'PC';
    for (const [projectId, l] of Object.entries(live)) {
      if (l.envId !== envId) continue;
      delete live[projectId];
      chats.push(projectId, 'system', `O PC "${name}" desconectou do hub; a tarefa foi interrompida.`);
      setStatus(projectId, 'ocioso', `${name} desconectou`, true);
    }
  },
});

function addLog(agentId, projectId, text) {
  state.log.unshift({ t: Date.now(), agentId, projectId, text });
  state.log.length = Math.min(state.log.length, MAX_LOG);
}

function setStatus(projectId, status, message, log) {
  const project = state.projects.find((p) => p.id === projectId);
  const agent = project && state.agents.find((a) => a.id === project.agentId);
  if (!agent) return;
  agent.status = status;
  agent.message = String(message).replace(/\s+/g, ' ').slice(0, 200);
  if (log) addLog(agent.id, projectId, `[${status}] ${agent.message}`);
  save();
}

// Aceita id ou nome (sem diferenciar maiúsculas), para facilitar o uso por scripts.
function find(list, key) {
  if (!key) return null;
  const k = String(key).toLowerCase();
  return list.find((x) => x.id === key || x.name.toLowerCase() === k) || null;
}

const newId = (prefix) => prefix + crypto.randomBytes(4).toString('hex');

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

// Uma mesa tem no máximo um agente: ao atribuir, libera a mesa anterior do agente.
function assign(project, agentId) {
  if (agentId) for (const p of state.projects) if (p.agentId === agentId && p !== project) p.agentId = null;
  project.agentId = agentId || null;
}

// ---------- PC de cada pedido ----------
// O navegador diz em qual PC quer executar (cabeçalho X-Hub-Env, escolhido em "PC").
// Sem escolha, e com um único PC conectado, usa esse.
function envFor(req) {
  const asked = req.headers['x-hub-env'];
  if (asked && connectors.has(asked)) return asked;
  const online = Object.keys(connectors.online());
  return online.length === 1 ? online[0] : null;
}

const envName = (envId) => state.environments[envId]?.name || connectors.online()[envId]?.name || 'PC';

class HttpError extends Error {
  constructor(code, message, extra) {
    super(message);
    Object.assign(this, { code, extra });
  }
}

function needEnv(req) {
  const envId = envFor(req);
  if (envId) return envId;
  const online = Object.keys(connectors.online()).length;
  throw new HttpError(409, online
    ? 'Escolha em qual PC executar (botão PC, no topo).'
    : 'Nenhum PC conectado. Inicie o conector no seu computador (botão PC → Conectar um PC).');
}

// ---------- Eventos do Claude Code (hooks) ----------
const normPath = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

// A mesa cuja pasta (naquele PC) contém `cwd` — a mais específica, se houver pastas aninhadas.
function projectForPath(cwd, envId) {
  if (!cwd || !envId) return null;
  const target = normPath(cwd);
  let best = null, bestLen = 0;
  for (const p of state.projects) {
    const folder = p.folders?.[envId];
    if (!folder) continue;
    const f = normPath(folder);
    if ((target === f || target.startsWith(f + path.sep)) && f.length > bestLen) [best, bestLen] = [p, f.length];
  }
  return best;
}

function handleHook(ev) {
  // sessões iniciadas pelo próprio hub já chegam pelo conector
  if (chats.hasSession(ev.session_id)) return { ignored: 'sessão do hub' };
  const project = projectForPath(ev.cwd, ev.env);
  if (!project) return { ignored: 'nenhuma mesa com essa pasta' };
  const agent = state.agents.find((a) => a.id === project.agentId);
  if (!agent) {
    addLog(null, project.id, `Atividade do Claude em "${project.name}", mas a mesa está vaga`);
    save();
    return { ignored: 'mesa sem agente' };
  }

  let status, message, log = true;
  switch (ev.event) {
    case 'SessionStart':
      [status, message] = ['ocioso', 'Chegou no escritório'];
      break;
    case 'UserPromptSubmit':
      [status, message] = ['trabalhando', ev.prompt || 'Nova tarefa'];
      break;
    case 'PreToolUse':
      [status, message] = ['trabalhando', describeTool(ev.tool_name, ev.tool_input)];
      log = agent.status !== 'trabalhando'; // não lota o histórico com cada ferramenta
      break;
    case 'Notification':
      [status, message] = ['bloqueado', ev.message || 'Precisa de você'];
      break;
    case 'Stop':
      [status, message] = ['concluido', 'Terminou — aguardando você'];
      break;
    case 'SessionEnd':
      [status, message] = ['ocioso', 'Foi embora'];
      break;
    default:
      return { ignored: 'evento desconhecido' };
  }
  setStatus(project.id, status, message, log);
  return { agent: agent.name, status };
}

// ---------- Rotas dos conectores ----------
const authorized = (req) => req.headers.authorization === `Bearer ${HUB_KEY}`;

async function connectorApi(req, res, url, op, sub) {
  const envId = req.headers['x-hub-env'];
  if (!authorized(req) || !envId) return send(res, 401, { error: 'chave do conector inválida' });

  if (op === 'stream' && req.method === 'GET') {
    const name = String(url.searchParams.get('name') || 'PC').slice(0, 40);
    state.environments[envId] = { name, lastSeen: Date.now() };
    connectors.attach(envId, name, req, res);
    save();
    backfillRepos(envId);
    return;
  }

  const body = await readBody(req);
  if (op === 'reply') {
    connectors.reply(body);
    return send(res, 200, { ok: true });
  }

  if (op === 'event') {
    const { type, projectId } = body;
    if (!state.projects.some((p) => p.id === projectId)) return send(res, 200, { ignored: true });
    if (type === 'chat-push') chats.push(projectId, body.role, body.text);
    else if (type === 'chat-update') chats.update(projectId, body.fields || {});
    else if (type === 'status') setStatus(projectId, body.status, body.message, body.log);
    else if (type === 'live') {
      if (body.live) live[projectId] = { ...body.live, envId };
      else delete live[projectId];
      broadcast(null, snapshot());
    }
    return send(res, 200, { ok: true });
  }

  if (op === 'sessions') {
    // sessões do Claude espelhadas no hub (ver remote-store.js / session-store.js)
    if (sub === 'append') await sessions.append(body.key, body.entries || []);
    else if (sub === 'load') return send(res, 200, await sessions.load(body.key));
    else if (sub === 'subkeys') return send(res, 200, await sessions.listSubkeys(body.key));
    else if (sub === 'delete') await sessions.delete(body.key);
    else if (sub === 'has') return send(res, 200, sessions.has(body.sessionId));
    else return send(res, 404, { error: 'operação desconhecida' });
    return send(res, 200, null);
  }

  send(res, 404, { error: 'rota desconhecida' });
}

// Mesas vinculadas antes de o hub guardar o repositório: registra o remote quando o PC conecta.
async function backfillRepos(envId) {
  let changed = false;
  for (const p of state.projects) {
    if (p.repo || !p.folders?.[envId]) continue;
    const info = await connectors.rpc(envId, 'folder-info', { folder: p.folders[envId] }).catch(() => null);
    if (info?.remote) [p.repo, changed] = [info.remote, true];
  }
  if (changed) save();
}

// ---------- Rotas do navegador ----------
async function api(req, res, url) {
  const [, , resource, id, action] = url.pathname.split('/');
  const method = req.method;

  if (resource === 'connector') return connectorApi(req, res, url, id, action);

  if (resource === 'state' && method === 'GET') return send(res, 200, snapshot());

  if (resource === 'events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    browsers.add(res);
    req.on('close', () => browsers.delete(res));
    return;
  }

  if (resource === 'export' && method === 'GET') {
    const bundle = { app: 'techtie-hub', version: 2, exportedAt: new Date().toISOString(), state, chats: chats.exportAll(), sessions: sessions.exportAll() };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="techtie-hub-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    return res.end(JSON.stringify(bundle));
  }

  // Só aceita JSON: impede que um site qualquer dispare a API com um <form>.
  if (method !== 'GET' && method !== 'DELETE' && !String(req.headers['content-type']).startsWith('application/json')) {
    return send(res, 415, { error: 'use Content-Type: application/json' });
  }
  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);

  if (resource === 'hook' && method === 'POST') {
    if (!authorized(req)) return send(res, 401, { error: 'chave inválida' });
    return send(res, 200, handleHook(body));
  }

  if (resource === 'connector-info' && method === 'GET') {
    // para a janela "Conectar outro PC" (sem login ainda: o hub só escuta nesta máquina)
    return send(res, 200, { key: HUB_KEY, hub: `http://${req.headers.host}` });
  }

  if (resource === 'pick-folder' && method === 'POST') {
    return send(res, 200, await connectors.rpc(needEnv(req), 'pick-folder', {}, 10 * 60 * 1000));
  }

  if (resource === 'environment' && method === 'PATCH') {
    const envId = needEnv(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return send(res, 400, { error: 'nome vazio' });
    await connectors.rpc(envId, 'rename', { name });
    connectors.rename(envId, name);
    state.environments[envId] = { name, lastSeen: Date.now() };
    save();
    return send(res, 200, { ok: true });
  }

  if (resource === 'import' && method === 'POST') {
    if (body.app !== 'techtie-hub' || !body.state?.projects) return send(res, 400, { error: 'arquivo não é uma exportação do Techtie Hub' });
    if (Object.keys(live).length) return send(res, 409, { error: 'pare os agentes antes de importar' });
    // pastas já configuradas aqui continuam valendo (a importação pode vir de outro hub)
    const known = Object.fromEntries(state.projects.map((p) => [p.id, p.folders]));
    const envs = state.environments;
    chats.importAll(body.chats);
    sessions.importAll(body.sessions);
    fs.writeFileSync(DATA_FILE, JSON.stringify(body.state));
    state = load();
    state.environments = { ...envs, ...state.environments };
    for (const p of state.projects) p.folders = { ...known[p.id], ...p.folders };
    addLog(null, null, 'Escritório importado de um backup');
    save();
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
      const envId = envFor(req);
      if (!envId || !project.folders[envId]) return send(res, 200, { git: false });
      return send(res, 200, await connectors.rpc(envId, 'git', { folder: project.folders[envId], last: chat.lastCommit }));
    }
    if (method !== 'POST') return send(res, 405, { error: 'método não permitido' });

    // pedidos em andamento vão para o PC onde estão rodando, venha de onde vier a resposta
    if (action === 'answer' || action === 'stop') {
      if (!live[id]) return send(res, 409, { error: 'nada rodando nesta mesa' });
      return send(res, 200, await connectors.rpc(live[id].envId, action, { projectId: id, ...body }));
    }

    const envId = needEnv(req);
    if (action === 'open') return send(res, 200, await connectors.rpc(envId, 'open', { folder: project.folders[envId], app: body.app }));

    if (action === 'chat') {
      if (live[id]) return send(res, 409, { error: 'o agente ainda está trabalhando nesta mesa' });
      const folder = project.folders[envId];
      if (!folder) return send(res, 400, { error: `defina a pasta desta mesa no PC "${envName(envId)}" em ⚙ Mesa` });
      const text = String(body.message || '').trim();
      if (!text) return send(res, 400, { error: 'mensagem vazia' });
      live[id] = { running: true, pending: null, envId }; // reserva a mesa até o conector confirmar
      try {
        await connectors.rpc(envId, 'run', { project: brief(folder), text, chat });
      } catch (e) {
        delete live[id];
        broadcast(null, snapshot());
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

  if (resource === 'report' && method === 'POST') {
    const agent = find(state.agents, body.agent);
    if (!agent) return send(res, 404, { error: `agente "${body.agent}" não encontrado` });
    if (body.status && !STATUSES.includes(body.status)) {
      return send(res, 400, { error: `status inválido; use: ${STATUSES.join(', ')}` });
    }
    if (body.project) {
      const project = find(state.projects, body.project);
      if (!project) return send(res, 404, { error: `projeto "${body.project}" não encontrado` });
      assign(project, agent.id);
    }
    if (body.status) agent.status = body.status;
    if (body.message !== undefined) agent.message = String(body.message).slice(0, 200);
    const desk = state.projects.find((p) => p.agentId === agent.id);
    addLog(agent.id, desk?.id ?? null, `[${agent.status}] ${agent.message || ''}`.trim());
    save();
    return send(res, 200, agent);
  }

  if (FIELDS[resource]) {
    const list = state[resource];
    const fields = FIELDS[resource];

    // A pasta vale só para o PC escolhido: o conector confere se existe e qual o repositório.
    let folderEnv = null, folderRemote = null;
    if (resource === 'projects' && typeof body.folder === 'string') {
      folderEnv = needEnv(req);
      if (body.folder.trim()) {
        const info = await connectors.rpc(folderEnv, 'folder-info', { folder: body.folder });
        if (!info.exists) return send(res, 400, { error: `a pasta "${info.folder || body.folder}" não existe no PC "${envName(folderEnv)}"` });
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
        assign(item, body.agentId);
      } else {
        list.push(item);
      }
      const what = { agents: `${item.name} foi contratado(a)`, projects: `Nova mesa: ${item.name}`, rooms: `Nova sala: ${item.name}` };
      addLog(resource === 'agents' ? item.id : null, resource === 'projects' ? item.id : null, what[resource]);
      save();
      return send(res, 201, item);
    }

    const item = list.find((x) => x.id === id);
    if (!item) return send(res, 404, { error: 'não encontrado' });

    if (method === 'PATCH') {
      const changes = pick(body, fields);
      if (changes.status && !STATUSES.includes(changes.status)) return send(res, 400, { error: 'status inválido' });
      if (resource === 'projects' && 'agentId' in changes) {
        assign(item, changes.agentId);
        delete changes.agentId;
      }
      Object.assign(item, changes);
      applyFolder(item);
      save();
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
      save();
      return send(res, 204, {});
    }
  }

  send(res, 404, { error: 'rota desconhecida' });
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
    if (!EMBEDDED) return;
    // modo local: este PC já fica conectado; o hub-hook.js usa a mesma configuração
    const hub = `http://127.0.0.1:${PORT}`;
    if (!conector.readJson(conector.CONFIG_FILE)) conector.writeJson(conector.CONFIG_FILE, { hub, key: HUB_KEY });
    conector.start({ hub, key: HUB_KEY, log: (...a) => console.log('[conector]', ...a) });
  });

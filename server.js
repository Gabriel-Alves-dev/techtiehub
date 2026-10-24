// Techtie Hub — servidor local.
// Serve o escritório visual (public/), uma API para os agentes reportarem status
// e roda o Claude na pasta de cada mesa (runner.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Runner } = require('./runner');

const PORT = process.env.PORT || 4321;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.HUB_DATA || path.join(__dirname, 'data', 'state.json');
const STATUSES = ['trabalhando', 'ocioso', 'bloqueado', 'concluido'];
const MAX_LOG = 300;

const SEED = {
  projects: [
    { id: 'p1', name: 'Site Techtie', description: 'Landing page e blog', color: '#4f8cff', agentId: 'a1' },
    { id: 'p2', name: 'Automação Jurídica', description: 'Geração de petições e prazos', color: '#f2a93b', agentId: 'a2' },
    { id: 'p3', name: 'App Mobile', description: 'MVP do aplicativo', color: '#3fbf7f', agentId: 'a3' },
  ],
  agents: [
    { id: 'a1', name: 'Ana', role: 'Dev Front-end', shirt: '#4f8cff', hair: '#3b2416', skin: '#f1c7a0', status: 'trabalhando', message: 'Ajustando o header' },
    { id: 'a2', name: 'Leo', role: 'Pesquisador', shirt: '#f2a93b', hair: '#111111', skin: '#c68a5c', status: 'bloqueado', message: 'Preciso do modelo de contrato' },
    { id: 'a3', name: 'Bia', role: 'Designer', shirt: '#3fbf7f', hair: '#c0392b', skin: '#f6d5b8', status: 'ocioso', message: '' },
  ],
  log: [],
};

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return structuredClone(SEED);
  }
}

let state = load();
const clients = new Set();

// O navegador recebe o estado salvo + o que está rodando agora (não persistido).
const snapshot = () => ({ ...state, live: runner.live() });

function broadcast(event, data) {
  const payload = `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  broadcast(null, snapshot());
}

const runner = new Runner({
  dir: path.join(path.dirname(DATA_FILE), 'chats'),
  describeTool,
  onStatus(projectId, status, message, log) {
    const project = state.projects.find((p) => p.id === projectId);
    const agent = project && state.agents.find((a) => a.id === project.agentId);
    if (!agent) return;
    agent.status = status;
    agent.message = String(message).replace(/\s+/g, ' ').slice(0, 200);
    if (log) addLog(agent.id, projectId, `[${status}] ${agent.message}`);
    save();
  },
  onLive: () => broadcast(null, snapshot()),
  onChat: (projectId, entry) => broadcast('chat', { projectId, entry }),
});

function addLog(agentId, projectId, text) {
  state.log.unshift({ t: Date.now(), agentId, projectId, text });
  state.log.length = Math.min(state.log.length, MAX_LOG);
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

const PROJECT_FIELDS = ['name', 'description', 'color', 'agentId', 'folder'];
const AGENT_FIELDS = ['name', 'role', 'shirt', 'hair', 'skin', 'status', 'message'];

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
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

// ---------- Pastas dos projetos ----------
function isDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const normPath = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

// A mesa cuja pasta contém `cwd` (a mais específica, se houver pastas aninhadas).
function projectForPath(cwd) {
  if (!cwd) return null;
  const target = normPath(cwd);
  let best = null;
  for (const p of state.projects) {
    if (!p.folder) continue;
    const f = normPath(p.folder);
    if ((target === f || target.startsWith(f + path.sep)) && (!best || f.length > normPath(best.folder).length)) best = p;
  }
  return best;
}

function openFolder(folder, app) {
  const opts = { cwd: folder, detached: true, stdio: 'ignore', windowsHide: true };
  if (app === 'vscode') spawn('cmd.exe', ['/c', 'code', '.'], opts).unref();
  else spawn('explorer.exe', ['.'], { ...opts, windowsHide: false }).unref();
}

function pickFolder() {
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Escolha a pasta do projeto'",
    "if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }",
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8', windowsHide: true }, (err, out) =>
      err ? reject(err) : resolve(out.trim() || null));
  });
}

// ---------- Eventos do Claude Code (hooks) ----------
function describeTool(name, input = {}) {
  const file = input.file_path ? path.basename(input.file_path) : '';
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editando ${file}`;
    case 'Write':
      return `Escrevendo ${file}`;
    case 'Read':
      return `Lendo ${file}`;
    case 'Bash':
    case 'PowerShell':
      return `Rodando: ${input.description || input.command || ''}`;
    case 'Grep':
    case 'Glob':
      return 'Procurando no código';
    case 'WebFetch':
    case 'WebSearch':
      return 'Pesquisando na web';
    case 'Agent':
    case 'Task':
      return `Delegando: ${input.description || 'subagente'}`;
    default:
      return `Usando ${name}`;
  }
}

function handleHook(ev) {
  // sessões iniciadas pelo próprio hub já atualizam o escritório pelo runner
  if (runner.isHubSession(ev.session_id)) return { ignored: 'sessão do hub' };
  const project = projectForPath(ev.cwd);
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
  agent.status = status;
  agent.message = String(message).replace(/\s+/g, ' ').slice(0, 200);
  if (log) addLog(agent.id, project.id, `[${status}] ${agent.message}`);
  save();
  return { agent: agent.name, status };
}

async function api(req, res, url) {
  const [, , resource, id, action] = url.pathname.split('/');
  const method = req.method;

  if (resource === 'state' && method === 'GET') return send(res, 200, snapshot());

  if (resource === 'events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Só aceita JSON: impede que um site qualquer dispare a API com um <form> (ela abre programas no PC).
  if (method !== 'GET' && method !== 'DELETE' && !String(req.headers['content-type']).startsWith('application/json')) {
    return send(res, 415, { error: 'use Content-Type: application/json' });
  }
  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);

  if (resource === 'hook' && method === 'POST') return send(res, 200, handleHook(body));

  if (resource === 'pick-folder' && method === 'POST') {
    try {
      return send(res, 200, { folder: await pickFolder() });
    } catch (e) {
      return send(res, 500, { error: 'não consegui abrir o seletor de pastas: ' + e.message });
    }
  }

  // ---------- Conversa com o agente da mesa ----------
  if (resource === 'projects' && ['chat', 'answer', 'stop', 'reset'].includes(action)) {
    const project = state.projects.find((p) => p.id === id);
    if (!project) return send(res, 404, { error: 'não encontrado' });
    if (action === 'chat' && method === 'GET') return send(res, 200, runner.chat(id));
    if (method !== 'POST') return send(res, 405, { error: 'método não permitido' });
    try {
      if (action === 'chat') {
        if (!isDir(project.folder)) return send(res, 400, { error: 'defina a pasta do projeto antes (Editar)' });
        const text = String(body.message || '').trim();
        if (!text) return send(res, 400, { error: 'mensagem vazia' });
        await runner.send(project, text);
      } else if (action === 'answer') runner.answer(id, body);
      else if (action === 'stop') runner.stop(id);
      else runner.reset(id);
    } catch (e) {
      return send(res, 409, { error: e.message });
    }
    return send(res, 200, { ok: true });
  }

  if (resource === 'projects' && action === 'open' && method === 'POST') {
    const project = state.projects.find((p) => p.id === id);
    if (!project) return send(res, 404, { error: 'não encontrado' });
    if (!isDir(project.folder)) return send(res, 400, { error: 'pasta não definida ou inexistente' });
    openFolder(project.folder, body.app);
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

  if (resource === 'projects' || resource === 'agents') {
    const list = state[resource];
    const fields = resource === 'projects' ? PROJECT_FIELDS : AGENT_FIELDS;
    if (typeof body.folder === 'string') {
      body.folder = body.folder.trim().replace(/^"(.*)"$/, '$1') || null;
      if (body.folder && !isDir(body.folder)) return send(res, 400, { error: `a pasta "${body.folder}" não existe` });
      if (body.folder) body.folder = path.resolve(body.folder);
    }

    if (method === 'POST' && !id) {
      if (!body.name) return send(res, 400, { error: 'nome é obrigatório' });
      const item = { id: newId(resource[0]), ...pick(body, fields) };
      if (resource === 'agents') item.status ??= 'ocioso';
      if (resource === 'projects') {
        item.agentId = null;
        list.push(item);
        assign(item, body.agentId);
      } else {
        list.push(item);
      }
      addLog(resource === 'agents' ? item.id : null, resource === 'projects' ? item.id : null,
        resource === 'agents' ? `${item.name} foi contratado(a)` : `Nova mesa: ${item.name}`);
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
      save();
      return send(res, 200, item);
    }

    if (method === 'DELETE') {
      state[resource] = list.filter((x) => x !== item);
      if (resource === 'projects') runner.stop(item.id);
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
      send(res, 400, { error: e.message });
    }
  })
  // só nesta máquina: a API abre pastas e programas, não deve ficar exposta na rede
  .listen(PORT, '127.0.0.1', () => console.log(`Techtie Hub rodando em http://localhost:${PORT}`));

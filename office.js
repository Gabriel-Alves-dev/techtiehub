// Um escritório: salas, mesas, agentes, conversas, sessões do Claude e os PCs conectados.
// Cada conta é dona de um escritório (data/offices/<id>/); nada é compartilhado entre eles.
const fs = require('fs');
const path = require('path');
const { ChatStore } = require('./chats');
const { Connectors } = require('./connectors');
const { FileSessionStore } = require('./session-store');
const { describeTool } = require('./describe');

const STATUSES = ['trabalhando', 'ocioso', 'bloqueado', 'concluido'];
const FLOORS = ['madeira', 'carpete', 'piso', 'escuro'];
const AREAS = ['copa', 'reuniao', 'descanso']; // blocos da coluna lateral de cada sala
const MAX_LOG = 300;

// escritório de exemplo para contas novas
const SEED = {
  rooms: [{ id: 'r1', name: 'Escritório', cols: 4, floor: 'madeira', areas: [...AREAS] }],
  projects: [
    { id: 'p1', roomId: 'r1', name: 'Meu primeiro projeto', description: 'Clique na mesa e escolha a pasta em ⚙ Mesa', color: '#4f8cff', agentId: 'a1', folders: {} },
  ],
  agents: [
    { id: 'a1', name: 'Ana', role: 'Dev', shirt: '#4f8cff', hair: '#3b2416', skin: '#f1c7a0', status: 'ocioso', message: '' },
    { id: 'a2', name: 'Leo', role: 'Pesquisador', shirt: '#f2a93b', hair: '#111111', skin: '#c68a5c', status: 'ocioso', message: '' },
  ],
  log: [],
};

const normPath = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

class HttpError extends Error {
  constructor(code, message, extra) {
    super(message);
    Object.assign(this, { code, extra });
  }
}

class Office {
  // legacyEnvId: PC do modo local, para migrar dados antigos de pasta única
  constructor(id, dir, { legacyEnvId } = {}) {
    Object.assign(this, { id, dir, legacyEnvId });
    this.file = path.join(dir, 'state.json');
    this.state = this.load();
    this.browsers = new Set();
    this.live = {}; // projectId -> { running, pending, envId } — pedidos em andamento (não salvo)
    this.chats = new ChatStore(path.join(dir, 'chats'), (projectId, entry) => this.broadcast('chat', { projectId, entry }));
    this.sessions = new FileSessionStore(path.join(dir, 'sessions'));
    this.connectors = new Connectors({
      onChange: () => this.broadcast(null, this.snapshot()),
      onDisconnect: (envId) => this.onDisconnect(envId),
    });
  }

  load() {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      s = structuredClone(SEED);
    }
    // dados de versões sem salas: tudo vai para uma sala "Escritório"
    if (!s.rooms?.length) s.rooms = [{ id: 'r1', name: 'Escritório', cols: 4, floor: 'madeira' }];
    for (const r of s.rooms) r.areas ??= [...AREAS];
    for (const p of s.projects) if (!s.rooms.some((r) => r.id === p.roomId)) p.roomId = s.rooms[0].id;
    for (const p of s.projects) {
      p.folders ??= {};
      // pasta única (versões antigas) vira a pasta do PC local
      if (p.folder && this.legacyEnvId) p.folders[this.legacyEnvId] ??= p.folder;
      delete p.folder;
    }
    s.environments ??= {};
    return s;
  }

  // O navegador recebe o estado salvo + o que está rodando + os PCs conectados.
  snapshot() {
    // now: relógio do hub, para o navegador acertar os cronômetros com o dele
    return { ...this.state, live: this.live, connectors: this.connectors.online(), now: Date.now() };
  }

  broadcast(event, data) {
    const payload = `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
    for (const res of this.browsers) res.write(payload);
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    this.broadcast(null, this.snapshot());
  }

  attachBrowser(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`data: ${JSON.stringify(this.snapshot())}\n\n`);
    this.browsers.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      this.browsers.delete(res);
    });
  }

  addLog(agentId, projectId, text) {
    this.state.log.unshift({ t: Date.now(), agentId, projectId, text });
    this.state.log.length = Math.min(this.state.log.length, MAX_LOG);
  }

  setStatus(projectId, status, message, log) {
    const project = this.state.projects.find((p) => p.id === projectId);
    const agent = project && this.state.agents.find((a) => a.id === project.agentId);
    if (!agent) return;
    agent.status = status;
    agent.message = String(message).replace(/\s+/g, ' ').slice(0, 200);
    if (log) this.addLog(agent.id, projectId, `[${status}] ${agent.message}`);
    this.save();
  }

  // pedidos que estavam rodando num PC que caiu não têm mais como terminar
  onDisconnect(envId) {
    const name = this.envName(envId);
    for (const [projectId, l] of Object.entries(this.live)) {
      if (l.envId !== envId) continue;
      delete this.live[projectId];
      this.chats.push(projectId, 'system', `O PC "${name}" desconectou do hub; a tarefa foi interrompida.`);
      this.setStatus(projectId, 'ocioso', `${name} desconectou`, true);
    }
  }

  envName(envId) {
    return this.state.environments[envId]?.name || this.connectors.online()[envId]?.name || 'PC';
  }

  // O navegador diz em qual PC quer executar (cabeçalho X-Hub-Env, escolhido em "PC").
  // Sem escolha, e com um único PC conectado, usa esse.
  envFor(req) {
    const asked = req.headers['x-hub-env'];
    if (asked && this.connectors.has(asked)) return asked;
    const online = Object.keys(this.connectors.online());
    return online.length === 1 ? online[0] : null;
  }

  needEnv(req) {
    const envId = this.envFor(req);
    if (envId) return envId;
    throw new HttpError(409, Object.keys(this.connectors.online()).length
      ? 'Escolha em qual PC executar (botão PC, no topo).'
      : 'Nenhum PC conectado. Inicie o conector no seu computador (botão PC → Conectar um PC).');
  }

  // ---------- Eventos do Claude Code (hooks) ----------
  // A mesa cuja pasta (naquele PC) contém `cwd` — a mais específica, se houver pastas aninhadas.
  projectForPath(cwd, envId) {
    if (!cwd || !envId) return null;
    const target = normPath(cwd);
    let best = null, bestLen = 0;
    for (const p of this.state.projects) {
      const folder = p.folders?.[envId];
      if (!folder) continue;
      const f = normPath(folder);
      if ((target === f || target.startsWith(f + path.sep)) && f.length > bestLen) [best, bestLen] = [p, f.length];
    }
    return best;
  }

  handleHook(ev, envId) {
    // sessões iniciadas pelo próprio hub já chegam pelo conector
    if (this.chats.hasSession(ev.session_id)) return { ignored: 'sessão do hub' };
    const project = this.projectForPath(ev.cwd, envId);
    if (!project) return { ignored: 'nenhuma mesa com essa pasta' };
    const agent = this.state.agents.find((a) => a.id === project.agentId);
    if (!agent) {
      this.addLog(null, project.id, `Atividade do Claude em "${project.name}", mas a mesa está vaga`);
      this.save();
      return { ignored: 'mesa sem agente' };
    }
    const events = {
      SessionStart: ['ocioso', 'Chegou no escritório'],
      UserPromptSubmit: ['trabalhando', ev.prompt || 'Nova tarefa'],
      PreToolUse: ['trabalhando', describeTool(ev.tool_name, ev.tool_input)],
      Notification: ['bloqueado', ev.message || 'Precisa de você'],
      Stop: ['concluido', 'Terminou — aguardando você'],
      SessionEnd: ['ocioso', 'Foi embora'],
    };
    if (!events[ev.event]) return { ignored: 'evento desconhecido' };
    const [status, message] = events[ev.event];
    // não lota o histórico com cada ferramenta
    this.setStatus(project.id, status, message, !(ev.event === 'PreToolUse' && agent.status === 'trabalhando'));
    return { agent: agent.name, status };
  }

  // Mesas vinculadas antes de o hub guardar o repositório: registra o remote quando o PC conecta.
  async backfillRepos(envId) {
    let changed = false;
    for (const p of this.state.projects) {
      if (p.repo || !p.folders?.[envId]) continue;
      const info = await this.connectors.rpc(envId, 'folder-info', { folder: p.folders[envId] }).catch(() => null);
      if (info?.remote) [p.repo, changed] = [info.remote, true];
    }
    if (changed) this.save();
  }
}

module.exports = { Office, HttpError, STATUSES, FLOORS, AREAS };

// Um escritório: salas, mesas, agentes, conversas, sessões do Claude e os PCs conectados.
// Cada conta é dona de um escritório (data/offices/<id>/); nada é compartilhado entre eles.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ChatStore } = require('./chats');
const { Connectors } = require('./connectors');
const { FileSessionStore } = require('./session-store');
const { describeTool } = require('./describe');
const { mask } = require('./secrets');

const STATUSES = ['trabalhando', 'ocioso', 'bloqueado', 'concluido'];
const FLOORS = ['madeira', 'carpete', 'piso', 'escuro'];
const AREAS = ['copa', 'reuniao', 'descanso']; // blocos da coluna lateral de cada sala
const WALLS = ['cinza', 'azul', 'verde', 'vinho', 'bege'];
// itens de decoração que o usuário posiciona (quadro e bandeira ficam na parede, o resto no piso)
const DECOR = ['quadro', 'bandeira', 'planta', 'tapete', 'estante', 'abajur', 'impressora'];
const MAX_DECOR = 80;
const MAX_LOG = 300;
const GRACE_MS = 90 * 1000; // quanto o hub espera um PC que caiu voltar antes de abandonar as tarefas

// escritório de exemplo para contas novas
const SEED = {
  rooms: [{ id: 'r1', name: 'Escritório', cols: 4, floor: 'madeira', wall: 'cinza', decor: [], areas: [...AREAS] }],
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
  // connectorVersion: versão atual do conector (para a interface apontar PCs desatualizados)
  // secrets: criptografia dos tokens/URLs dos servidores MCP (secrets.js)
  constructor(id, dir, { legacyEnvId, connectorVersion, secrets } = {}) {
    Object.assign(this, { id, dir, legacyEnvId, connectorVersion, secrets });
    this.file = path.join(dir, 'state.json');
    this.state = this.load();
    this.browsers = new Set();
    this.live = {}; // projectId -> { running, pending, envId } — pedidos em andamento (não salvo)
    this.usage = {}; // envId -> { subscription, fiveHour, sevenDay, at } — limite de uso da conta Claude (não salvo)
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
    for (const r of s.rooms) { r.areas ??= [...AREAS]; r.wall ??= 'cinza'; r.decor ??= []; }
    for (const p of s.projects) if (!s.rooms.some((r) => r.id === p.roomId)) p.roomId = s.rooms[0].id;
    for (const p of s.projects) {
      p.folders ??= {};
      // pasta única (versões antigas) vira a pasta do PC local
      if (p.folder && this.legacyEnvId) p.folders[this.legacyEnvId] ??= p.folder;
      delete p.folder;
    }
    s.environments ??= {};
    s.mcpServers ??= [];
    // memória do escritório: notas gerais + um bloco por projeto (enviado pela mesa)
    s.officeMemory ??= { general: '', projects: {} };
    // relatórios do dia: { 'AAAA-MM-DD': { projectId: { text, at, agent } } } — guarda 30 dias
    s.reports ??= {};
    for (const day of Object.keys(s.reports).sort().slice(0, -30)) delete s.reports[day];
    // demandas esperando a mesa ficar livre: { projectId: [{ text, from, at }] }
    s.queue ??= {};
    // recados das mesas para a secretária (ferramenta avisar_secretaria) — guarda os 200 mais recentes
    s.inbox ??= [];
    // variáveis de ambiente do escritório (webhooks, credenciais…): valores criptografados
    s.vars ??= [];
    return s;
  }

  // O navegador recebe o estado salvo + o que está rodando + os PCs conectados.
  snapshot() {
    // now: relógio do hub, para o navegador acertar os cronômetros com o dele
    return { ...this.state, live: this.live, connectors: this.connectors.online(), connectorVersion: this.connectorVersion, now: Date.now(), usage: this.usage };
  }

  // Limite de uso (conta Claude) de um PC, mandado pelo conector.
  setUsage(envId, data) {
    this.usage[envId] = { ...data, at: Date.now() };
    this.broadcast(null, this.snapshot());
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
  // Um PC caiu. Quedas curtas são normais (redeploy do hub, internet oscilando) e o agente
  // continua trabalhando no PC: espera ele voltar antes de dar a tarefa como perdida.
  onDisconnect(envId) {
    const affected = Object.values(this.live).filter((l) => l.envId === envId);
    if (!affected.length) return;
    for (const l of affected) l.offline = true;
    this.broadcast(null, this.snapshot());
    clearTimeout(this.graceTimers?.[envId]);
    (this.graceTimers ??= {})[envId] = setTimeout(() => this.abandonEnv(envId), GRACE_MS);
  }

  // O PC voltou: o conector manda em seguida a lista do que está rodando (syncLive).
  onReconnect(envId) {
    clearTimeout(this.graceTimers?.[envId]);
    for (const l of Object.values(this.live)) if (l.envId === envId) delete l.offline;
  }

  abandonEnv(envId) {
    if (this.connectors.has(envId)) return;
    const name = this.envName(envId);
    for (const [projectId, l] of Object.entries(this.live)) {
      if (l.envId !== envId) continue;
      delete this.live[projectId];
      this.chats.push(projectId, 'system', `O PC "${name}" desconectou do hub e não voltou; a tarefa foi interrompida.`);
      this.setStatus(projectId, 'ocioso', `${name} desconectou`, true);
    }
    this.broadcast(null, this.snapshot());
  }

  // Lista enviada pelo conector a cada (re)conexão: o que ele diz que roda é a verdade.
  // Mesas que o hub achava "rodando" naquele PC e não estão na lista ficaram fantasmas.
  syncLive(envId, lives) {
    for (const [projectId, l] of Object.entries(this.live)) {
      if (l.envId !== envId || lives[projectId]) continue;
      delete this.live[projectId];
      const agent = this.agentOf(projectId);
      if (agent && ['trabalhando', 'bloqueado'].includes(agent.status)) this.setStatus(projectId, 'ocioso', 'Tarefa encerrada', true);
    }
    for (const [projectId, l] of Object.entries(lives || {})) {
      if (this.state.projects.some((p) => p.id === projectId)) this.setLive(projectId, l, envId);
    }
    this.broadcast(null, this.snapshot());
  }

  // `age` vira um horário no relógio do hub (cada PC tem o seu relógio)
  setLive(projectId, l, envId) {
    if (!l) {
      delete this.live[projectId];
      return this.idle(projectId);
    }
    const phase = l.phase && { kind: l.phase.kind, name: l.phase.name, since: Date.now() - (l.phase.age || 0) };
    this.live[projectId] = { ...l, phase, envId };
  }

  agentOf(projectId) {
    const project = this.state.projects.find((p) => p.id === projectId);
    return project && this.state.agents.find((a) => a.id === project.agentId);
  }

  // Parar quando o PC não responde ou já não tinha nada rodando: só limpa a mesa no hub.
  forceStop(projectId, reason) {
    if (!this.live[projectId]) return;
    delete this.live[projectId];
    this.chats.push(projectId, 'system', reason);
    this.setStatus(projectId, 'ocioso', 'Parou', true);
    this.idle(projectId);
  }

  // a mesa terminou: se houver demanda na fila, o servidor começa a próxima (ver server.js)
  idle(projectId) {
    if (this.state.queue[projectId]?.length) setImmediate(() => this.onIdle?.(projectId));
  }

  // ---------- Memória do escritório, relatórios e visão da secretária ----------
  // Dia no fuso do escritório (o servidor pode estar em UTC).
  day(t = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.HUB_TZ || 'America/Sao_Paulo' }).format(new Date(t));
  }

  // As mesas como a secretária enxerga.
  roster() {
    return this.state.projects.map((p) => {
      const a = this.agentOf(p.id);
      const room = this.state.rooms.find((r) => r.id === p.roomId);
      return {
        id: p.id, mesa: p.name, descricao: p.description || '', sala: room?.name || '',
        agente: a ? `${a.name}${a.role ? ` (${a.role})` : ''}` : null,
        status: a?.status || 'sem agente', ocupada: !!this.live[p.id], naFila: this.state.queue[p.id]?.length || 0,
        secretaria: p.role === 'secretaria',
      };
    });
  }

  // Acha a mesa pelo nome do projeto ou do agente (sem acento/maiúscula). { project } ou { error }
  // withSecretaries: quem chama é uma secretária (exceto = a mesa dela) e pode falar com as outras secretárias
  findDesk(q, { withSecretaries = false, except = null } = {}) {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const k = norm(q);
    if (!k) return { error: 'informe a mesa ou o agente' };
    const cands = this.state.projects.filter((p) => p.id !== except && (withSecretaries || p.role !== 'secretaria')).map((p) => ({ p, names: [p.name, this.agentOf(p.id)?.name].filter(Boolean).map(norm) }));
    for (const test of [(n) => n === k, (n) => n.startsWith(k), (n) => n.includes(k) || k.includes(n)]) {
      const hits = cands.filter((c) => c.names.some(test));
      if (hits.length === 1) return { project: hits[0].p };
      if (hits.length > 1) return { error: `mais de uma mesa combina com "${q}": ${hits.map((h) => h.p.name).join(', ')}. Use o nome exato.` };
    }
    return { error: `nenhuma mesa ou agente chamado "${q}". Mesas: ${cands.map((c) => c.p.name).join(', ')}` };
  }

  // Contexto de um agente de projeto: quem ele é, onde está e o que pode fazer no escritório.
  deskContext(projectId) {
    const p = this.state.projects.find((x) => x.id === projectId);
    const a = this.agentOf(projectId);
    const secs = this.state.projects.filter((x) => x.role === 'secretaria').map((s) => this.agentOf(s.id)?.name || 'a secretária');
    const secName = secs.length ? secs.join(' e ') : null;
    const others = this.roster().filter((d) => d.id !== projectId && !d.secretaria)
      .map((d) => `- ${d.mesa}${d.agente ? ` — ${d.agente}` : ''}${d.descricao ? ` · ${d.descricao}` : ''}`);
    return [
      '# Você trabalha no escritório Techtie Hub',
      `Você é ${a ? `${a.name}${a.role ? `, ${a.role}` : ''}` : 'o agente'}, responsável pela mesa "${p.name}"${p.description ? ` (${p.description})` : ''}. ` +
      'O escritório tem outros agentes, cada um cuidando de um projeto' + (secName ? `, e ${secs.length > 1 ? 'secretárias' : 'uma secretária'} (${secName}) que ${secs.length > 1 ? 'organizam e distribuem' : 'organiza e distribui'} as demandas.` : '.'),
      'Ferramentas do escritório (servidor "escritorio"): enviar_relatorio, salvar_memoria_projeto, avisar_secretaria, ler_memoria_escritorio e listar_mesas. ' +
      'Quando o usuário pedir para mandar o relatório, avisar ou falar com a secretária, ou salvar algo na memória do projeto/escritório, ' +
      'use essas ferramentas: não procure arquivos ou configurações no projeto para isso.',
      'Pedidos que começam com "📨 Demanda da secretária" foram passados por ela: trabalhe neles normalmente. O usuário acompanha e responde por aqui.',
      '## Outras mesas', others.join('\n') || '(nenhuma)',
    ].join('\n\n');
  }

  // Contexto que vai no prompt de sistema da secretária a cada pedido (sempre atualizado).
  secretaryContext(selfId) {
    const peers = this.roster().filter((d) => d.secretaria && d.id !== selfId)
      .map((d) => `- **${d.mesa}**${d.agente ? ` — agente ${d.agente}` : ''}${d.descricao ? ` · ${d.descricao}` : ''} · ${d.ocupada ? 'trabalhando agora' : d.status}`);
    const desks = this.roster().filter((d) => !d.secretaria).map((d) =>
      `- **${d.mesa}**${d.agente ? ` — agente ${d.agente}` : ' — sem agente'}${d.sala ? ` · sala ${d.sala}` : ''}${d.descricao ? ` · ${d.descricao}` : ''} · ${d.ocupada ? 'trabalhando agora' : d.status}${d.naFila ? ` · ${d.naFila} na fila` : ''}`);
    const mem = this.state.officeMemory;
    const blocks = Object.entries(mem.projects).map(([id, b]) => `### ${this.state.projects.find((p) => p.id === id)?.name || 'Projeto removido'}\n${b.text}`);
    const today = this.state.reports[this.day()] || {};
    const reports = Object.entries(today).map(([id, r]) => `### ${this.state.projects.find((p) => p.id === id)?.name || 'Projeto'} (${r.agent || 'agente'})\n${r.text}`);
    return [
      '# Você é a secretária do escritório (Techtie Hub)',
      'Seu trabalho é receber demandas do usuário (por exemplo, mensagens e tarefas do Bitrix), organizar o que for pedido ' +
      '(como criar tarefas, usando as ferramentas do Bitrix quando disponíveis) e **passar a demanda para a mesa certa** com a ferramenta ' +
      'delegar. Você não faz o trabalho técnico dos projetos e não acompanha a conversa da mesa depois de delegar: o usuário acompanha e responde lá.',
      'Ao delegar, escreva um pedido completo e autossuficiente para o agente da mesa: contexto, o problema, o que fazer, critérios de pronto, ' +
      'e links/IDs (por exemplo, o número da tarefa criada no Bitrix e quem relatou). A mesa pode ser indicada pelo nome do projeto ou do agente. ' +
      'Se não tiver certeza de qual mesa é, use as ferramentas listar_mesas e ler_mesa. Depois de delegar, diga ao usuário em uma frase para qual mesa foi.',
      `Hoje é ${this.day()}.`,
      '## Mesas do escritório', desks.join('\n') || '(nenhuma)',
      ...(peers.length ? ['## Outras secretárias',
        'Você pode ler (ler_mesa) e passar demandas (delegar) para elas, igual às demais mesas. Faça isso só quando o assunto for delas ' +
        'ou o usuário pedir, e nunca devolva a demanda a quem acabou de te mandar: seria um ciclo sem fim.', peers.join('\n')] : []),
      '## Memória do escritório', mem.general?.trim() || '(sem notas gerais)', ...blocks,
      '## Relatórios de hoje', reports.join('\n\n') || '(nenhum relatório enviado hoje)',
      '## Recados das mesas (hoje)', this.state.inbox.filter((m) => this.day(m.at) === this.day())
        .map((m) => `- ${this.state.projects.find((p) => p.id === m.projectId)?.name || 'Mesa'}${m.agent ? ` (${m.agent})` : ''}: ${m.text}`).join('\n') || '(nenhum)',
    ].join('\n\n');
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
    // pedido do hub em andamento nesta mesa: o runner já informa o status. O hook da sessão dele
    // (que chega antes de o hub saber o id) mandaria "ocioso" e o agente largaria a mesa pensando
    if (this.live[project.id]) return { ignored: 'mesa rodando pelo hub' };
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

  // ---------- Servidores MCP ----------
  // Guardados com URL, cabeçalhos e variáveis criptografados. Cada servidor vale para todas as
  // mesas (projects: 'all') ou para uma lista de mesas; enabled liga/desliga sem apagar.

  // Versão para a tela: segredos mascarados.
  // Segredos guardados que não abrem (chave HUB_SECRET_KEY trocada depois de cadastrar).
  mcpLost(s) {
    const lost = (v) => typeof v === 'string' && v.startsWith('enc:') && !this.secrets.decrypt(v);
    return [
      ...(lost(s.url) ? ['URL'] : []),
      ...Object.entries({ ...s.headers, ...s.env }).filter(([, v]) => lost(v)).map(([k]) => k),
    ];
  }

  mcpPublic() {
    const secret = (v) => mask(this.secrets.decrypt(v));
    return this.state.mcpServers.map((s) => ({
      id: s.id, name: s.name, type: s.type, enabled: s.enabled !== false, projects: s.projects || 'all',
      url: s.url ? secret(s.url) : undefined,
      command: s.command, args: s.args || [],
      headers: Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [k, secret(v)])),
      env: Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, secret(v)])),
      lastTest: s.lastTest || null,
      lost: this.mcpLost(s), // precisam ser digitados de novo
    }));
  }

  // Configuração pronta para o Claude Agent SDK (segredos abertos) — só vai para o conector.
  // ${NOME} na URL, cabeçalhos, argumentos e variáveis vira o valor da variável do escritório
  mcpConfig(server) {
    const vars = this.varsFor(null);
    const expand = (t) => String(t ?? '').replace(/\$\{([A-Za-z_]\w*)\}/g, (m, n) => vars[n] ?? m);
    const open = (map) => Object.fromEntries(Object.entries(map || {}).map(([k, v]) => [k, expand(this.secrets.decrypt(v))]));
    if (server.type === 'stdio') return { type: 'stdio', command: server.command, args: (server.args || []).map(expand), env: open(server.env) };
    return { type: server.type, url: expand(this.secrets.decrypt(server.url)), headers: open(server.headers) };
  }

  // ---------- Variáveis de ambiente do escritório ----------
  // valor mascarado para o navegador; lost = guardado com outra HUB_SECRET_KEY
  varsPublic() {
    return this.state.vars.map((v) => ({
      id: v.id, name: v.name, description: v.description || '', projects: v.projects || 'all',
      value: mask(this.secrets.decrypt(v.value)),
      lost: !this.secrets.decrypt(v.value),
    }));
  }

  // variáveis que valem para uma mesa: { NOME: valor } (abertas, só para o conector); null = todas
  varsFor(projectId) {
    const out = {};
    for (const v of this.state.vars) {
      if (projectId && v.projects !== 'all' && !v.projects.includes(projectId)) continue;
      const value = this.secrets.decrypt(v.value);
      if (value) out[v.name] = value;
    }
    return out;
  }

  // o agente conhece os nomes, nunca os valores
  varsContext(projectId) {
    const list = this.state.vars.filter((v) => v.projects === 'all' || v.projects.includes(projectId));
    if (!list.length) return '';
    return [
      '## Variáveis de ambiente do escritório',
      'Já estão definidas no ambiente (use $NOME no terminal, process.env.NOME no Node ou os.environ["NOME"] no Python). ' +
      'Use-as em vez de pedir as credenciais ao usuário, e nunca escreva os valores em arquivos, commits ou respostas.',
      list.map((v) => `- ${v.name}${v.description ? ` — ${v.description}` : ''}`).join('\n'),
    ].join('\n\n');
  }

  // MCPs que valem para uma mesa: { nome: configuração }
  mcpFor(projectId) {
    const out = {};
    for (const s of this.state.mcpServers) {
      if (s.enabled === false) continue;
      if (s.projects && s.projects !== 'all' && !s.projects.includes(projectId)) continue;
      out[s.name] = this.mcpConfig(s);
    }
    return out;
  }

  // ---------- Imagens dos pedidos (data/offices/<id>/uploads/) ----------
  saveUpload(buffer, ext) {
    const dir = path.join(this.dir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = crypto.randomBytes(12).toString('hex') + ext;
    fs.writeFileSync(path.join(dir, name), buffer);
    return name;
  }

  // nome seguro (sem caminhos) de um arquivo que existe neste escritório
  hasUpload(name) {
    return /^[a-f0-9]{24}\.(png|jpg|gif|webp)$/.test(String(name)) && fs.existsSync(path.join(this.dir, 'uploads', name));
  }

  uploadPath(name) {
    return this.hasUpload(name) ? path.join(this.dir, 'uploads', name) : null;
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

module.exports = { Office, HttpError, STATUSES, FLOORS, AREAS, WALLS, DECOR, MAX_DECOR };

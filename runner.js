// Roda o Claude (via Claude Agent SDK) na pasta de cada mesa. Vive no CONECTOR, no PC
// do usuário; a conversa, a memória e as sessões ficam no hub (o runner recebe uma
// cópia da conversa a cada pedido e manda as novidades de volta).
//
// Pedidos de permissão e perguntas (AskUserQuestion) ficam pendentes até o usuário
// responder pelo hub. Continuidade entre PCs: a sessão inteira é espelhada no hub
// (sessionStore), então pode ser retomada em outro computador e outra pasta; a
// "memória" é um resumo do projeto usado em sessões novas.
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const git = require('./git');

let sdk;
const loadSdk = async () => (sdk ??= await import('@anthropic-ai/claude-agent-sdk'));

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEMORY_SYSTEM = 'Você mantém a memória de trabalho de um agente de programação que trabalha num projeto ' +
  'ao longo de várias sessões e computadores. Responda somente com a memória atualizada, em Markdown e em português, sem introdução.';

class Runner {
  // env: { id, name } deste PC; store: SessionStore (no hub)
  // hub: { push(projectId, role, text), update(projectId, fields),
  //        status(projectId, status, message, log), live(projectId, live|null),
  //        usage(partial) — limite de uso da conta Claude deste PC (mescla com o que já tem) }
  constructor({ env, store, hub, describeTool }) {
    Object.assign(this, { env, store, hub, describeTool });
    this.runs = new Map(); // projectId -> { running, pending, abort }
    this.chats = new Map(); // projectId -> cópia local da conversa durante o pedido
  }

  // ---------- Conversa (cópia local + avisos ao hub) ----------
  push(projectId, role, text, images) {
    this.chats.get(projectId)?.entries.push({ t: Date.now(), role, text, ...(images?.length && { images }) });
    this.hub.push(projectId, role, text, images);
  }

  update(projectId, fields) {
    Object.assign(this.chats.get(projectId) || {}, fields);
    this.hub.update(projectId, fields);
  }

  isRunning(projectId) {
    return !!this.runs.get(projectId)?.running;
  }

  // O que o navegador precisa saber de um pedido em andamento.
  liveOf(projectId) {
    const run = this.runs.get(projectId);
    if (!run?.running) return null;
    const p = run.pending;
    return {
      running: true,
      model: run.model || null,
      // o que está acontecendo agora (age: há quanto tempo, em ms — o relógio de cada PC é diferente)
      phase: run.phase && { kind: run.phase.kind, name: run.phase.name, age: Date.now() - run.phase.since },
      pending: p && {
        id: p.id,
        toolName: p.toolName,
        summary: p.toolName === 'AskUserQuestion' ? 'Tem uma pergunta' : this.describeTool(p.toolName, p.input),
        detail: p.toolName === 'AskUserQuestion' ? '' : this.preview(p.toolName, p.input),
        questions: p.toolName === 'AskUserQuestion' ? p.input.questions : undefined,
        canRemember: p.suggestions.length > 0,
      },
    };
  }

  emitLive(projectId) {
    this.hub.live(projectId, this.liveOf(projectId));
  }

  // depois de reconectar ao hub: reenvia o que está rodando
  // tudo o que está rodando neste PC (enviado ao hub a cada reconexão)
  allLive() {
    const out = {};
    for (const id of this.runs.keys()) if (this.isRunning(id)) out[id] = this.liveOf(id);
    return out;
  }

  preview(name, input = {}) {
    if (input.command) return clip(input.command, 800);
    if (name === 'Edit' && input.file_path) return `${input.file_path}\n\n- ${clip(input.old_string, 300)}\n+ ${clip(input.new_string, 300)}`;
    if (name === 'Write' && input.file_path) return `${input.file_path}\n\n${clip(input.content, 600)}`;
    if (input.file_path) return input.file_path;
    if (input.url) return input.url;
    return clip(JSON.stringify(input, null, 2), 600);
  }

  // ---------- Execução ----------
  // project.folder = pasta da mesa NESTE PC; chat = conversa atual (vinda do hub).
  // Devolve logo: o andamento chega ao hub pelos eventos.
  // attachments: { images: [{ mediaType, data }] (base64), imageRefs: nomes guardados no hub }
  send(project, text, chat, { images = [], imageRefs = [] } = {}) {
    if (this.isRunning(project.id)) throw new Error('o agente ainda está trabalhando nesta mesa');
    chat = { entries: [], ...chat };
    this.chats.set(project.id, chat);
    const run = {
      running: true, pending: null, abort: new AbortController(),
      phase: { kind: 'thinking', since: Date.now() },
      mode: project.permissionMode || '', // modo de permissão da mesa (pode mudar no meio: setMode)
    };
    this.runs.set(project.id, run);
    this.push(project.id, 'user', text, imageRefs);
    this.hub.status(project.id, 'trabalhando', text, true);
    this.emitLive(project.id);

    (async () => {
      try {
        // sessões criadas antes do espelhamento só existem no disco do PC onde nasceram
        if (chat.sessionId && !(await this.store.has(chat.sessionId))) await this.importLocalSession(project.id);

        let prompt = text;
        const moved = chat.sessionId && chat.lastFolder &&
          (chat.lastEnv !== this.env.id || path.resolve(chat.lastFolder) !== path.resolve(project.folder));
        if (moved) {
          const where = chat.lastEnv !== this.env.id ? `no computador "${chat.lastEnvName || 'outro PC'}"` : 'em outra pasta';
          this.push(project.id, 'system', `Continuando a conversa neste PC (${this.env.name}). Antes estava ${where}.`);
          prompt = `[Techtie Hub] Esta conversa continua agora em outro ambiente: computador "${this.env.name}", ` +
            `pasta de trabalho ${project.folder} (antes: ${chat.lastFolder}, ${where}). Caminhos de arquivos citados ` +
            `antes nesta conversa podem não valer mais — use a pasta atual. O código pode ter mudado desde a última vez.\n\n${text}`;
        }

        let ok = await this.runQuery(project, prompt, run, images);
        if (ok === 'resume-failed') {
          // plano B: sessão nova, com a memória atualizada a partir do histórico
          this.push(project.id, 'system', 'Não consegui retomar a sessão completa — continuando com a memória do agente.');
          await this.refreshMemory(project, chat).then((m) => this.update(project.id, m)).catch(() => {});
          this.update(project.id, { sessionId: null });
          ok = await this.runQuery(project, text, run, images);
        }
        if (ok === true) {
          this.update(project.id, {
            lastCommit: (await git.head(project.folder)) || chat.lastCommit || null,
            lastEnv: this.env.id, lastEnvName: this.env.name, lastFolder: project.folder,
          });
        }
      } catch (e) {
        if (!run.abort.signal.aborted) {
          this.push(project.id, 'system', `Erro: ${e.message}`);
          this.hub.status(project.id, 'bloqueado', 'Erro: ' + clip(e.message, 120), true);
        }
      } finally {
        if (run.abort.signal.aborted) {
          this.push(project.id, 'system', 'Interrompido por você.');
          this.hub.status(project.id, 'ocioso', 'Parou', true);
        }
        run.running = false;
        run.pending = null;
        this.emitLive(project.id);
      }
    })();
    return { ok: true };
  }

  // Uma rodada do Claude. Devolve true (sucesso), false (terminou com erro)
  // ou 'resume-failed' (a sessão salva não pôde ser retomada).
  async runQuery(project, prompt, run, images = []) {
    const { query } = await loadSdk();
    const chat = this.chats.get(project.id);
    const resuming = !!chat.sessionId;
    if (!resuming) this.update(project.id, { sessionAppend: this.memoryPrompt(chat) });
    // MCPs do hub para esta mesa + as ferramentas do escritório, se for a secretária
    const mcp = { ...(project.mcpServers || {}) };
    if (project.office) mcp.escritorio = await this.officeTools(project);
    let started = false, success = false;
    try {
      const q = query({
        // com imagens, o pedido vai como mensagem da API do Claude: blocos de imagem + o texto
        prompt: images.length ? (async function* () {
          yield {
            type: 'user',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [
                ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
                { type: 'text', text: prompt },
              ],
            },
          };
        })() : prompt,
        options: {
          cwd: project.folder,
          resume: chat.sessionId || undefined,
          sessionStore: this.store,
          // snapshot:false = o prompt de sistema é montado a cada pedido, com a pasta e o
          // git do PC atual (gravado na sessão, ele carregaria a pasta do PC antigo)
          systemPrompt: {
            type: 'preset', preset: 'claude_code', snapshot: false,
            append: [project.office?.context, chat.sessionAppend].filter(Boolean).join('\n\n') || undefined,
          },
          // modelo e esforço escolhidos para o agente; vazio = o padrão do Claude Code deste PC
          model: project.model || undefined,
          effort: project.effort || undefined,
          // perguntas de decisão (AskUserQuestion) continuam chegando ao usuário em qualquer modo
          permissionMode: project.permissionMode || 'default',
          allowDangerouslySkipPermissions: project.permissionMode === 'bypassPermissions',
          // servidores MCP configurados no hub para esta mesa (somam-se aos do Claude Code do PC)
          mcpServers: Object.keys(mcp).length ? mcp : undefined,
          // variáveis do escritório (webhooks, credenciais…) somadas às do PC
          env: Object.keys(project.env || {}).length ? { ...process.env, ...project.env } : undefined,
          abortController: run.abort,
          canUseTool: (name, input, opts) => this.ask(project.id, run, name, input, opts),
        },
      });
      for await (const m of q) {
        if (m.type === 'assistant') started = true;
        if (m.type === 'result') success = m.subtype === 'success';
        this.handle(project.id, m);
      }
    } catch (e) {
      if (resuming && !started && !run.abort.signal.aborted) return 'resume-failed';
      throw e;
    }
    return success;
  }

  // fase atual (pensando / esperando uma ferramenta), mostrada com cronômetro na mesa
  setPhase(projectId, kind, name) {
    const run = this.runs.get(projectId);
    if (!run?.running) return;
    run.phase = { kind, name, since: Date.now() };
    this.emitLive(projectId);
  }

  handle(projectId, m) {
    // atualização de limite de uso, de graça, durante um pedido normal (sem chamada extra)
    if (m.type === 'rate_limit_event') {
      const i = m.rate_limit_info;
      // utilization é opcional: alguns eventos só avisam status, sem trazer a porcentagem de novo —
      // nesse caso não mexe no que já estava mostrando (melhor manter o valor antigo que apagar a barra)
      if (i.utilization != null && ['five_hour', 'seven_day'].includes(i.rateLimitType)) {
        // resetsAt vem em épocas (ms ou s, conforme a versão do SDK): se for pequeno demais pra ser ms, é segundos
        const resetsAt = i.resetsAt ? new Date(i.resetsAt < 1e12 ? i.resetsAt * 1000 : i.resetsAt).toISOString() : null;
        const field = i.rateLimitType === 'five_hour' ? 'fiveHour' : 'sevenDay';
        this.hub.usage({ [field]: { percent: i.utilization, resetsAt } });
      }
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') {
      this.update(projectId, { sessionId: m.session_id, lastModel: m.model });
      const run = this.runs.get(projectId);
      if (run) run.model = m.model;
      this.emitLive(projectId);
    } else if (m.type === 'assistant') {
      let tool = null;
      for (const c of m.message.content) {
        if (c.type === 'text' && c.text.trim()) this.push(projectId, 'assistant', c.text);
        if (c.type === 'tool_use' && c.name !== 'AskUserQuestion') {
          const what = this.describeTool(c.name, c.input);
          this.push(projectId, 'tool', what);
          this.hub.status(projectId, 'trabalhando', what, false);
          tool = c.name.replace(/^mcp__/, '').replace(/__/g, ' › '); // mcp__bitrix__get_task → bitrix › get_task
        }
      }
      this.setPhase(projectId, tool ? 'tool' : 'thinking', tool);
    } else if (m.type === 'user') {
      this.setPhase(projectId, 'thinking'); // a ferramenta respondeu: o Claude volta a pensar
    } else if (m.type === 'result') {
      if (m.subtype === 'success') {
        this.hub.status(projectId, 'concluido', 'Terminou — aguardando você', true);
      } else {
        this.push(projectId, 'system', `Parou com erro (${m.subtype}).`);
        this.hub.status(projectId, 'bloqueado', `Parou com erro (${m.subtype})`, true);
      }
    }
  }

  async importLocalSession(projectId) {
    const chat = this.chats.get(projectId);
    try {
      const { importSessionToStore } = await loadSdk();
      await importSessionToStore(chat.sessionId, this.store);
    } catch {
      // o arquivo local não está neste PC: segue com sessão nova + memória
      this.update(projectId, { sessionId: null });
    }
  }

  // canUseTool: fica esperando até o usuário responder no hub.
  // Mudança de modo com o pedido já rodando (o SDK só aplica o modo no início): a partir
  // daqui o runner mesmo aprova o que o novo modo libera, inclusive o pedido em aberto.
  setMode(projectId, mode) {
    const run = this.runs.get(projectId);
    if (!run?.running) return { ok: true };
    run.mode = mode;
    const p = run.pending;
    if (p && this.autoAllowed(run, p.toolName)) {
      run.pending = null;
      this.push(projectId, 'system', `Liberado pelo modo da mesa: ${this.describeTool(p.toolName, p.input)}`);
      this.hub.status(projectId, 'trabalhando', 'Continuando…', false);
      p.resolve({ behavior: 'allow', updatedInput: p.input });
      this.emitLive(projectId);
    }
    return { ok: true };
  }

  autoAllowed(run, toolName) {
    if (toolName === 'AskUserQuestion') return false; // decisões são sempre do usuário
    if (toolName.startsWith('mcp__escritorio__')) return true; // ferramentas da secretária: só mexem no hub
    if (run.mode === 'bypassPermissions') return true;
    return run.mode === 'acceptEdits' && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(toolName);
  }

  ask(projectId, run, toolName, input, { signal, suggestions } = {}) {
    if (this.autoAllowed(run, toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    return new Promise((resolve) => {
      const id = crypto.randomBytes(4).toString('hex');
      run.pending = { id, toolName, input, suggestions: suggestions || [], resolve };
      const isQuestion = toolName === 'AskUserQuestion';
      this.hub.status(projectId, 'bloqueado',
        isQuestion ? 'Tem uma pergunta para você' : 'Pedindo permissão: ' + this.describeTool(toolName, input), true);
      this.emitLive(projectId);
      signal?.addEventListener('abort', () => {
        if (run.pending?.id !== id) return;
        run.pending = null;
        resolve({ behavior: 'deny', message: 'Cancelado' });
      });
    });
  }

  answer(projectId, { requestId, decision, answers, message }) {
    const run = this.runs.get(projectId);
    const p = run?.pending;
    if (!p || p.id !== requestId) throw new Error('esse pedido já foi respondido');
    run.pending = null;

    let result;
    if (p.toolName === 'AskUserQuestion') {
      // respostas chegam na ordem das perguntas; a chave tem que ser o texto exato da pergunta
      const map = {};
      p.input.questions.forEach((q, i) => {
        const a = Array.isArray(answers) ? answers[i] : answers?.[q.question];
        if (a) map[q.question] = [].concat(a).join(', ');
      });
      result = { behavior: 'allow', updatedInput: { questions: p.input.questions, answers: map } };
      this.push(projectId, 'user', Object.entries(map).map(([q, a]) => `${q}\n→ ${a}`).join('\n\n'));
    } else if (decision === 'deny') {
      result = { behavior: 'deny', message: message || 'O usuário negou essa ação.' };
      this.push(projectId, 'system', `Você negou: ${this.describeTool(p.toolName, p.input)}`);
    } else {
      result = { behavior: 'allow', updatedInput: p.input };
      if (decision === 'always') {
        const local = p.suggestions.filter((s) => s.destination === 'localSettings');
        result.updatedPermissions = local.length ? local : p.suggestions;
      }
      this.push(projectId, 'system', `Você ${decision === 'always' ? 'permitiu sempre' : 'permitiu'}: ${this.describeTool(p.toolName, p.input)}`);
    }
    this.hub.status(projectId, 'trabalhando', 'Continuando…', false);
    p.resolve(result);
    this.emitLive(projectId);
    return { ok: true };
  }

  stop(projectId) {
    const wasRunning = this.isRunning(projectId);
    this.runs.get(projectId)?.abort.abort();
    return { ok: true, wasRunning }; // false: o hub achava que rodava, mas aqui já tinha acabado
  }

  // ---------- Ferramentas do escritório ----------
  // Rodam aqui no conector e falam com o hub (servidor MCP "escritorio"). Toda mesa tem as básicas
  // (relatório, memória, recado, ver o escritório); a secretária também lê mesas e delega.
  async officeTools(project) {
    const { createSdkMcpServer, tool } = await loadSdk();
    const { z } = require('zod');
    const isSec = project.office.role === 'secretaria';
    const call = (method, sub, data = {}) => this.hub.office(method, sub, { mesa_id: project.id, ...data });
    const reply = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
    const safe = (fn) => async (args) => {
      try {
        return reply(await fn(args || {}));
      } catch (e) {
        return { ...reply('Erro: ' + e.message), isError: true };
      }
    };
    return createSdkMcpServer({
      name: 'escritorio',
      version: '1.0.0',
      tools: [
        tool('listar_mesas', 'Lista as mesas (projetos) do escritório: agente responsável, descrição, sala e status.', {},
          safe(() => call('GET', 'desks'))),
        tool('ler_memoria_escritorio', 'Lê a memória do escritório: notas gerais e o resumo de cada projeto.', {},
          safe(() => call('GET', 'memory'))),
        ...(isSec ? this.secretaryOnly(tool, z, call, safe) : [
          tool('enviar_relatorio', 'Envia o relatório do dia desta mesa para a secretária. Escreva você mesmo, em tópicos: o que foi feito hoje, ' +
            'o que ficou pendente, bloqueios e próximos passos.',
            { texto: z.string().describe('o relatório completo') },
            safe(({ texto }) => call('POST', 'report', { texto }))),
          tool('salvar_memoria_projeto', 'Salva o resumo do que você sabe sobre este projeto (memória da mesa) e, por padrão, também na memória ' +
            'do escritório. Escreva a memória completa (substitui a anterior): projeto, feito até agora, decisões, próximos passos.',
            { texto: z.string(), enviar_para_escritorio: z.boolean().optional().describe('padrão: sim') },
            safe(({ texto, enviar_para_escritorio }) => call('POST', 'project-memory', { texto, enviar: enviar_para_escritorio !== false }))),
          tool('avisar_secretaria', 'Deixa um recado para a secretária (ela vê no próximo pedido dela). Use para avisar que terminou algo, ' +
            'pedir que uma demanda vá para outra mesa, ou reportar um bloqueio.',
            { mensagem: z.string() },
            safe(({ mensagem }) => call('POST', 'inbox', { mensagem }))),
        ]),
      ],
    });
  }

  secretaryOnly(tool, z, call, safe) {
    return [
        tool('ler_mesa', 'Detalhes de uma mesa: memória do projeto e últimas mensagens. Aceita o nome da mesa ou do agente.',
          { mesa: z.string().describe('nome da mesa/projeto ou do agente') },
          safe(({ mesa }) => call('GET', 'desk', { q: mesa }))),
        tool('delegar', 'Passa uma demanda para a mesa certa: o agente daquela mesa começa a trabalhar nela, ou ela entra na fila se ' +
          'a mesa estiver ocupada. O pedido deve ser completo e autossuficiente (contexto, o que fazer, critérios, links/IDs).',
          { mesa: z.string().describe('nome da mesa/projeto ou do agente responsável'), pedido: z.string().describe('a demanda completa para o agente') },
          safe(({ mesa, pedido }) => call('POST', 'delegate', { mesa, pedido }))),
        tool('ler_relatorios', 'Lê os relatórios do dia enviados pelas mesas.',
          { dia: z.string().optional().describe('AAAA-MM-DD; vazio = hoje') },
          safe(({ dia }) => call('GET', 'reports', dia ? { dia } : {}))),
        tool('listar_equipe', 'Lista as pessoas da equipe (cada uma com o próprio escritório) e se têm secretária.', {},
          safe(() => call('GET', 'team'))),
        tool('enviar_para_pessoa', 'Manda uma demanda para a secretária do escritório de outra pessoa da equipe. Só use quando o usuário pedir. ' +
          'O pedido deve ser completo e autossuficiente: a outra secretária não vê esta conversa.',
          { pessoa: z.string().describe('nome da pessoa da equipe'), pedido: z.string() },
          safe(({ pessoa, pedido }) => call('POST', 'team-send', { pessoa, pedido }))),
        tool('listar_tarefas', 'Lista as tarefas do módulo de Tarefas (as do usuário e as compartilhadas com ele).',
          { status: z.enum(['todo', 'doing', 'done']).optional() },
          safe(({ status }) => call('GET', 'tasks', status ? { status } : {}))),
        tool('criar_tarefa', 'Cria uma tarefa no módulo de Tarefas, opcionalmente compartilhada com pessoas da equipe.',
          {
            titulo: z.string(), descricao: z.string().optional(), prioridade: z.enum(['baixa', 'normal', 'alta']).optional(),
            prazo: z.string().optional().describe('AAAA-MM-DD'), bitrix: z.string().optional().describe('link ou número da tarefa no Bitrix'),
            com: z.array(z.string()).optional().describe('nomes de colegas que também veem a tarefa'),
          },
          safe((a) => call('POST', 'task', a))),
        tool('atualizar_tarefa', 'Muda status, prazo, texto ou compartilha uma tarefa (com = colegas a adicionar).',
          {
            id: z.string(), titulo: z.string().optional(), descricao: z.string().optional(), status: z.enum(['todo', 'doing', 'done']).optional(),
            prioridade: z.enum(['baixa', 'normal', 'alta']).optional(), prazo: z.string().optional(), bitrix: z.string().optional(), com: z.array(z.string()).optional(),
          },
          safe((a) => call('POST', 'task-update', a))),
        tool('delegar_tarefa', 'Passa uma tarefa para o agente de uma mesa (marca a tarefa como em andamento e anota para quem foi).',
          { id: z.string(), mesa: z.string().describe('nome da mesa/projeto ou do agente') },
          safe(({ id, mesa }) => call('POST', 'task-delegate', { id, mesa }))),
        tool('anotar_memoria_escritorio', 'Acrescenta uma nota às notas gerais da memória do escritório.',
          { nota: z.string() },
          safe(({ nota }) => call('POST', 'note', { nota }))),
    ];
  }

  // ---------- Limite de uso da conta Claude (barra no hub) ----------
  // Abre uma sessão descartável em modo "entrada contínua" (só assim dá pra chamar o método de
  // controle usage_EXPERIMENTAL), espera ela iniciar (não gasta chamada de modelo) e já interrompe:
  // nenhuma mensagem de usuário chega a ser enviada, então isto não consome tokens nem a cota de uso.
  async checkUsage(log = () => {}) {
    const { query } = await loadSdk();
    const q = query({
      // nunca produz valor: a sessão fica esperando, só para abrir o canal de controle
      prompt: (async function* () { await new Promise(() => {}); })(),
      options: { cwd: os.tmpdir(), tools: [], settingSources: [], persistSession: false, includePartialMessages: false },
    });
    // consome o stream em paralelo (senão os control requests abaixo nunca recebem resposta:
    // o transporte do SDK despacha as respostas de dentro do loop de leitura das mensagens)
    const pump = (async () => { try { for await (const _ of q) { /* nada a fazer com elas aqui */ } } catch {} })();
    // sem login, sem rede ou um CLI que nunca inicia: não pode travar o loop periódico para sempre
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { log('timeout esperando a inicialização'); resolve(null); }, 15000); });
    const work = (async () => {
      try {
        log('aguardando initializationResult()…');
        await q.initializationResult(); // a "primeira resposta de conexão": não gasta chamada de modelo
        log('inicializado; chamando usage_EXPERIMENTAL…');
        const r = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
        log('usage_EXPERIMENTAL respondeu: rate_limits_available=' + r.rate_limits_available +
          ' subscription_type=' + r.subscription_type + ' limits=' + JSON.stringify(r.rate_limits?.limits));
        if (!r.rate_limits_available || !r.rate_limits) return null;
        // "session" (5h) e "weekly"/"weekly_all" (7 dias): usa o grupo, mais estável que o kind exato;
        // dentro de cada grupo, a linha "ativa" é a que o próprio servidor destaca (ex.: a mais cheia)
        const row = (group) => {
          const rows = (r.rate_limits.limits || []).filter((l) => l.group === group);
          return rows.find((l) => l.is_active) || rows[0] || null;
        };
        const fiveHour = row('session'), sevenDay = row('weekly');
        return {
          subscription: r.subscription_type,
          fiveHour: fiveHour && { percent: fiveHour.percent, resetsAt: fiveHour.resets_at },
          sevenDay: sevenDay && { percent: sevenDay.percent, resetsAt: sevenDay.resets_at },
        };
      } catch (e) {
        log('erro: ' + e.message); // sem login, sem plano com limites, ou erro de rede: só não mostra a barra
        return null;
      }
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer); // senão o aviso de timeout dispara mesmo após o sucesso
      // fecha primeiro (senão "pump" nunca termina, já que ele só para quando o generator fecha)
      await q.interrupt().catch(() => {});
      await q.return?.().catch(() => {});
      await Promise.race([pump, sleep(2000)]).catch(() => {});
    }
  }

  // Relatório do dia para a secretária (chamada curta ao Claude, sem ferramentas).
  async dailyReport(project, entries) {
    const label = { user: 'Usuário', assistant: 'Agente', tool: 'Ação', system: 'Hub' };
    const convo = entries.map((e) => `${label[e.role] || e.role}: ${clip(e.text, e.role === 'tool' ? 150 : 1200)}`).join('\n\n').slice(-60000);
    const prompt = `Projeto: ${project.name}${project.description ? ` — ${project.description}` : ''}\n\n` +
      `O que aconteceu hoje nesta mesa:\n<conversa>\n${convo}\n</conversa>\n\n` +
      'Escreva o relatório do dia deste projeto para a secretária do escritório, em tópicos curtos: o que foi feito, o que ficou ' +
      'pendente, bloqueios e próximos passos. Seja objetivo (até ~200 palavras).';
    const { query } = await loadSdk();
    let out = '';
    for await (const m of query({
      prompt,
      options: {
        cwd: os.tmpdir(), tools: [], maxTurns: 1, settingSources: [], persistSession: false,
        systemPrompt: 'Você escreve relatórios diários curtos e objetivos sobre o trabalho de um agente de programação. Responda só com o relatório, em português.',
      },
    })) {
      if (m.type === 'result' && m.subtype === 'success') out = m.result || '';
    }
    if (!out.trim()) throw new Error('não consegui gerar o relatório');
    return { text: out.trim() };
  }

  // ---------- Memória do agente ----------
  memoryPrompt(chat) {
    if (!chat.memory?.trim()) return '';
    return '# Memória deste projeto (Techtie Hub)\n' +
      'Você já trabalhou neste projeto antes, talvez em outro computador. Este é o resumo do que você sabe ' +
      `até agora. Use como contexto, mas confira o código atual antes de agir.${chat.lastCommit ? ` Último commit em que você trabalhou: ${chat.lastCommit}.` : ''}\n\n` +
      chat.memory.trim();
  }

  // Junta a memória atual com o que aconteceu desde a última atualização (uma chamada
  // curta ao Claude, sem ferramentas e sem as configurações/hooks do usuário).
  // Devolve { memory, memoryAt } — quem chamou salva.
  async refreshMemory(project, chat) {
    const fresh = (chat.entries || []).filter((e) => e.t > (chat.memoryAt || 0));
    if (!fresh.length) return { memory: chat.memory || '', memoryAt: chat.memoryAt || null };
    const label = { user: 'Usuário', assistant: 'Agente', tool: 'Ação', system: 'Hub' };
    const convo = fresh.map((e) => `${label[e.role] || e.role}: ${clip(e.text, e.role === 'tool' ? 150 : 1500)}${e.images?.length ? ` [${e.images.length} imagem(ns) anexada(s)]` : ''}`)
      .join('\n\n').slice(-60000);
    const prompt = `Projeto: ${project.name}${project.description ? ` — ${project.description}` : ''}\n\n` +
      `Memória atual:\n<memoria>\n${chat.memory?.trim() || '(vazia)'}\n</memoria>\n\n` +
      `O que aconteceu desde a última atualização:\n<conversa>\n${convo}\n</conversa>\n\n` +
      'Escreva a memória atualizada com estas seções: ## Projeto, ## Feito até agora, ## Decisões e preferências do usuário, ' +
      '## Em andamento e próximos passos, ## Observações. Seja conciso (até ~400 palavras): mantenha o que continua ' +
      'relevante e descarte o que ficou obsoleto.';
    const { query } = await loadSdk();
    let out = '';
    for await (const m of query({
      prompt,
      options: { cwd: os.tmpdir(), tools: [], maxTurns: 1, settingSources: [], persistSession: false, systemPrompt: MEMORY_SYSTEM },
    })) {
      if (m.type === 'result' && m.subtype === 'success') out = m.result || '';
    }
    if (!out.trim()) throw new Error('não consegui gerar a memória');
    return { memory: out.trim(), memoryAt: fresh[fresh.length - 1].t };
  }
}

module.exports = { Runner };

#!/usr/bin/env node
// Conector do Techtie Hub: roda os agentes NESTE PC para um hub (local ou na nuvem).
//
// Ele abre uma conexão de saída com o hub (não precisa de porta aberta), recebe comandos
// ("rode este pedido nesta pasta", "abra o seletor de pastas"...) e executa aqui, com o
// login do Claude Code deste computador. Conversas, memória e sessões ficam no hub.
//
// Uso:  node conector.js --hub https://meu-hub.com --codigo XXXX-XXXX [--nome "PC do escritório"]
//       O código aparece no hub em PC → Conectar um PC e vale 10 minutos. O conector troca
//       o código por um token só deste PC e salva; das próximas vezes basta: node conector.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const git = require('./git');
const ops = require('./local-ops');
const { Runner } = require('./runner');
const { RemoteSessionStore } = require('./remote-store');
const { describeTool } = require('./describe');
const { FILES, versionOf } = require('./connector-files');
const mcpLocal = require('./mcp-local');

const VERSION = versionOf(__dirname);
const RESTART_CODE = 75; // o "Iniciar Techtie.bat" reabre o conector quando ele sai com este código
// pasta de desenvolvimento (repositório git): nunca se sobrescreve com a versão do hub
const IS_REPO = fs.existsSync(path.join(__dirname, '.git'));

const HOME_DIR = path.join(os.homedir(), '.techtie-hub');
const ENV_FILE = process.env.HUB_ENV_FILE || path.join(HOME_DIR, 'ambiente.json');
const CONFIG_FILE = process.env.HUB_CONNECTOR_FILE || path.join(HOME_DIR, 'conector.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// Identidade deste PC (id + nome). Fica fora de qualquer pasta de dados: é do computador.
function loadEnv(file = ENV_FILE) {
  let env = readJson(file);
  if (!env?.id) {
    env = { id: 'e' + crypto.randomBytes(4).toString('hex'), name: os.hostname() };
    writeJson(file, env);
  }
  return env;
}

// Troca o código de pareamento (gerado no hub) pelo token permanente deste PC.
async function pair(hub, code, envFile = ENV_FILE) {
  const env = loadEnv(envFile);
  const res = await fetch(hub.replace(/\/$/, '') + '/api/connector/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Env': env.id },
    body: JSON.stringify({ code, name: env.name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `hub respondeu ${res.status}`);
  return data.token;
}

// hub: URL do hub; token: credencial deste PC (obtida com pair)
// embedded: conector dentro do próprio hub (modo local) — tem sempre a mesma versão do hub
function start({ hub, token, envFile = ENV_FILE, log = console.log, embedded = false }) {
  hub = hub.replace(/\/$/, '');
  const env = loadEnv(envFile);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Hub-Env': env.id };

  async function post(route, body) {
    const res = await fetch(hub + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `hub respondeu ${res.status}`);
    return data;
  }

  // Eventos vão em fila, na ordem em que aconteceram (a conversa não pode embaralhar).
  // Se o hub cair (redeploy, internet), a fila espera e reenvia: nenhum aviso se perde —
  // principalmente o "terminei", senão a mesa ficaria "trabalhando" para sempre.
  const queue = [];
  let flushing = false;
  const emit = (type, payload) => {
    // do andamento só importa o mais recente: descarta os da mesma mesa ainda não enviados
    if (type === 'live') {
      for (let i = queue.length - 1; i >= 1; i--) if (queue[i].type === 'live' && queue[i].projectId === payload.projectId) queue.splice(i, 1);
    }
    queue.push({ type, ...payload });
    flush();
  };
  async function flush() {
    if (flushing) return;
    flushing = true;
    let wait = 1000;
    while (queue.length) {
      try {
        await post('/api/connector/event', queue[0]);
        queue.shift();
        wait = 1000;
      } catch (e) {
        if (/pareado/.test(e.message)) { queue.length = 0; break; } // PC removido no hub: não adianta guardar
        await sleep(wait);
        wait = Math.min(wait * 2, 15000);
      }
    }
    flushing = false;
  }

  // último limite de uso conhecido (pra mesclar um evento parcial de rate_limit_event sem perder o outro campo)
  let lastUsage = {};
  const store = new RemoteSessionStore((op, body) => post('/api/connector/sessions/' + op, body));
  const runner = new Runner({
    env,
    store,
    describeTool,
    hub: {
      push: (projectId, role, text, images) => emit('chat-push', { projectId, role, text, images }),
      update: (projectId, fields) => emit('chat-update', { projectId, fields }),
      status: (projectId, status, message, logIt) => emit('status', { projectId, status, message, log: logIt }),
      live: (projectId, live) => emit('live', { projectId, live }),
      usage: (partial) => {
        lastUsage = { ...lastUsage, ...partial };
        emit('usage', { usage: lastUsage });
      },
      // ferramentas da secretária: consultas e delegação no escritório (com o token deste PC)
      office: async (method, sub, data = {}) => {
        const qs = method === 'GET' ? '?' + new URLSearchParams(data) : '';
        const res = await fetch(`${hub}/api/connector/office/${sub}${qs}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(data) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `hub respondeu ${res.status}`);
        return out;
      },
    },
  });

  const handlers = {
    run: ({ project, text, chat, images, imageRefs }) => {
      // a secretária não tem pasta de projeto: usa uma pasta própria neste PC
      if (project.folder === '@secretaria') {
        project.folder = path.join(HOME_DIR, 'secretaria');
        fs.mkdirSync(project.folder, { recursive: true });
      }
      if (!ops.isDir(project.folder)) throw new Error(`a pasta ${project.folder} não existe neste PC`);
      return runner.send(project, text, chat, { images, imageRefs });
    },
    answer: ({ projectId, ...body }) => runner.answer(projectId, body),
    stop: ({ projectId }) => runner.stop(projectId),
    memory: ({ project, chat }) => runner.refreshMemory(project, chat),
    report: ({ project, entries }) => runner.dailyReport(project, entries),
    git: ({ folder, last }) => git.status(folder, last),
    'folder-info': ({ folder }) => ops.folderInfo(folder),
    'pick-folder': () => ops.pickFolder(),
    'set-mode': ({ projectId, mode }) => runner.setMode(projectId, mode),
    'mcp-scan': ({ folders }) => mcpLocal.scan(folders),
    'mcp-test': ({ name, config }) => mcpLocal.test(name, config),
    open: ({ folder, app }) => ops.openFolder(folder, app),
    rename: ({ name }) => {
      env.name = name;
      writeJson(envFile, env);
      return env;
    },
  };

  async function handle({ id, type, payload }) {
    try {
      if (!handlers[type]) throw new Error('comando desconhecido: ' + type);
      const data = await handlers[type](payload || {});
      await post('/api/connector/reply', { id, ok: true, data: data ?? null });
    } catch (e) {
      await post('/api/connector/reply', { id, ok: false, error: e.message }).catch(() => {});
    }
  }

  // ---------- Atualização automática ----------
  // O hub avisou que tem versão nova: espera as tarefas em andamento terminarem, baixa os
  // arquivos, grava por cima e sai com RESTART_CODE (o .bat roda npm install e reabre).
  let updating = false;
  async function selfUpdate(target) {
    if (updating) return;
    updating = true;
    const marker = path.join(__dirname, '.atualizado-para');
    if (IS_REPO) {
      log(`Conector desatualizado em relação ao hub (${VERSION} → ${target}). Nesta pasta de repositório, atualize com: git pull`);
      return;
    }
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === target) {
      log('Já tentei atualizar para esta versão e continuo diferente; seguindo com a versão atual.');
      return;
    }
    while (Object.keys(runner.allLive()).length) await sleep(5000); // não interrompe ninguém
    try {
      log('Versão nova do conector no hub. Atualizando…');
      const res = await fetch(hub + '/api/connector/update', { headers });
      if (!res.ok) throw new Error(`hub respondeu ${res.status}`);
      const data = await res.json();
      for (const [name, content] of Object.entries(data.files || {})) {
        if (!/^[\w.-]+\.js$/.test(name)) continue; // só arquivos desta pasta, nada de caminhos
        fs.writeFileSync(path.join(__dirname, name), content);
      }
      if (data.packageJson) fs.writeFileSync(path.join(__dirname, 'package.json'), data.packageJson);
      fs.writeFileSync(marker, data.version || target);
      log('Conector atualizado. Reiniciando…');
      process.exit(RESTART_CODE);
    } catch (e) {
      log('Não consegui atualizar o conector agora:', e.message);
      updating = false;
    }
  }

  // ---------- Limite de uso da conta Claude (barra no hub) ----------
  // Confere ao conectar e a cada 10 minutos; sem chamada de modelo (checkUsage interrompe antes de
  // mandar qualquer mensagem). Só quando nada está rodando, pra não competir com um pedido de verdade.
  async function checkUsageIfIdle() {
    if (Object.keys(runner.allLive()).length) return;
    let r;
    try {
      r = await runner.checkUsage();
    } catch (e) {
      log('Não consegui ler o limite de uso da conta Claude:', e.message);
      return;
    }
    if (r) runner.hub.usage(r);
    else log('Limite de uso indisponível agora (conta sem plano com limites, sem login, ou o Claude Code não respondeu a tempo).');
  }
  checkUsageIfIdle();
  setInterval(checkUsageIfIdle, 10 * 60 * 1000);

  let stopped = false;
  (async function loop() {
    let wait = 1000;
    while (!stopped) {
      try {
        const res = await fetch(`${hub}/api/connector/stream?name=${encodeURIComponent(env.name)}&v=${VERSION}`, { headers });
        if (res.status === 401) {
          // removido no hub (ou pareado com outro hub): não adianta insistir rápido
          wait = 60000;
          throw new Error('este PC não está pareado com o hub; gere um código em PC → Conectar um PC e rode: node conector.js --codigo XXXX-XXXX');
        }
        if (!res.ok) throw new Error(`hub respondeu ${res.status}`);
        log(`Conectado ao hub ${hub} como "${env.name}" (conector ${VERSION})`);
        wait = 1000;
        // conta ao hub exatamente o que está rodando aqui (ele apaga o que ficou "fantasma")
        emit('live-sync', { lives: runner.allLive() });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            let event = 'message', data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (event === 'cmd' && data) handle(JSON.parse(data));
            if (event === 'update' && data && !embedded) selfUpdate(JSON.parse(data).version);
          }
        }
        log('Conexão com o hub encerrada.');
      } catch (e) {
        log(`Sem conexão com o hub (${e.message}). Tentando de novo em ${Math.round(wait / 1000)}s…`);
      }
      await sleep(wait);
      wait = Math.min(wait * 2, 30000);
    }
  })();

  return { env, runner, stop: () => (stopped = true) };
}

module.exports = { VERSION, start, pair, loadEnv, readJson, writeJson, ENV_FILE, CONFIG_FILE, HOME_DIR };

// ---------- Linha de comando ----------
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const arg = (name) => {
      const i = args.indexOf('--' + name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    if (arg('nome')) writeJson(ENV_FILE, { ...loadEnv(), name: arg('nome') });
    const saved = readJson(CONFIG_FILE) || {};
    const hub = arg('hub') || process.env.HUB_URL || saved.hub;
    let token = saved.hub === hub ? saved.token : null;
    if (arg('codigo')) {
      if (!hub) throw new Error('informe também --hub <endereço do hub>');
      token = await pair(hub, arg('codigo'));
      console.log('PC pareado com o hub.');
    }
    if (!hub || !token) {
      console.error('Uso: node conector.js --hub <endereço do hub> --codigo <XXXX-XXXX> [--nome "Nome deste PC"]');
      console.error('O código aparece no hub em: PC → Conectar um PC (vale 10 minutos).');
      process.exit(1);
    }
    writeJson(CONFIG_FILE, { hub, token }); // usado também pelo hub-hook.js e pelo report.js
    start({ hub, token });
  })().catch((e) => {
    console.error('Falha:', e.message);
    process.exit(1);
  });
}

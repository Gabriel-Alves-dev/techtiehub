// Techtie Hub — escritório em pixel art. Cada mesa é um projeto, cada personagem é um agente.
'use strict';

// ---------- Layout do mundo (em pixels "de mundo"; a tela multiplica por SCALE) ----------
const T = 16; // tamanho do tile
const CELL_W = 5, CELL_H = 5; // tiles por mesa
const WALL_H = 3; // parede do topo, em tiles
const DESK_X0 = 1;
const LOUNGE_W = 7;
const SPEED = 48; // px de mundo por segundo
const RUN_SPEED = 130; // indo para a mesa trabalhar
const IDLE_GRACE = 4000; // ms ocioso antes de largar a mesa

const STATUS = {
  trabalhando: { label: 'Trabalhando', color: '#3fbf7f' },
  ocioso: { label: 'Ocioso', color: '#9097b0' },
  bloqueado: { label: 'Bloqueado', color: '#e5534b' },
  concluido: { label: 'Concluído', color: '#4f8cff' },
};

const canvas = document.getElementById('office');
const canvas3d = document.getElementById('office3d'); // vista 3D (Three.js), só usada quando ligada
const mainCtx = canvas.getContext('2d');
let ctx = mainCtx; // na vista inclinada, a cena plana é desenhada num canvas auxiliar (troca de ctx)
const wrap = document.getElementById('office-wrap');
const tooltip = document.getElementById('tooltip');

let state = { rooms: [], projects: [], agents: [], log: [] };
let world = null; // geometria da sala atual (cresce com o número de mesas)
let SCALE = 3;
let zoom = load('hub.zoom'); // null = ajusta à tela; número = escala fixa
let roomId = load('hub.room'); // sala sendo exibida
let preferredEnv = load('hub.env'); // PC escolhido neste navegador para executar os pedidos
const runtime = new Map(); // agentId -> posição/animação
let selected = null; // { kind: 'project', id } — mesa da janela em foco
let hover = null;
let monitor = { hosts: [], configured: false, denied: false, at: 0 }; // resumo dos servidores (só a dona do hub)
let moveMode = false; // modo de mover mesas
let moving = null; // mesa sendo arrastada: { id, from, to, wx, wy }
let movePick = null; // toque: célula da mesa escolhida, esperando o destino
let pointerKind = 'mouse'; // último tipo de ponteiro (mouse arrasta; toque escolhe origem e destino)

// preferências do navegador (sala aberta, zoom, posição das janelas)
function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ---------- Salas ----------
const currentRoom = () => state.rooms.find((r) => r.id === roomId) || state.rooms[0];
const roomProjects = (rid = currentRoom()?.id) => state.projects.filter((p) => p.roomId === rid);

// Agentes desta sala: os que têm mesa aqui + os sem mesa (ficam no lounge da primeira sala).
function visibleAgents() {
  if (currentRoom()?.kind === 'servidor') return [];
  const first = currentRoom() === state.rooms[0];
  return state.agents.filter((a) => {
    const desk = deskOf(a.id);
    return desk ? desk.here : first;
  });
}

// Posição de cada mesa na grade (índice = fileira * colunas + coluna). O usuário arruma em room.slots;
// mesas sem posição válida (novas, ou fora da grade depois de reduzir as colunas) ocupam a primeira célula livre.
function layoutSlots(cols) {
  const saved = currentRoom()?.slots || {};
  const slotOf = new Map(), byslot = new Map();
  const list = roomProjects();
  for (const p of list) {
    const v = saved[p.id];
    if (!Number.isInteger(v?.c) || !Number.isInteger(v?.r) || v.c < 0 || v.c >= cols || v.r < 0) continue;
    const i = v.r * cols + v.c;
    if (byslot.has(i)) continue;
    slotOf.set(p.id, i); byslot.set(i, p);
  }
  let free = 0;
  const nextFree = () => { while (byslot.has(free)) free++; return free; };
  for (const p of list) if (!slotOf.has(p.id)) { const i = nextFree(); slotOf.set(p.id, i); byslot.set(i, p); }
  return { slotOf, byslot, free: nextFree() };
}

// Sala de servidores: um rack por VPS que envia dados, lado a lado. Sem mesas, agentes nem áreas.
function serverWorld(room) {
  const n = Math.max(1, monitor.hosts.length);
  const W = Math.max(14, n * 4 + 3), H = WALL_H + 9;
  const bottom = (H - 1) * T;
  return {
    server: true, cols: 1, rows: 1, W, H, L: (W - 1) * T, top: WALL_H * T, bottom, mid: (WALL_H * T + bottom) / 2,
    spots: [], blocks: [], floor: room.floor || 'escuro', wall: room.wall || 'cinza',
    slotOf: new Map(), byslot: new Map(), newSlot: -1,
    rackX0: 1 + Math.floor(((W - 2) - (n * 4 - 1)) / 2),
    trunkX: (W - 2) * T, door: { x: (W - 2) * T, y: bottom + 0.6 * T },
  };
}

function computeWorld() {
  const room = currentRoom();
  if (room?.kind === 'servidor') return serverWorld(room);
  const cols = room?.cols || 4;
  const { slotOf, byslot, free } = layoutSlots(cols);
  const loungeX = DESK_X0 + cols * CELL_W;
  const areas = AREA_ORDER.filter((a) => (room?.areas || AREA_ORDER).includes(a));
  if (!areas.length) areas.push('copa');
  const areaTiles = areas.reduce((sum, a) => sum + AREA_H[a], 0);
  // sobra sempre uma célula livre depois da última mesa (a "nova mesa"). Ao mover mesas ganha uma fileira
  // a mais, mas só se couber na altura que as áreas laterais já ocupam (senão o zoom automático encolheria)
  const need = Math.max(2, Math.ceil((Math.max(-1, ...slotOf.values()) + 2) / cols));
  const rows = moveMode ? Math.max(need, Math.min(need + 1, Math.floor(areaTiles / CELL_H))) : need;
  const W = loungeX + LOUNGE_W + 1;
  const H = WALL_H + Math.max(rows * CELL_H, areaTiles) + 1;
  const L = loungeX * T;
  const top = WALL_H * T;
  const bottom = (H - 1) * T;
  const mid = (top + bottom) / 2;

  // coluna lateral: blocos empilhados (o último estica até o fim da sala)
  const blocks = [];
  let y = top;
  areas.forEach((type, i) => {
    const y1 = i === areas.length - 1 ? bottom : y + AREA_H[type] * T;
    blocks.push({ type, y0: y, y1 });
    y = y1;
  });
  const spots = blocks.flatMap((b) => areaSpots(b, L));

  return {
    cols, rows, W, H, L, top, bottom, mid, spots, blocks, floor: room?.floor || 'madeira', slotOf, byslot, newSlot: free,
    wall: room?.wall || 'cinza',
    trunkX: (loungeX - 0.4) * T,
    door: { x: (loungeX - 0.4) * T, y: bottom + 0.6 * T },
  };
}

// ---------- Áreas especiais (coluna lateral) ----------
const AREA_ORDER = ['copa', 'reuniao', 'descanso'];
const AREA_H = { copa: 5, reuniao: 6, descanso: 6 }; // altura em tiles
const AREA_NAMES = { copa: '☕ Copa', reuniao: '💬 Sala de reunião', descanso: '🎮 Área de descanso' };

// Lugares onde agentes ociosos param. act = o que fazem ali; facing = para onde olham.
// Os agentes chegam andando na horizontal a partir do corredor da esquerda, então os
// lugares ficam em linhas livres de móveis (cadeiras acima/abaixo da mesa, não ao lado).
function areaSpots({ type, y0 }, L) {
  const s = (dx, dy, act, facing, extra) => ({ x: L + dx * T, y: y0 + dy * T, act, facing, ...extra });
  if (type === 'copa') {
    return [1.4, 2.9, 4.4, 5.9].map((dx) => s(dx, 2.2, 'cafe', 'up'))
      .concat([s(2.4, 3.9, 'cafe', 'right'), s(4.6, 3.9, 'cafe', 'left')]);
  }
  if (type === 'reuniao') {
    return [2, 3.5, 5].flatMap((dx) => [
      s(dx, 2.3, 'reuniao', 'down', { chair: 'top' }),
      s(dx, 4.8, 'reuniao', 'up', { chair: 'bottom' }),
    ]);
  }
  return [1.9, 3.5, 5.1].map((dx) => s(dx, 2.5, 'sofa', 'down'))
    .concat([s(1.6, 5.0, 'puff', 'down'), s(5.9, 5.5, 'arcade', 'up')]);
}

function cellOf(i) {
  const col = i % world.cols, row = Math.floor(i / world.cols);
  const x = (DESK_X0 + col * CELL_W) * T;
  const y = (WALL_H + row * CELL_H) * T;
  return { x, y, row, seat: { x: x + 2.5 * T, y: y + 2.85 * T }, aisleY: y + 4.45 * T };
}

// ---------- Caminhos: corredor horizontal de cada fileira + corredor vertical à direita ----------
function aisleFor(p) {
  if (p.x >= world.L - T) return p.y; // lounge: anda livre
  const row = Math.max(0, Math.min(world.rows - 1, Math.floor((p.y / T - WALL_H) / CELL_H)));
  return (WALL_H + row * CELL_H + 4.45) * T;
}

function route(from, to) {
  if (Math.hypot(from.x - to.x, from.y - to.y) < 1) return [];
  const ay1 = aisleFor(from), ay2 = aisleFor(to);
  const pts = [{ x: from.x, y: ay1 }];
  if (Math.abs(ay1 - ay2) > 1) pts.push({ x: world.trunkX, y: ay1 }, { x: world.trunkX, y: ay2 });
  pts.push({ x: to.x, y: ay2 }, { x: to.x, y: to.y });
  return pts;
}

// ---------- Estado vindo do servidor ----------
// PC que executa os pedidos deste navegador: o escolhido, se estiver conectado; senão,
// o único conectado. state.env e p.folder (pasta da mesa nesse PC) saem daqui.
function resolveEnv() {
  const online = Object.keys(state.connectors || {});
  const id = online.includes(preferredEnv) ? preferredEnv : online.length === 1 ? online[0] : null;
  state.env = id ? { id, name: state.connectors[id].name } : null;
  for (const p of state.projects) {
    p.folder = id ? p.folders?.[id] || null : null;
    // PC onde os pedidos desta mesa rodam: este, se tiver a pasta; senão, outro conectado que tenha
    // (é o que o hub faz): dá para usar o PC do escritório pelo celular
    p.runEnv = p.role === 'secretaria' ? id || online[0] || null : p.folder ? id : online.find((e) => p.folders?.[e]) || null;
  }
}

function chooseEnv(id) {
  preferredEnv = id;
  store('hub.env', id);
  resolveEnv();
  refreshUI();
  for (const w of wins.values()) if (w.projectId) refreshGit(w);
}

// Mesa do agente. `here` = está na sala exibida (só então há `cell` para desenhar).
function deskOf(agentId) {
  const project = state.projects.find((p) => p.agentId === agentId);
  if (!project) return null;
  const i = world?.slotOf.get(project.id);
  return { project, here: i != null, cell: i != null ? cellOf(i) : null };
}

// Cria/remove personagens da sala exibida. Ao entrar numa sala, quem trabalha já aparece sentado.
function syncRuntime(atSeats) {
  const visible = visibleAgents();
  for (const a of visible) {
    if (runtime.has(a.id)) continue;
    const desk = deskOf(a.id);
    const rt = { path: [], targetKey: null, walk: 0, facing: 'up', wanderAt: 0 };
    let start = world.door;
    if (atSeats && desk && a.status !== 'ocioso') start = desk.cell.seat;
    else if (atSeats) {
      // ocioso já aparece numa das áreas (copa, reunião, descanso)
      rt.spot = pickSpot(a.id);
      rt.wanderAt = Date.now() + 40000 + Math.random() * 40000;
      start = world.spots[rt.spot];
    }
    runtime.set(a.id, Object.assign(rt, { x: start.x, y: start.y }));
  }
  for (const id of runtime.keys()) if (!visible.some((a) => a.id === id)) runtime.delete(id);
}

let clockOffset = 0; // relógio do navegador − relógio do hub

// ---------- Avisos: telefone tocando e reunião de delegação ----------
const prevRing = new Set(); // mesas que já estavam esperando você
const prevMsg = new Map(); // agentId -> última mensagem de status
let lastDelegationAt = 0; // quando uma demanda foi passada a uma mesa (a secretária livre vai à reunião)
let soundOn = load('hub.sound') !== false;
let audioCtx = null;

// dois toques curtos, como um telefone antigo
function ringPhone() {
  if (!soundOn) return;
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const t0 = audioCtx.currentTime;
    [0, 0.18, 0.5, 0.68].forEach((d, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square';
      o.frequency.value = i % 2 ? 880 : 660;
      g.gain.setValueAtTime(0.0001, t0 + d);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.15);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + d);
      o.stop(t0 + d + 0.16);
    });
  } catch {}
}

// Chamado a cada estado novo: toca quando uma mesa passa a esperar você e anota quando uma demanda foi delegada.
function trackAlerts(first) {
  let fresh = false;
  for (const p of state.projects) {
    const a = state.agents.find((x) => x.id === p.agentId);
    const ring = !!(state.live?.[p.id]?.pending || a?.status === 'bloqueado');
    if (ring && !prevRing.has(p.id)) fresh = true;
    if (ring) prevRing.add(p.id); else prevRing.delete(p.id);
  }
  for (const a of state.agents) {
    if (!first && a.status === 'trabalhando' && /^📨 Demanda/.test(a.message || '') && prevMsg.get(a.id) !== a.message) lastDelegationAt = Date.now();
    prevMsg.set(a.id, a.message);
  }
  if (fresh && !first) ringPhone();
}

function applyState(next) {
  const firstLoad = !world;
  state = next;
  if (state.now) clockOffset = Date.now() - state.now;
  if (!state.rooms.some((r) => r.id === roomId)) roomId = state.rooms[0]?.id;
  resolveEnv();
  trackAlerts(firstLoad);
  world = computeWorld();
  syncRuntime(firstLoad);
  if (selected && !state.projects.some((p) => p.id === selected.id)) selected = null;
  resize();
  refreshUI();
  if (currentRoom()?.kind === 'servidor' && Date.now() - monitor.at > 5000) loadMonitor();
  // localhost:4321/#<id-da-mesa> já abre a conversa daquela mesa
  if (firstLoad && state.projects.some((p) => p.id === location.hash.slice(1))) openProjectWindow(location.hash.slice(1));
}

// ---------- Simulação ----------
function pickMeetingSpot(agentId) {
  const taken = new Set();
  for (const [id, rt] of runtime) if (id !== agentId && rt.spot != null) taken.add(rt.spot);
  const free = world.spots.map((s, i) => (s.act === 'reuniao' && !taken.has(i) ? i : -1)).filter((i) => i >= 0);
  return free.length ? free[Math.floor(Math.random() * free.length)] : null;
}

function pickSpot(agentId) {
  const taken = new Set();
  for (const [id, rt] of runtime) if (id !== agentId && rt.spot != null) taken.add(rt.spot);
  const free = world.spots.map((_, i) => i).filter((i) => !taken.has(i));
  const pool = free.length ? free : world.spots.map((_, i) => i);
  // a reunião só rende conversa com companhia: pesa mais quando já tem alguém lá
  const inMeeting = [...taken].filter((i) => world.spots[i].act === 'reuniao').length;
  const w = pool.map((i) => (world.spots[i].act === 'reuniao' ? 1 + inMeeting * 3 : 1));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < pool.length; k++) if ((r -= w[k]) < 0) return pool[k];
  return pool[0];
}

// Próximo plano de quem está livre: ou fica na mesa, ou vai a uma área (sofá, copa, reunião) e fica um bom tempo.
// Sem passeios soltos pelo corredor: quem sai da mesa sempre tem um destino e depois volta.
function pickPlan(prev) {
  if (prev === 'spot') return 'sit'; // voltou de uma área: descansa na cadeira antes de sair de novo
  return Math.random() < 0.8 ? 'spot' : 'sit';
}

function switchRoom(id) {
  if (id === currentRoom()?.id) return;
  roomId = id;
  store('hub.room', id);
  runtime.clear();
  world = computeWorld();
  syncRuntime(true);
  loadMonitor();
  wrap.scrollTo(0, 0);
  resize();
  refreshUI();
}

function update(dt, now) {
  for (const a of visibleAgents()) {
    const rt = runtime.get(a.id);
    const desk = deskOf(a.id);
    let target, key;

    // um "ocioso" passageiro (troca de status no meio de um pedido) não tira o agente da mesa:
    // só sai depois de alguns segundos ocioso de verdade
    if (a.status !== 'ocioso') rt.idleSince = null;
    else rt.idleSince ??= now;
    const atDesk = rt.targetKey?.startsWith('desk');
    const goIdle = a.status === 'ocioso' && !(atDesk && now - rt.idleSince < IDLE_GRACE);

    // livre = sem nada a fazer: concluído (esperando você) ou ocioso de verdade. Trabalhando e bloqueado
    // ficam na mesa. Quem está livre alterna entre sentar, ir a uma área e dar uma volta pelo corredor.
    const free = !!desk && (a.status === 'concluido' || goIdle);
    const deskKey = desk && 'desk:' + desk.project.id + ':' + world.slotOf.get(desk.project.id) + ':' + world.cols;
    if (desk && !free) {
      rt.plan = null;
      target = desk.cell.seat;
      key = deskKey;
      rt.spot = null;
    } else if (desk) {
      if (!rt.plan) {
        // acabou de ficar livre: concluído fica um pouco sentado antes do primeiro passeio
        // secretária que acabou de passar uma demanda: vai à sala de reunião um instante (quem recebe fica na
        // mesa trabalhando, para não parecer que enrola antes de começar)
        const meet = desk.project.role === 'secretaria' && now - lastDelegationAt < 90000;
        rt.plan = meet ? 'spot' : a.status === 'concluido' ? 'sit' : pickPlan(null);
        rt.wantMeeting = meet;
        rt.planAt = now + (meet ? 15000 : rt.plan === 'sit' ? 15000 + Math.random() * 20000 : 0);
        rt.spot = null;
      } else if (now > rt.planAt) {
        rt.plan = pickPlan(rt.plan);
        rt.planAt = now + (rt.plan === 'sit' ? 40000 + Math.random() * 50000 : 45000 + Math.random() * 45000);
        rt.spot = null;
        rt.wantMeeting = false;
      }
      if (rt.plan === 'spot') {
        rt.spot ??= (rt.wantMeeting ? pickMeetingSpot(a.id) : null) ?? pickSpot(a.id); // sem reunião: null, e aí sim cai no sorteio comum
        target = world.spots[rt.spot];
        key = 'spot:' + rt.spot + ':' + world.H + ':' + world.W;
      } else {
        target = desk.cell.seat;
        key = deskKey;
      }
    } else {
      if (rt.spot == null || now > rt.wanderAt) {
        rt.spot = pickSpot(a.id);
        rt.wanderAt = now + 40000 + Math.random() * 40000;
      }
      target = world.spots[rt.spot];
      key = 'spot:' + rt.spot + ':' + world.H + ':' + world.W;
    }

    if (key !== rt.targetKey) {
      rt.targetKey = key;
      rt.path = route(rt, target);
    }

    rt.moving = false;
    // quem foi chamado ao trabalho vai correndo para a mesa: o balão de "pensando" já está na tela
    // e o passeio de volta, na velocidade normal, parecia o agente enrolando antes de começar
    const running = key.startsWith('desk') && !free;
    let budget = (running ? RUN_SPEED : SPEED) * dt;
    while (budget > 0 && rt.path.length) {
      const p = rt.path[0];
      const dx = p.x - rt.x, dy = p.y - rt.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.01) { rt.path.shift(); continue; }
      const step = Math.min(budget, d);
      rt.x += (dx / d) * step;
      rt.y += (dy / d) * step;
      budget -= step;
      rt.walk += running ? step * 0.5 : step; // correndo, as pernas não trocam rápido demais
      rt.moving = true;
      rt.facing = Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : dx < 0 ? 'left' : 'right';
    }
    const arrived = !rt.path.length;
    rt.sit = (rt.sit || 0) + (((arrived && key.startsWith('desk')) ? 1 : 0) - (rt.sit || 0)) * Math.min(1, dt * 8);
    rt.seated = arrived && key.startsWith('desk');
    rt.atSpot = arrived && !rt.seated && rt.spot != null ? world.spots[rt.spot] : null;
    if (rt.seated) rt.facing = 'up';
    else if (rt.atSpot) rt.facing = rt.atSpot.facing;
    else if (!rt.moving) rt.facing = 'down';
  }
}

// ---------- Desenho ----------
const rect = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };

// sombra suave no chão (elipse escura translúcida): dá volume aos móveis e peso aos personagens
function shadow(x, y, w, h, a = 0.28) {
  ctx.globalAlpha = a;
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
}

// faixa com degradê (sombra encostada nas paredes, luz que cai)
function fade(x, y, w, h, vertical, from, to) {
  const g = vertical ? ctx.createLinearGradient(0, y, 0, y + h) : ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, from); g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

function text(str, wx, wy, px, color, align = 'center') {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `${px}px "Press Start 2P", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const x = Math.round(wx * SCALE), y = Math.round(wy * SCALE);
  ctx.fillStyle = '#000a';
  ctx.fillText(str, x + 1, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
  ctx.restore();
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function skyColor() {
  const h = new Date().getHours();
  if (h >= 7 && h < 17) return ['#7cc4f5', '#b6e0fb'];
  if (h >= 17 && h < 19) return ['#f19b6b', '#f7c58b'];
  if (h >= 5 && h < 7) return ['#8f9ad8', '#f3b8a0'];
  return ['#1b2350', '#2c3770'];
}

// piso da área das mesas: [cor A, cor B, linha entre tábuas/lajotas ou null]
const FLOORS = {
  madeira: ['#a7744a', '#b17d50', '#8e6340'],
  carpete: ['#4b5a7a', '#51617f', null],
  piso: ['#c9c4b8', '#d3cec2', '#b5b0a4'],
  escuro: ['#2e3245', '#33384d', null],
};

function drawRoom(now) {
  const { W, H, L, top, bottom } = world;
  const [fa, fb, fline] = FLOORS[world.floor] || FLOORS.madeira;
  // piso da sala (área das mesas) e carpete (lounge)
  for (let ty = WALL_H; ty < H - 1; ty++) {
    for (let tx = 1; tx < W - 1; tx++) {
      const x = tx * T, y = ty * T;
      if (x >= L) rect(x, y, T, T, (tx + ty) % 2 ? '#3c3552' : '#433b5c');
      else {
        rect(x, y, T, T, (tx + ty) % 2 ? fa : fb);
        if (fline) rect(x, y + T - 1, T, 1, fline);
      }
    }
  }
  for (const d of roomDecor()) if (DECOR_META[d.type]?.layer === 'tapete' && decorFits(d)) DECOR_DRAW[d.type](d.x * T, d.y * T, now);
  // paredes
  const [wallMain, wallTrim] = WALLS[world.wall] || WALLS.cinza;
  rect(0, 0, W * T, top, wallMain);
  rect(0, top - 4, W * T, 4, wallTrim);
  rect(0, 0, T, H * T, wallTrim);
  rect((W - 1) * T, 0, T, H * T, wallTrim);
  rect(0, bottom, W * T, T, wallTrim);
  rect(0, 0, W * T, 3, '#2b2f3e');
  // profundidade: a parede escurece perto do piso e projeta sombra nele; as laterais também
  fade(T, 0, (W - 2) * T, top - 4, true, 'rgba(255,255,255,.07)', 'rgba(0,0,0,.28)');
  rect(T, top - 5, (W - 2) * T, 1, '#ffffff26');
  fade(T, top, (W - 2) * T, 16, true, 'rgba(0,0,0,.4)', 'rgba(0,0,0,0)');
  fade(T, top, 12, bottom - top, false, 'rgba(0,0,0,.3)', 'rgba(0,0,0,0)');
  fade((W - 1) * T - 12, top, 12, bottom - top, false, 'rgba(0,0,0,0)', 'rgba(0,0,0,.3)');
  fade(T, bottom - 10, (W - 2) * T, 10, true, 'rgba(0,0,0,0)', 'rgba(0,0,0,.3)');
  rect(0, bottom, W * T, 2, '#ffffff1a');

  // janelas
  const [sky1, sky2] = skyColor();
  for (let x = 2 * T; x + 3 * T < L; x += 5 * T) {
    rect(x - 2, 0.6 * T - 2, 3 * T + 4, 1.6 * T + 4, '#2b2f3e');
    rect(x, 0.6 * T, 3 * T, 0.8 * T, sky1);
    rect(x, 1.4 * T, 3 * T, 0.8 * T, sky2);
    const hour = new Date().getHours();
    if (hour >= 7 && hour < 17) {
      // nuvem passando devagar, cortada nas bordas da janela
      const cw = 12, pos = ((now / 700 + x * 3) % (3 * T + cw)) - cw;
      const cx0 = Math.max(0, pos), cx1 = Math.min(3 * T, pos + cw);
      if (cx1 > cx0) { rect(x + cx0, 0.9 * T, cx1 - cx0, 3, '#ffffffcc'); rect(x + cx0 + 2, 0.9 * T - 2, Math.max(0, Math.min(cx1, pos + cw - 2) - cx0 - 2), 2, '#ffffffcc'); }
      // feixe de luz no piso
      ctx.globalAlpha = 0.03; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + 3 * T, top); ctx.lineTo(x + 5 * T, top + 6 * T); ctx.lineTo(x + 2 * T, top + 6 * T); ctx.fill();
      ctx.globalAlpha = 1;
    } else if (hour >= 19 || hour < 5) {
      for (let k = 0; k < 6; k++) {
        const sx = x + 2 + ((k * 37 + x) % (3 * T - 4)), sy = 0.7 * T + ((k * 53) % Math.floor(1.4 * T));
        if (Math.abs(sx - (x + 1.5 * T)) > 2 && (now / 500 + k) % 3 < 2.4) rect(sx, sy, 1, 1, '#fff');
      }
    }
    rect(x + 1.5 * T - 1, 0.6 * T, 2, 1.6 * T, '#2b2f3e');
  }

  // relógio de verdade no lounge
  const cx = world.server ? (W - 3) * T : L + 3.5 * T, cy = 1.3 * T;
  ctx.fillStyle = '#e8eaf2';
  ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
  const d = new Date();
  const hand = (ang, len, w) => {
    ctx.strokeStyle = '#222'; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(ang) * len, cy - Math.cos(ang) * len); ctx.stroke();
  };
  hand(((d.getHours() % 12) + d.getMinutes() / 60) * (Math.PI / 6), 5, 2);
  hand(d.getMinutes() * (Math.PI / 30), 7, 1);

  // TV na parede do lounge: quantos agentes em cada situação, com as mesmas cores dos monitores
  if (!world.server) {
    const tvx = L + 0.25 * T, tvy = 0.5 * T, tvw = 2.45 * T, tvh = 1.6 * T;
    rect(tvx - 2, tvy - 2, tvw + 4, tvh + 4, '#0d0f17');
    rect(tvx, tvy, tvw, tvh, '#101a2c');
    rect(tvx, tvy, tvw, 1, '#ffffff22');
    const agents = visibleAgents();
    ['trabalhando', 'bloqueado', 'concluido', 'ocioso'].forEach((st, i) => {
      const gx = tvx + 8 + (i % 2) * (tvw / 2), gy = tvy + 8 + Math.floor(i / 2) * 11;
      rect(gx - 3, gy - 2, 4, 4, STATUS[st].color);
      text(String(agents.filter((x) => x.status === st).length), gx + 8, gy, 7, '#fff');
    });
    rect(tvx + tvw / 2 - 4, tvy + tvh + 2, 8, 2, '#0d0f17');
  }

  for (const d of roomDecor()) if (DECOR_META[d.type]?.layer === 'parede' && decorFits(d)) DECOR_DRAW[d.type](d.x * T, 0, now);

  // porta
  rect(world.door.x - 12, bottom, 24, T, '#2b2f3e');
  rect(world.door.x - 10, bottom + 2, 20, T - 2, '#7a5a3a');

  drawAreas(now);
}

// ---------- Decoração (itens que o usuário posiciona; tamanhos em tiles) ----------
// layer: 'parede' (fixo no topo), 'tapete' (por baixo das mesas) ou 'piso' (móveis)
const DECOR_META = {
  quadro: { name: '🖼️ Quadro', w: 2, h: 1, layer: 'parede' },
  bandeira: { name: '🚩 Bandeira', w: 1, h: 1, layer: 'parede' },
  planta: { name: '🪴 Planta', w: 1, h: 1, layer: 'piso' },
  tapete: { name: '🟫 Tapete', w: 2, h: 2, layer: 'tapete' },
  estante: { name: '📚 Estante', w: 2, h: 1, layer: 'piso' },
  abajur: { name: '💡 Abajur', w: 1, h: 1, layer: 'piso' },
  impressora: { name: '🖨️ Impressora', w: 1, h: 1, layer: 'piso' },
};
const WALLS = { // [parede, rodapé/lateral]
  cinza: ['#5b6178', '#3d4256'], azul: ['#4a6a94', '#2f4766'], verde: ['#4f7a63', '#33543f'],
  vinho: ['#7a4455', '#55303c'], bege: ['#a89a82', '#7d715d'],
};
const WALL_NAMES = { cinza: 'Cinza', azul: 'Azul', verde: 'Verde', vinho: 'Vinho', bege: 'Bege' };

const DECOR_DRAW = {
  quadro(x) {
    rect(x + 2, 10, 28, 20, '#2b2f3e');
    rect(x + 4, 12, 24, 16, '#e8d9a8');
    rect(x + 4, 22, 24, 6, '#3f9b54');
    rect(x + 18, 17, 6, 6, '#f2a93b');
  },
  bandeira(x) {
    rect(x + 4, 4, 8, 27, '#e5534b');
    rect(x + 4, 12, 8, 3, '#fff');
    rect(x + 4, 31, 3, 3, '#e5534b');
    rect(x + 9, 31, 3, 3, '#e5534b');
  },
  planta(x, y) { plant(x + 8, y + 15); },
  tapete(x, y) {
    rect(x + 1, y + 1, 30, 30, '#7a3b4a');
    rect(x + 4, y + 4, 24, 24, '#a24d60');
    rect(x + 8, y + 8, 16, 16, '#7a3b4a');
  },
  estante(x, y) {
    rect(x + 1, y - 6, 30, 22, '#6b4429');
    rect(x + 3, y - 4, 26, 8, '#3a2616');
    rect(x + 3, y + 5, 26, 8, '#3a2616');
    const cores = ['#e5534b', '#4f8cff', '#f2a93b', '#3fbf7f', '#b072f5'];
    for (let i = 0; i < 6; i++) {
      rect(x + 4 + i * 4, y - 3, 3, 7, cores[i % 5]);
      rect(x + 4 + i * 4, y + 6, 3, 7, cores[(i + 2) % 5]);
    }
  },
  abajur(x, y, now) {
    ctx.globalAlpha = 0.14 + 0.02 * Math.sin(now / 700);
    ctx.fillStyle = '#ffe9a8';
    ctx.beginPath(); ctx.arc(x + 8, y + 6, 13, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    rect(x + 6, y + 14, 4, 2, '#333');
    rect(x + 7, y + 7, 2, 7, '#555');
    rect(x + 4, y + 3, 8, 5, '#f2d16b');
  },
  impressora(x, y, now) {
    rect(x + 2, y + 6, 12, 8, '#d0d0d8');
    rect(x + 3, y + 3, 10, 4, '#f5f5f5');
    rect(x + 3, y + 12, 10, 2, '#8a8a96');
    rect(x + 11, y + 8, 2, 2, now % 1000 < 500 ? '#3fbf7f' : '#1c5a3a');
  },
};

const roomDecor = () => currentRoom()?.decor || [];
// item dentro dos limites da sala (a sala pode ter encolhido depois de posicioná-lo)
function decorFits(d) {
  const m = DECOR_META[d.type];
  if (!m) return false;
  const maxX = world.L / T;
  if (m.layer === 'parede') {
    // as janelas ficam nos tiles [2+5k, 5+5k): quadros e bandeiras só nos vãos entre elas
    for (let wx = 2; wx + 3 < maxX; wx += 5) if (d.x < wx + 3 && wx < d.x + m.w) return false;
    return d.x >= 1 && d.x + m.w <= maxX;
  }
  return d.x >= 1 && d.x + m.w <= maxX && d.y >= WALL_H && d.y + m.h <= world.H - 1;
}

function plant(x, y) {
  shadow(x, y + 2, 16, 5, 0.3);
  rect(x - 5, y - 6, 10, 8, '#b5643c');
  rect(x - 6, y - 7, 12, 2, '#8e4a2c');
  ctx.fillStyle = '#3f9b54';
  const sway = Math.sin(animNow / 1100 + x * 0.1) * 1.3; // balanço leve, maior nas folhas do topo
  for (const [ox, oy, r] of [[0, -14, 6], [-5, -10, 5], [5, -10, 5], [0, -19, 4]]) {
    ctx.beginPath(); ctx.arc(x + ox + sway * (-oy / 19), y + oy, r, 0, Math.PI * 2); ctx.fill();
  }
}

function drawAreas(now) {
  const { L, W } = world;
  const right = (W - 1) * T;
  const occupied = new Set();
  for (const rt of runtime.values()) if (rt.atSpot) occupied.add(rt.atSpot);
  world.blocks.forEach((b, i) => {
    if (i > 0) {
      // divisória entre áreas
      rect(L, b.y0 - 2, right - L, 4, '#3d4256');
      rect(L, b.y0 + 2, right - L, 2, '#2b2f3e');
      text({ copa: 'COPA', reuniao: 'REUNIÃO', descanso: 'DESCANSO' }[b.type], right - 4, b.y0 + 9, 6, '#ffffff55', 'right');
    }
    ({ copa: drawCopa, reuniao: drawMeeting, descanso: drawRest })[b.type](b, now, occupied);
  });
}

function drawCopa({ y0 }, now, occupied) {
  const { L } = world;
  // bancada com cafeteira
  rect(L + 0.3 * T, y0, 6.4 * T, T, '#d8d2c4');
  rect(L + 0.3 * T, y0 + T, 6.4 * T, 4, '#a49d8c');
  rect(L + 1 * T, y0 - 10, 12, 16, '#2d2d2d');
  rect(L + 1 * T + 3, y0 - 6, 6, 4, now % 1000 < 500 ? '#e5534b' : '#702a26');
  if (world.spots.some((sp) => sp.act === 'cafe' && occupied.has(sp))) {
    // alguém tomando café: vapor sobe da cafeteira
    for (let k = 0; k < 3; k++) {
      const t = (now / 1100 + k / 3) % 1;
      ctx.globalAlpha = 0.6 * (1 - t);
      rect(L + T + 5 + Math.round(Math.sin(t * 6 + k) * 2), y0 - 12 - t * 10, 2, 2, '#fff');
    }
    ctx.globalAlpha = 1;
  }
  rect(L + 2.2 * T, y0 + 2, 6, 7, '#f5f5f5');
  rect(L + 2.7 * T, y0 + 2, 6, 7, '#4f8cff');
  // galão de água
  rect(L + 5.6 * T, y0 - 14, 12, 12, '#8fd3ff');
  rect(L + 5.6 * T, y0 - 2, 12, 14, '#e8eaf2');
  // mesinha
  shadow(L + 3.5 * T, y0 + 3.7 * T + 7, 36, 9, 0.28);
  ctx.fillStyle = '#7a5a3a';
  ctx.beginPath(); ctx.ellipse(L + 3.5 * T, y0 + 3.7 * T, 16, 8, 0, 0, Math.PI * 2); ctx.fill();
  rect(L + 3.5 * T - 3, y0 + 3.7 * T - 4, 6, 5, '#f5f5f5');
  plant(L + 6.5 * T, y0 + 4.8 * T);
}

function drawMeeting({ y0, y1 }, now, occupied) {
  const { L, W } = world;
  ctx.globalAlpha = 0.3;
  rect(L, y0 + 4, (W - 1) * T - L, y1 - y0 - 4, '#2a5f8a');
  ctx.globalAlpha = 1;
  // quadro branco
  rect(L + 0.6 * T, y0 + 0.5 * T, 1.8 * T, 0.9 * T, '#e8eaf2');
  rect(L + 0.6 * T + 3, y0 + 0.5 * T + 3, 14, 2, '#4f8cff');
  rect(L + 0.6 * T + 3, y0 + 0.5 * T + 7, 9, 2, '#e5534b');
  const chairs = world.spots.filter((s) => s.act === 'reuniao');
  // cadeiras de cima: encosto fica atrás de quem senta
  for (const s of chairs.filter((s) => s.chair === 'top')) {
    rect(s.x - 6, s.y - 13, 12, 5, '#2d3142');
    rect(s.x - 6, s.y - 8, 12, 6, '#3a3f55');
  }
  // mesa
  shadow(L + 3.5 * T, y0 + 3.95 * T, 4.8 * T, 8, 0.3);
  rect(L + 1.3 * T, y0 + 2.5 * T, 4.4 * T, 1.4 * T, '#6b4429');
  rect(L + 1.3 * T + 2, y0 + 2.5 * T + 2, 4.4 * T - 4, 1.4 * T - 6, '#8a5a3b');
  rect(L + 2.2 * T, y0 + 2.9 * T, 6, 8, '#f5f5f5');
  rect(L + 4.4 * T, y0 + 3 * T, 8, 6, '#d0d0d8');
  // cadeiras de baixo: o encosto de quem está sentado é desenhado depois do agente
  for (const s of chairs.filter((s) => s.chair === 'bottom')) {
    rect(s.x - 7, s.y - 6, 14, 6, '#2d3142');
    if (!occupied.has(s)) rect(s.x - 7, s.y - 2, 14, 7, '#3a3f55');
  }
}

function drawRest({ y0 }, now, occupied) {
  const { L } = world;
  // tapete
  rect(L + 1.2 * T, y0 + 3.3 * T, 3.4 * T, 2 * T, '#5a3e7a');
  rect(L + 1.2 * T + 3, y0 + 3.3 * T + 3, 3.4 * T - 6, 2 * T - 6, '#6b4f8f');
  // sofá encostado na divisória (quem senta fica de frente)
  shadow(L + 3.5 * T, y0 + 2.75 * T, 5.4 * T, 7, 0.3);
  rect(L + 1 * T, y0 + 0.9 * T, 5 * T, 0.7 * T, '#a5311f');
  rect(L + 1 * T, y0 + 1.5 * T, 5 * T, 1.1 * T, '#c0392b');
  rect(L + 1 * T, y0 + 2.4 * T, 5 * T, 0.3 * T, '#8e2a20');
  rect(L + 0.8 * T, y0 + 1.1 * T, 6, 1.6 * T, '#a5311f');
  rect(L + 6 * T - 2, y0 + 1.1 * T, 6, 1.6 * T, '#a5311f');
  // puff
  ctx.fillStyle = '#f2a93b';
  ctx.beginPath(); ctx.ellipse(L + 1.6 * T, y0 + 4.9 * T, 10, 6, 0, 0, Math.PI * 2); ctx.fill();
  // fliperama: a tela pisca quando tem alguém jogando
  const ax = L + 5.4 * T, ay = y0 + 3 * T;
  const playing = world.spots.some((s) => s.act === 'arcade' && occupied.has(s));
  shadow(ax + 8, ay + 31, 24, 6, 0.32);
  rect(ax, ay, 16, 30, '#2b2f6e');
  rect(ax, ay, 16, 4, '#e5534b');
  rect(ax + 3, ay + 7, 10, 8, playing ? ['#3fbf7f', '#f2a93b', '#4f8cff', '#e5534b'][Math.floor(now / 180) % 4] : '#111');
  rect(ax + 2, ay + 18, 12, 3, '#1c1c24');
}

// ---------- Sala de servidores ----------
const MON_COLOR = { ok: '#3fbf7f', atencao: '#f2a93b', critico: '#e5534b', 'sem-sinal': '#6b7088' };
const MON_LABEL = { ok: 'OK', atencao: 'ATENCAO', critico: 'CRITICO', 'sem-sinal': 'SEM SINAL' }; // sem acento: a fonte pixel não tem
// a carga (load ÷ vCPUs) sozinha só chega a ATENÇÃO: ela sobe com o steal do hypervisor mesmo com a VM quase ociosa
const loadLevel = (v) => (v == null ? '#6b7088' : v >= 75 ? MON_COLOR.atencao : MON_COLOR.ok);
const level = (v, warn, crit) => (v == null ? '#6b7088' : v >= crit ? MON_COLOR.critico : v >= warn ? MON_COLOR.atencao : MON_COLOR.ok);
const RACK_W = 3 * T, RACK_H = 6 * T;
const rackPos = (i) => ({ x: (world.rackX0 + i * 4) * T, y: (WALL_H + 1) * T });

function drawRacks(now) {
  if (!monitor.hosts.length) {
    const { x, y } = rackPos(0);
    ctx.strokeStyle = '#ffffff55'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, RACK_W, RACK_H);
    ctx.setLineDash([]);
    const msg = monitor.denied ? 'SÓ A DONA DO HUB VÊ' : monitor.configured ? 'AGUARDANDO DADOS' : 'SEM MONITOR';
    text(msg, x + RACK_W / 2, y + RACK_H / 2, 7, '#ffffffaa');
    text('CLIQUE PARA CONFIGURAR', x + RACK_W / 2, y + RACK_H + 10, 6, '#ffffff77');
    return;
  }
  monitor.hosts.forEach((h, i) => {
    const { x, y } = rackPos(i);
    const stale = h.status === 'sem-sinal';
    const isHover = hover?.kind === 'rack' && hover.host === h.host;
    rect(x - 2, y - 2, RACK_W + 4, RACK_H + 4, isHover ? '#ffffff' : '#0d0f17');
    rect(x, y, RACK_W, RACK_H, '#1c1f2b');
    // seis unidades: CPU, memória, disco, PM2, Docker e systemd, cada uma com a cor do seu estado
    const unit = [
      [loadLevel(h.cpu), h.cpu == null ? 0 : Math.min(1, h.cpu / 100)],
      [level(h.mem, 80, 90), h.mem == null ? 0 : h.mem / 100],
      [level(h.disk, 80, 90), h.disk == null ? 0 : h.disk / 100],
      [h.pm2.errored.count ? MON_COLOR.critico : h.pm2.highRestarts.count ? MON_COLOR.atencao : MON_COLOR.ok, null],
      [h.docker.unhealthy.count ? MON_COLOR.critico : MON_COLOR.ok, null],
      [h.systemd.failed.count ? MON_COLOR.critico : MON_COLOR.ok, null],
    ];
    unit.forEach(([color, fill], u) => {
      const uy = y + 3 + u * 15;
      rect(x + 3, uy, RACK_W - 6, 12, '#2a2f45');
      if (fill != null) rect(x + 12, uy + 4, Math.round((RACK_W - 18) * fill), 4, stale ? '#4a4f66' : color);
      else rect(x + 12, uy + 4, RACK_W - 18, 4, '#171a26');
      // LED: pisca em ritmo próprio; em alarme pisca rápido; sem sinal fica apagado
      const on = stale ? false : color === MON_COLOR.critico ? Math.floor(now / 250) % 2 === 0 : Math.floor(now / (700 + u * 130) + i) % 5 !== 0;
      rect(x + 5, uy + 4, 4, 4, stale ? '#33364a' : on ? color : '#1c1f2b');
    });
    // faixa de status no pé do rack
    rect(x + 3, y + RACK_H - 9, RACK_W - 6, 6, stale ? '#33364a' : MON_COLOR[h.status]);
    text(truncate(plainText(monName(h)).toUpperCase(), 12), x + RACK_W / 2, y + RACK_H + 10, 7, '#fff');
    text(MON_LABEL[h.status], x + RACK_W / 2, y + RACK_H + 20, 6, MON_COLOR[h.status]);
  });
}

async function loadMonitor() {
  if (currentRoom()?.kind !== 'servidor') return;
  monitor.at = Date.now();
  try {
    const d = await api('GET', '/api/monitor', null, { quiet: true });
    const changed = d.hosts.length !== monitor.hosts.length;
    monitor = { hosts: d.hosts, configured: d.configured, secrets: d.secrets, denied: false, at: Date.now() };
    if (changed && world?.server) { world = computeWorld(); resize(); }
  } catch (e) {
    if (e.status === 403) monitor = { hosts: [], configured: false, denied: true, at: Date.now() };
  }
  wins.get('monitor')?.render?.(wins.get('monitor'));
}
setInterval(loadMonitor, 15000);

function drawDesk(i, now) {
  const project = world.byslot.get(i);
  const c = cellOf(i);
  const agent = project ? state.agents.find((a) => a.id === project.agentId) : null;
  const rt = agent && runtime.get(agent.id);
  const isSel = selected && ((selected.kind === 'project' && project && selected.id === project.id) || (selected.kind === 'slot' && !project));
  const isHover = hover && hover.kind === (project ? 'project' : 'slot') && (!project || hover.id === project.id);

  if (!project) {
    // mesa vaga: clique para criar um projeto. As outras células vazias só aparecem ao mover mesas
    const spare = i !== world.newSlot;
    if (spare && !moveMode) return;
    if (spare) {
      ctx.strokeStyle = '#ffffff22';
      ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
      ctx.strokeRect(c.x + 0.5 * T + 0.5, c.y + 0.5 * T + 0.5, 4 * T, 3.8 * T);
      ctx.setLineDash([]);
      return;
    }
    ctx.strokeStyle = isHover ? '#ffffffcc' : '#ffffff55';
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.strokeRect(c.x + 0.5 * T + 0.5, c.y + 0.5 * T + 0.5, 4 * T, 3.8 * T);
    ctx.setLineDash([]);
    text('+', c.x + 2.5 * T, c.y + 2 * T, 16, '#ffffffaa');
    text('NOVA MESA', c.x + 2.5 * T, c.y + 3.5 * T, 7, '#ffffffaa');
    return;
  }

  // tapete com a cor do projeto
  ctx.globalAlpha = 0.28;
  rect(c.x + 0.5 * T, c.y + 0.5 * T, 4 * T, 4.1 * T, project.color || '#4f8cff');
  ctx.globalAlpha = 1;
  if (isSel || isHover) {
    ctx.strokeStyle = isSel ? '#ffffff' : '#ffffff88';
    ctx.lineWidth = 1;
    ctx.strokeRect(c.x + 0.5 * T + 0.5, c.y + 0.5 * T + 0.5, 4 * T, 3.8 * T);
  }

  // mesa
  const dx = c.x + T, dy = c.y + 0.9 * T;
  shadow(dx + 1.5 * T, dy + 1.45 * T, 3.5 * T, 9, 0.32);
  shadow(c.seat.x, c.seat.y + 1, 18, 6, 0.3);
  rect(dx, dy, 3 * T, 0.9 * T, '#8a5a3b');
  rect(dx, dy, 3 * T, 2, '#a8714c');
  rect(dx, dy + 0.9 * T, 3 * T, 0.4 * T, '#6b4429');
  rect(dx + 2, dy + 1.3 * T, 3, 4, '#4a2e1b');
  rect(dx + 3 * T - 5, dy + 1.3 * T, 3, 4, '#4a2e1b');

  // monitor
  const mx = c.x + 1.75 * T, my = c.y + 0.2 * T, mw = 1.5 * T, mh = 0.95 * T;
  rect(mx - 2, my - 2, mw + 4, mh + 4, '#1c1c24');
  rect(c.x + 2.5 * T - 2, my + mh + 2, 4, 3, '#1c1c24');
  const st = agent?.status;
  const present = rt?.seated;
  if (st === 'trabalhando' && present) {
    rect(mx, my, mw, mh, '#0f2a1d');
    const scroll = Math.floor(now / 350);
    for (let l = 0; l < 4; l++) {
      const seed = (scroll + l) * 9301 + i * 49297;
      const w = 4 + (seed % 13);
      const indent = (seed >> 3) % 3 * 2;
      rect(mx + 2 + indent, my + 2 + l * 3.4, Math.min(w, mw - 4 - indent), 2, ['#3fbf7f', '#8fd3ff', '#f2a93b'][(seed >> 5) % 3]);
    }
  } else if (st === 'bloqueado' && present) {
    rect(mx, my, mw, mh, now % 1000 < 500 ? '#7a1f1a' : '#4a1512');
    text('!', mx + mw / 2, my + mh / 2 + 0.5, 10, '#fff');
  } else if (st === 'concluido') { // a tela de pronto fica acesa mesmo com o agente longe da mesa
    rect(mx, my, mw, mh, '#1a3a7a');
    text('✓', mx + mw / 2, my + mh / 2 + 0.5, 10, '#fff');
  } else {
    rect(mx, my, mw, mh, '#22232d');
    rect(mx + 2, my + 2, 4, 2, '#33354a');
  }

  // luz da tela sobre a mesa (verde trabalhando, vermelha bloqueado, azul concluído)
  if (present && (st === 'trabalhando' || st === 'bloqueado' || st === 'concluido')) {
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = st === 'trabalhando' ? '#3fbf7f' : st === 'bloqueado' ? '#e5534b' : '#4f8cff';
    ctx.beginPath(); ctx.ellipse(c.x + 2.5 * T, dy + 0.35 * T, 24, 9, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // telefone: treme, pisca e toca quando o agente espera você (pergunta, permissão ou bloqueio)
  const ringing = !!(state.live?.[project.id]?.pending || st === 'bloqueado');
  const phx = c.x + 1.15 * T + (ringing ? Math.round(Math.sin(now / 45)) : 0), phy = dy + 0.3 * T;
  rect(phx, phy + 2, 9, 5, '#2b2f3e');
  rect(phx + 1, phy, 7, 3, ringing && now % 400 < 200 ? '#e5534b' : '#4a5070');
  if (ringing && now % 400 < 200) {
    for (const [ox, oy] of [[-3, -2], [10, -2], [-4, -5], [11, -5]]) rect(phx + ox, phy + oy, 2, 1, '#ffd166');
  }

  // teclado e caneca
  rect(c.x + 2 * T, dy + 0.5 * T, T, 4, '#d0d0d8');
  rect(c.x + 3.4 * T, dy + 0.25 * T, 5, 5, project.color || '#fff');

  // cadeira (assento; o encosto é desenhado depois do agente)
  rect(c.seat.x - 7, c.seat.y - 6, 14, 6, '#2d3142');
  if (!present) rect(c.seat.x - 7, c.seat.y - 2, 14, 7, '#3a3f55');

  text(truncate(project.name.toUpperCase(), 14), c.x + 2.5 * T, c.y + 4.25 * T, 7, '#fff');
}

// estilo do cabelo derivado do id: o mesmo agente tem sempre o mesmo visual
const HAIR_STYLES = ['curto', 'longo', 'coque'];
const hairStyle = (a) => {
  const i = HAIR_STYLES.indexOf(a.hairStyle);
  return i >= 0 ? i : [...String(a.id)].reduce((h, c) => h + c.charCodeAt(0), 0) % 3; // sem escolha: pelo id
};

function drawAgent(a, rt, now) {
  const x = Math.round(rt.x);
  const y = Math.round(rt.y) + Math.round((rt.sit || 0) * 2); // ao sentar, o corpo desce um pouco
  const step = rt.moving ? Math.floor(rt.walk / 4) % 2 : 0;
  const back = rt.facing === 'up';
  const skin = a.skin || '#f1c7a0', shirt = a.shirt || '#4f8cff', hair = a.hair || '#3b2416';
  // respiração: a cabeça sobe e desce 1px de tempos em tempos quando parado
  const hb = !rt.moving && Math.floor(now / 900 + a.name.length) % 2 ? 1 : 0;

  shadow(x, Math.round(rt.y), 15, 5.5, 0.34);

  // pernas e sapatos
  rect(x - 4, y - 6, 3, 6 - (step ? 1 : 0), '#2a2f45');
  rect(x + 1, y - 6, 3, 6 - (step ? 0 : 1), '#2a2f45');
  rect(x - 5, y - (step ? 1 : 2), 4, 2, '#15171f');
  rect(x + 1, y - (step ? 2 : 1), 4, 2, '#15171f');
  // corpo (com uma faixa mais escura na barra da camisa)
  rect(x - 5, y - 12 + hb, 10, 7 - hb, shirt);
  rect(x - 5, y - 6, 10, 1, '#0003');
  rect(x + 2, y - 12 + hb, 3, 7 - hb, '#0000002e'); // lado do corpo longe da luz
  // braços: comemorando (concluído), pedindo ajuda (bloqueado) ou balançando ao andar
  const seatedNow = rt.seated;
  const swing = rt.moving ? (step ? 1 : -1) : 0;
  const cheer = false; // concluído fica sentado em repouso (sem braços para cima)
  const wave = seatedNow && a.status === 'bloqueado';
  const lUp = cheer || (wave && Math.floor(now / 250) % 2 === 0), rUp = cheer;
  const arm = (ax, up, sw) => {
    if (up) { rect(ax, y - 19 + hb, 2, 6, shirt); rect(ax, y - 21 + hb, 2, 2, skin); }
    else { rect(ax, y - 11 + hb + sw, 2, 5, shirt); rect(ax, y - 6 + sw, 2, 2, skin); }
  };
  arm(x - 7, lUp, swing);
  arm(x + 5, rUp, -swing);
  // pescoço e cabeça
  rect(x - 1, y - 13 + hb, 2, 2, skin);
  const hy = y - 20 + hb;
  rect(x - 4, hy, 8, 8, skin);
  rect(x + 2, hy + 1, 2, 7, '#0000001c'); // sombra do rosto
  const style = hairStyle(a);
  if (back) {
    rect(x - 4, hy - 1, 8, style === 1 ? 12 : 8, hair);
    if (style === 2) rect(x - 2, hy - 4, 4, 3, hair);
  } else {
    rect(x - 4, hy - 1, 8, 3, hair);
    rect(x - 5, hy, 1, style === 1 ? 10 : 5, hair);
    rect(x + 4, hy, 1, style === 1 ? 10 : 5, hair);
    if (style === 2) rect(x - 2, hy - 4, 4, 3, hair);
    const eo = rt.facing === 'left' ? -1 : rt.facing === 'right' ? 1 : 0;
    if (now % 4000 >= 120) { rect(x - 2 + eo, hy + 4, 1, 2, '#1a1a1a'); rect(x + 1 + eo, hy + 4, 1, 2, '#1a1a1a'); }
    // sobrancelhas e boca mudam com o humor: tensos se bloqueado, sorriso se concluído
    if (a.status === 'bloqueado') { rect(x - 3 + eo, hy + 3, 2, 1, hair); rect(x + 1 + eo, hy + 3, 2, 1, hair); rect(x - 1 + eo, hy + 7, 2, 1, '#8a3b32'); }
    else if (a.status === 'concluido') { rect(x - 2 + eo, hy + 6, 4, 1, '#a5553f'); rect(x - 2 + eo, hy + 5, 1, 1, '#a5553f'); rect(x + 1 + eo, hy + 5, 1, 1, '#a5553f'); }
    else rect(x - 1 + eo, hy + 7, 2, 1, '#a5553f');
  }

  // acessórios (de costas só aparece o que fica por fora da cabeça)
  if (a.accessory === 'oculos' && !back) {
    const eo = rt.facing === 'left' ? -1 : rt.facing === 'right' ? 1 : 0;
    rect(x - 3 + eo, hy + 3, 3, 3, '#1a1a1acc'); rect(x + eo, hy + 3, 3, 3, '#1a1a1acc'); rect(x - 1 + eo, hy + 4, 2, 1, '#1a1a1a');
  } else if (a.accessory === 'fone') {
    rect(x - 5, hy - 2, 10, 2, '#2d3142'); // arco
    rect(x - 6, hy + 1, 2, 5, '#e5534b'); rect(x + 4, hy + 1, 2, 5, '#e5534b'); // conchas
  } else if (a.accessory === 'bone') {
    rect(x - 5, hy - 3, 10, 4, '#e5534b');
    if (!back) rect(x - 5 + (rt.facing === 'left' ? -2 : 0), hy + 1, rt.facing === 'left' ? 7 : 12, 1, '#b33a33'); // aba
  }

  // digitando: mãos alternando sobre o teclado
  if (seatedNow && a.status === 'trabalhando') {
    const k = Math.floor(now / 140) % 2;
    rect(x - 5, y - 24 - k, 3, 2, skin);
    rect(x + 2, y - 24 - (1 - k), 3, 2, skin);
  }
}

function drawChairBack(rt) {
  rect(rt.x - 7, rt.y - 4, 14, 9, '#3a3f55');
  rect(rt.x - 7, rt.y - 4, 14, 2, '#4a5070');
}

const TALK = ['💡', '📊', '👍', '🤔', '📈', '✅', '😂', '📌'];

function drawLabels(a, rt, now, talkers) {
  const isSel = selected?.kind === 'project' && deskOf(a.id)?.project.id === selected.id;
  const y = rt.y - 27; // acima da cabeça
  const nameY = rt.seated ? rt.y + 9 : y; // sentado: nome embaixo da cadeira, para não tampar o monitor
  text(a.name, rt.x, nameY, 7, isSel ? '#ffd166' : '#fff');
  const st = STATUS[a.status] || STATUS.ocioso;
  ctx.fillStyle = st.color;
  ctx.beginPath(); ctx.arc(rt.x + a.name.length * 7 / SCALE / 2 + 4, nameY, 2, 0, Math.PI * 2); ctx.fill();

  // o que o agente faz em cada área
  const act = rt.atSpot?.act;
  const phase = Math.floor(now / 2500);
  if (act === 'cafe' && phase % 3 === 0) text('☕', rt.x + 8, y - 6, 8, '#fff');
  else if (act === 'reuniao') {
    // em grupo, um fala de cada vez; sozinho, fica anotando
    const i = talkers.indexOf(a.id);
    const speaking = talkers.length > 1 ? phase % talkers.length === i : phase % 2 === 0;
    if (speaking) {
      const by = y - 9;
      rect(rt.x - 7, by - 6, 14, 11, '#fff');
      rect(rt.x - 1, by + 5, 2, 2, '#fff');
      text(talkers.length > 1 ? TALK[(phase + i) % TALK.length] : '📝', rt.x, by, 7, '#000');
    }
  } else if (act === 'puff') {
    const t = (now / 700) % 1;
    text('z', rt.x + 6 + t * 3, y - 2 - t * 6, 7, '#ffffffcc');
    text('Z', rt.x + 10 + t * 3, y - 9 - t * 6, 8, '#ffffff99');
  } else if (act === 'sofa' && phase % 4 === 1) text('📱', rt.x + 8, y - 6, 8, '#fff');
  else if (act === 'arcade' && phase % 3 === 0) text('🕹️', rt.x + 9, y - 6, 8, '#fff');
}

let animNow = 0; // relógio do quadro atual, para itens que se mexem (plantas)

// ---------- Vista 3D (Three.js) ----------
// O módulo office3d.js (e o Three.js, em public/vendor/) só é baixado quando a vista 3D é ligada. A lógica continua
// aqui (posições, status, caminhos); a cada quadro mandamos um "retrato" da cena e o módulo só desenha.
let view3d = load('hub.view3d') === true;
let v3 = null, v3loading = false, using3dNow = false;
let charStyle3d = load('hub.charStyle3d') === 'classico' ? 'classico' : 'novo'; // personagens novos ou clássicos

async function ensureV3() {
  if (v3 || v3loading) return;
  v3loading = true;
  try {
    const m = await import('./office3d.js');
    v3 = m.create3D({ canvas: canvas3d, wrap, onDrag: () => { suppressClick = true; } });
    v3.setCharStyle(charStyle3d);
  } catch (e) {
    console.error('3D indisponível:', e);
    view3d = false;
    store('hub.view3d', false);
    document.getElementById('btn-3d').classList.remove('active');
    alert('Não consegui iniciar a vista 3D neste navegador (o WebGL pode estar desligado). Voltando para a vista 2D.');
  } finally { v3loading = false; }
}

function setView3d(on) {
  if (on && moveMode) setMoveMode(false); // mover mesas e decorar usam a vista plana
  if (on && decorMode) setDecorMode(false);
  view3d = on;
  store('hub.view3d', on);
  document.getElementById('btn-3d').classList.toggle('active', on);
  if (on) ensureV3();
}

// mostra o canvas certo: salas de servidores continuam em 2D
function syncView() {
  const want = view3d && !!v3; // a sala de servidores também tem vista 3D
  if (want === using3dNow) return;
  using3dNow = want;
  canvas.hidden = want;
  canvas3d.hidden = !want;
  document.getElementById('btn-flip').hidden = !want;
  document.getElementById('btn-chars').hidden = !want;
  if (want) v3.resize(); else resize();
}

// emoji sobre a cabeça conforme o que o agente faz na área (mesma lógica do 2D)
function activityEmoji(a, rt, now, talkers) {
  const act = rt.atSpot?.act, phase = Math.floor(now / 2500);
  if (act === 'cafe' && phase % 3 === 0) return '☕';
  if (act === 'reuniao') {
    const i = talkers.indexOf(a.id);
    const speaking = talkers.length > 1 ? phase % talkers.length === i : phase % 2 === 0;
    return speaking ? (talkers.length > 1 ? TALK[(phase + i) % TALK.length] : '📝') : null;
  }
  if (act === 'puff') return '💤';
  if (act === 'sofa' && phase % 4 === 1) return '📱';
  if (act === 'arcade' && phase % 3 === 0) return '🕹️';
  return null;
}

// vista 3D da sala de servidores: racks em fileiras de até 6 (o 2D coloca todos lado a lado, o que fica largo demais)
const SV3D_COLS = 6, SV3D_ROW = 5.2, SV3D_PITCH = 3;
function svLayout3D() {
  const n = monitor.hosts.length, cols = Math.max(1, Math.min(SV3D_COLS, n)), rows = Math.max(1, Math.ceil(n / cols));
  const W = Math.max(9, cols * SV3D_PITCH + 3); // sala justa ao redor dos racks: com poucos hosts eles aparecem maiores
  return { W, H: WALL_H + 7 + (rows - 1) * SV3D_ROW, x0: W / 2 - ((cols - 1) * SV3D_PITCH) / 2 }; // x0: centro do primeiro rack
}

// resumo de cada unidade do rack (CPU, memória, disco, PM2, Docker e systemd) para a vista 3D
function rackUnits(h) {
  const pct = (v) => (v == null ? '?' : Math.round(v) + '%');
  const fill = (v) => (v == null ? 0 : Math.max(0, Math.min(1, v / 100)));
  const first = (g) => (g.names[0] ? ' · ' + truncate(g.names[0], 11) : '');
  const grp = (name, total, bad, warn, noteBad, noteWarn) => ({
    name, text: total == null ? '?' : String(total), fill: null, total: total ?? 0, bad: bad.count, warn: warn?.count || 0,
    color: bad.count ? MON_COLOR.critico : warn?.count ? MON_COLOR.atencao : MON_COLOR.ok,
    note: bad.count ? `${bad.count} ${noteBad}${first(bad)}` : warn?.count ? `${warn.count} ${noteWarn}${first(warn)}` : '',
    noteColor: bad.count ? MON_COLOR.critico : MON_COLOR.atencao,
  });
  return [
    { name: 'CARGA', text: pct(h.cpu), fill: fill(h.cpu), color: loadLevel(h.cpu) },
    { name: 'MEMÓRIA', text: pct(h.mem), fill: fill(h.mem), color: level(h.mem, 80, 90) },
    { name: 'DISCO', text: pct(h.disk), fill: fill(h.disk), color: level(h.disk, 80, 90) },
    grp('PM2', h.pm2.total, h.pm2.errored, h.pm2.highRestarts, 'com erro', 'reiniciando'),
    grp('DOCKER', h.docker.total, h.docker.unhealthy, null, 'sem saúde'),
    grp('SYSTEMD', h.systemd.total, h.systemd.failed, null, 'falhou'),
  ];
}

function snapshot3D(now) {
  const vis = visibleAgents();
  const desks = [];
  for (let i = 0; i < world.rows * world.cols; i++) {
    const p = world.byslot.get(i), c = cellOf(i);
    if (!p) { if (i === world.newSlot) desks.push({ empty: true, isNew: true, x: c.x, y: c.y }); continue; }
    const ag = state.agents.find((x) => x.id === p.agentId), rt = ag && runtime.get(ag.id);
    desks.push({
      id: p.id, name: p.name, color: p.color, x: c.x, y: c.y, seat: c.seat,
      status: ag?.status || 'ocioso', seated: !!rt?.seated,
      ringing: !!(state.live?.[p.id]?.pending || ag?.status === 'bloqueado'),
      selected: selected?.kind === 'project' && selected.id === p.id,
      hover: hover?.kind === 'project' && hover.id === p.id,
    });
  }
  const talkers = vis.filter((a) => runtime.get(a.id)?.atSpot?.act === 'reuniao').map((a) => a.id);
  const h = new Date().getHours();
  return {
    W: world.server ? svLayout3D().W : world.W, H: world.server ? svLayout3D().H : world.H, L: world.server ? (svLayout3D().W - 1) * T : world.L, floor: world.floor, // sala de servidores: o 3D tem tamanho próprio, o L do 2D deslocava a câmera do celular
    floorColors: FLOORS[world.floor] || FLOORS.madeira, wallColors: WALLS[world.wall] || WALLS.cinza,
    blocks: world.blocks, spots: world.spots, desks,
    decor: world.server ? [] : roomDecor().filter(decorFits),
    server: world.server ? {
      racks: monitor.hosts.map((h, i) => ({ host: h.host, status: h.status, cpu: h.cpu, uptime: h.uptime, alias: h.alias || null, units: rackUnits(h), col: i % SV3D_COLS, row: Math.floor(i / SV3D_COLS) })),
      x0: svLayout3D().x0, pitch: SV3D_PITCH, rowGap: SV3D_ROW,
      msg: monitor.denied ? 'SÓ A DONA DO HUB VÊ' : monitor.configured ? 'AGUARDANDO DADOS' : 'SEM MONITOR',
      hover: hover?.kind === 'rack' ? hover.host ?? '' : undefined, // '' = rack vazio (configurar)
    } : undefined,
    night: h >= 19 || h < 5, sky: skyColor(),
    counts: ['trabalhando', 'bloqueado', 'concluido', 'ocioso'].map((st) => vis.filter((a) => a.status === st).length),
    statusColors: ['trabalhando', 'bloqueado', 'concluido', 'ocioso'].map((st) => STATUS[st].color),
    statusLabels: ['trabalhando', 'bloqueado', 'concluido', 'ocioso'].map((st) => STATUS[st].label),
    coffee: vis.some((a) => runtime.get(a.id)?.atSpot?.act === 'cafe'),
    arcade: vis.some((a) => runtime.get(a.id)?.atSpot?.act === 'arcade'),
    agents: vis.map((a) => {
      const rt = runtime.get(a.id);
      return {
        id: a.id, name: a.name, shirt: a.shirt, hair: a.hair, skin: a.skin, hairStyle: a.hairStyle, accessory: a.accessory,
        outfit: a.outfit, second: a.second, shoe: a.shoe, pants: a.pants, skirt: a.skirt, tie: a.tie, look: a.look, // personalização explícita (opcional)
        status: a.status, statusColor: (STATUS[a.status] || STATUS.ocioso).color,
        sig: [a.shirt, a.hair, a.skin, a.hairStyle, a.accessory, a.outfit, a.second, a.shoe, a.pants, a.skirt, a.tie, JSON.stringify(a.look || null)].join('|'),
        emoji: activityEmoji(a, rt, now, talkers), rt,
      };
    }),
  };
}

function draw(now) {
  animNow = now;
  syncView();
  if (using3dNow) return v3.render(snapshot3D(now), now);
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  ctx.imageSmoothingEnabled = false;
  drawRoom(now);
  if (world.server) drawRacks(now);
  else for (let i = 0; i < world.rows * world.cols; i++) drawDesk(i, now);
  const hour = new Date().getHours();
  if (hour >= 19 || hour < 5) { ctx.globalAlpha = 0.16; rect(0, 0, world.W * T, world.H * T, '#0d1440'); ctx.globalAlpha = 1; }
  const furniture = roomDecor().filter((d) => DECOR_META[d.type]?.layer === 'piso' && decorFits(d)).sort((p, q) => p.y - q.y);
  for (const d of furniture) DECOR_DRAW[d.type](d.x * T, d.y * T, now);
  if (decorMode && decorHover) drawDecorCursor();
  if (moving) drawMoveGhost();
  else if (movePick != null) drawMovePick();

  const ordered = visibleAgents().map((a) => [a, runtime.get(a.id)]).sort((p, q) => p[1].y - q[1].y);
  for (const [a, rt] of ordered) {
    drawAgent(a, rt, now);
    if (rt.seated || rt.atSpot?.chair === 'bottom') drawChairBack(rt);
  }
  // vinheta: bordas um pouco mais escuras, o centro mais claro (sensação de ambiente iluminado)
  const vw = world.W * T, vh = world.H * T;
  const vg = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.3, vw / 2, vh / 2, Math.max(vw, vh) * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.34)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, vw, vh);
  const talkers = ordered.filter(([, rt]) => rt.atSpot?.act === 'reuniao').map(([a]) => a.id);
  for (const [a, rt] of ordered) drawLabels(a, rt, now, talkers);
}

// ---------- Loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (world) {
    // um erro num quadro não pode matar o laço (o canvas ficaria em branco até recarregar a página)
    try {
      update(dt, Date.now());
      draw(Date.now());
      updateBubbles();
    } catch (e) {
      ctx = mainCtx;
      if (!frame.warned) { frame.warned = true; console.error('erro no desenho do escritório:', e); }
    }
  }
  requestAnimationFrame(frame);
}

const MIN_ZOOM = 1, MAX_ZOOM = 6;

function resize() {
  if (!world) return;
  const ww = world.W * T, wh = world.H * T;
  const ch = wh;
  const fit = Math.floor(Math.min((wrap.clientWidth - 16) / ww, (wrap.clientHeight - 16) / ch));
  // celular: no mínimo 2x (a 1x o texto fica ilegível); o que passar da tela rola com o dedo
  SCALE = zoom ?? Math.max(innerWidth <= 760 ? 2 : MIN_ZOOM, Math.min(4, fit));
  if (canvas.width !== ww * SCALE || canvas.height !== ch * SCALE) {
    canvas.width = ww * SCALE;
    canvas.height = ch * SCALE;
  }
  document.getElementById('zoom-label').textContent = zoom == null ? 'Auto' : SCALE * 25 + '%';
}
window.addEventListener('resize', resize);

// Zoom em passos inteiros (pixel art nítida), mantendo parado o ponto sob o mouse.
function setZoom(next, cx, cy) {
  const r = wrap.getBoundingClientRect();
  cx ??= r.left + r.width / 2;
  cy ??= r.top + r.height / 2;
  const before = canvas.getBoundingClientRect();
  const wx = (cx - before.left) / SCALE, wy = (cy - before.top) / SCALE;
  zoom = next == null ? null : Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
  store('hub.zoom', zoom);
  resize();
  const after = canvas.getBoundingClientRect();
  wrap.scrollLeft += after.left + wx * SCALE - cx;
  wrap.scrollTop += after.top + wy * SCALE - cy;
}

document.getElementById('zoom-in').onclick = () => (using3dNow ? v3.zoomBy(0.8) : setZoom(SCALE + 1));
document.getElementById('zoom-out').onclick = () => (using3dNow ? v3.zoomBy(1.25) : setZoom(SCALE - 1));
document.getElementById('zoom-fit').onclick = () => (using3dNow ? v3.resetCamera() : setZoom(null));
document.getElementById('btn-flip').onclick = () => v3?.flip();
document.getElementById('btn-chars').onclick = () => {
  charStyle3d = charStyle3d === 'novo' ? 'classico' : 'novo';
  store('hub.charStyle3d', charStyle3d); v3?.setCharStyle(charStyle3d);
  document.getElementById('btn-chars').classList.toggle('active', charStyle3d === 'classico');
};
document.getElementById('btn-chars').classList.toggle('active', charStyle3d === 'classico');
document.getElementById('btn-3d').onclick = () => setView3d(!view3d);
document.getElementById('btn-3d').classList.toggle('active', view3d);
if (view3d) ensureV3();
wrap.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return; // roda sozinha rola; Ctrl+roda dá zoom
  e.preventDefault();
  setZoom(SCALE + (e.deltaY < 0 ? 1 : -1), e.clientX, e.clientY);
}, { passive: false });

// Arrastar o escritório com o mouse (quando ele é maior que a tela).
let drag = null, suppressClick = false;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1) e.preventDefault();
  if (e.button > 1) return;
  pointerKind = e.pointerType || 'mouse';
  if (moveMode && pointerKind !== 'touch' && startMove(e)) return;
  drag = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop, moved: false };
});
window.addEventListener('pointermove', (e) => {
  if (moving) { const c = cellAt(e); Object.assign(moving, { to: c.idx, wx: c.wx, wy: c.wy }); canvas.style.cursor = 'grabbing'; return; }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 5) {
    drag.moved = true;
    canvas.style.cursor = 'grabbing';
    tooltip.hidden = true;
  }
  if (drag.moved) {
    wrap.scrollLeft = drag.sl - dx;
    wrap.scrollTop = drag.st - dy;
  }
});
window.addEventListener('pointerup', () => {
  if (moving) return finishMove();
  if (drag?.moved) {
    suppressClick = true;
    canvas.style.cursor = '';
  }
  drag = null;
});

// ---------- Balões de fala (HTML por cima do canvas) ----------
const bubbleLayer = document.getElementById('bubbles');
const bubbleEls = new Map(); // agentId -> elemento

function bubbleFor(a) {
  const desk = deskOf(a.id);
  if (!desk) return null;
  const pend = state.live?.[desk.project.id]?.pending;
  if (pend?.questions) return { cls: 'urgent', text: '❓ Tenho uma pergunta!' };
  if (pend) return { cls: 'urgent', text: '✋ Posso? ' + truncate(pend.summary, 30) };
  if (a.status === 'bloqueado') return { cls: 'urgent', text: '✋ ' + truncate(a.message || 'Preciso de você', 34) };
  if (a.status === 'trabalhando') return { cls: 'working', text: truncate(a.message || 'Trabalhando', 34) };
  if (a.status === 'concluido') {
    // com muitos concluídos ao mesmo tempo, o texto vira só o ✓ (senão os balões cobrem a sala toda)
    const many = visibleAgents().filter((x) => x.status === 'concluido').length >= 4;
    return { cls: 'done' + (many ? ' compact' : ''), text: many ? '✓' : '✓ Pronto!' };
  }
  return null;
}

function updateBubbles() {
  const ox = canvas.offsetLeft, oy = canvas.offsetTop;
  const seen = new Set();
  for (const a of visibleAgents()) {
    const b = bubbleFor(a);
    const rt = runtime.get(a.id);
    if (!b || !rt) continue;
    seen.add(a.id);
    let el = bubbleEls.get(a.id);
    if (!el) {
      el = document.createElement('button');
      el.className = 'bubble';
      el.onclick = () => { const d = deskOf(a.id); if (d) openProjectWindow(d.project.id); };
      bubbleLayer.appendChild(el);
      bubbleEls.set(a.id, el);
    }
    const key = b.cls + '|' + b.text;
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.innerHTML = `<span class="b-inner ${b.cls}">${esc(b.text)}${b.cls === 'working' ? '<span class="dots"><i></i><i></i><i></i></span>' : ''}</span>`;
    }
    // sem sair do escritório (no celular os balões largos passavam da borda da tela)
    const half = el.offsetWidth / 2;
    let bx, byPx;
    if (using3dNow) {
      // 3D: ancora no ponto acima da cabeça, projetado na tela
      const q = v3.screenPos(rt.x, rt.y - (rt.seated ? 0.6 * T : 0), rt.seated ? 2.2 : 2.45);
      bx = Math.max(half, Math.min(canvas3d.clientWidth - half, q.x));
      byPx = q.y;
    } else {
      // sentado: acima do monitor; andando: acima do nome
      const by = rt.seated ? rt.y - 46 : rt.y - 34;
      bx = Math.max(ox + half, Math.min(ox + canvas.width - half, ox + rt.x * SCALE));
      byPx = oy + by * SCALE;
    }
    el.style.transform = `translate(${Math.round(bx)}px, ${Math.round(byPx)}px) translate(-50%, -100%)`;
  }
  for (const [id, el] of bubbleEls) if (!seen.has(id)) { el.remove(); bubbleEls.delete(id); }
}

// ---------- Interação no canvas ----------
function hitTest(ev) {
  if (using3dNow) return v3.pick(ev);
  const r = canvas.getBoundingClientRect();
  const wx = (ev.clientX - r.left) / SCALE, wy = (ev.clientY - r.top) / SCALE;
  const ordered = visibleAgents().map((a) => [a, runtime.get(a.id)]).sort((p, q) => q[1].y - p[1].y);
  for (const [a, rt] of ordered) {
    if (wx > rt.x - 8 && wx < rt.x + 8 && wy > rt.y - 24 && wy < rt.y + 2) return { kind: 'agent', id: a.id };
  }
  if (world.server) {
    const n = Math.max(1, monitor.hosts.length);
    for (let i = 0; i < n; i++) {
      const { x, y } = rackPos(i);
      if (wx > x && wx < x + RACK_W && wy > y && wy < y + RACK_H + 22) return { kind: 'rack', host: monitor.hosts[i]?.host || null };
    }
    return null;
  }
  for (let i = 0; i < world.rows * world.cols; i++) {
    const c = cellOf(i);
    if (wx > c.x + 0.5 * T && wx < c.x + 4.5 * T && wy > c.y + 0.5 * T && wy < c.y + 4.3 * T) {
      const p = world.byslot.get(i);
      if (p) return { kind: 'project', id: p.id };
      return i === world.newSlot ? { kind: 'slot' } : null;
    }
  }
  return null;
}

const onCanvasMove = (ev) => {
  if (drag?.moved) return;
  if (moveMode) { canvas.style.cursor = world.byslot.has(cellAt(ev).idx) ? 'grab' : 'default'; tooltip.hidden = true; return; }
  if (decorMode) { decorHover = decorTile(ev); canvas.style.cursor = 'crosshair'; tooltip.hidden = true; return; }
  hover = hitTest(ev);
  (using3dNow ? canvas3d : canvas).style.cursor = hover ? 'pointer' : 'default';
  if (!hover || hover.kind === 'slot') { tooltip.hidden = true; return; }
  let html;
  if (hover.kind === 'rack') {
    const h = monitor.hosts.find((x) => x.host === hover.host);
    html = h ? `<b>${esc(monName(h))}</b>${h.alias ? ` <span style="color:#9097b0">${esc(h.host)}</span>` : ''}<br>${MON_LABEL[h.status]} · carga 1 min ${h.cpu ?? '?'}% dos vCPUs · RAM ${h.mem ?? '?'}% · disco ${h.disk ?? '?'}%` : 'Monitor de servidores';
  } else if (hover.kind === 'agent') {
    const a = state.agents.find((x) => x.id === hover.id);
    html = `<b>${esc(a.name)}</b> · ${esc(a.role || '')}<br>${STATUS[a.status]?.label || ''}${a.message ? ' — ' + esc(a.message) : ''}`;
  } else {
    const p = state.projects.find((x) => x.id === hover.id);
    const a = state.agents.find((x) => x.id === p.agentId);
    html = `<b>${esc(p.name)}</b><br>${a ? esc(a.name) : 'Sem agente'}${p.description ? '<br><span style="color:#9097b0">' + esc(p.description) + '</span>' : ''}`;
  }
  tooltip.innerHTML = html;
  const wr = wrap.getBoundingClientRect();
  tooltip.style.left = ev.clientX - wr.left + wrap.scrollLeft + 14 + 'px';
  tooltip.style.top = ev.clientY - wr.top + wrap.scrollTop + 14 + 'px';
  tooltip.hidden = false;
};
const onCanvasLeave = () => { hover = null; decorHover = null; tooltip.hidden = true; };
canvas.addEventListener('mousemove', onCanvasMove);
canvas3d.addEventListener('mousemove', onCanvasMove);
canvas.addEventListener('mouseleave', onCanvasLeave);
canvas3d.addEventListener('mouseleave', onCanvasLeave);

const onCanvasClick = (ev) => {
  if (suppressClick) { suppressClick = false; return; } // foi um arrasto, não um clique
  if (decorMode) return placeDecor(decorTile(ev));
  if (moveMode) return tapMove(ev);
  const hit = hitTest(ev);
  if (!hit) return;
  if (hit.kind === 'rack') return openMonitorWindow(hit.host);
  if (hit.kind === 'slot') return openProjectDialog();
  if (hit.kind === 'project') return openProjectWindow(hit.id);
  const a = state.agents.find((x) => x.id === hit.id);
  const desk = deskOf(a.id);
  if (desk) openProjectWindow(desk.project.id);
  else openAgentDialog(a);
};
canvas.addEventListener('click', onCanvasClick);
canvas3d.addEventListener('click', onCanvasClick);

// ---------- Modo mover mesas ----------
function cellAt(ev) {
  const r = canvas.getBoundingClientRect();
  const wx = (ev.clientX - r.left) / SCALE, wy = (ev.clientY - r.top) / SCALE;
  const c = Math.floor((wx / T - DESK_X0) / CELL_W), row = Math.floor((wy / T - WALL_H) / CELL_H);
  const inside = c >= 0 && c < world.cols && row >= 0 && row < world.rows;
  return { idx: inside ? row * world.cols + c : null, wx, wy };
}

// Toque: o 1º toque escolhe a mesa, o 2º escolhe o destino (arrastar com o dedo travaria a rolagem).
function tapMove(ev) {
  if (pointerKind !== 'touch') return; // com o mouse, quem move é o arrasto
  const { idx } = cellAt(ev);
  if (movePick == null) {
    if (world.byslot.has(idx)) movePick = idx;
    return;
  }
  const from = movePick;
  movePick = null;
  if (idx == null || idx === from) return;
  moving = { id: world.byslot.get(from).id, from, to: idx, wx: 0, wy: 0 };
  finishMove();
}

function startMove(e) {
  const { idx, wx, wy } = cellAt(e);
  const p = world.byslot.get(idx);
  if (!p) return false;
  e.preventDefault();
  moving = { id: p.id, from: idx, to: idx, wx, wy };
  return true;
}

// Soltou: vai para a célula de destino; se já houver uma mesa lá, as duas trocam de lugar.
function finishMove() {
  const m = moving;
  moving = null;
  canvas.style.cursor = '';
  if (!m || m.to == null || m.to === m.from) return;
  const room = currentRoom(), cols = world.cols;
  const next = new Map(world.slotOf);
  const other = world.byslot.get(m.to);
  next.set(m.id, m.to);
  if (other) next.set(other.id, m.from);
  room.slots = Object.fromEntries([...next].map(([id, i]) => [id, { c: i % cols, r: Math.floor(i / cols) }]));
  world = computeWorld(); // aparece na hora; o hub confirma em seguida
  resize();
  api('PATCH', `/api/rooms/${room.id}`, { slots: room.slots }).catch(() => {});
}

function drawMovePick() {
  const x = (DESK_X0 + (movePick % world.cols) * CELL_W) * T, y = (WALL_H + Math.floor(movePick / world.cols) * CELL_H) * T;
  ctx.strokeStyle = ['#ffd166', '#fff'][Math.floor(Date.now() / 350) % 2];
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 0.5 * T, y + 0.5 * T, 4 * T, 4.1 * T);
  ctx.lineWidth = 1;
}

function drawMoveGhost() {
  const m = moving;
  if (m.to == null) return;
  const x = (DESK_X0 + (m.to % world.cols) * CELL_W) * T, y = (WALL_H + Math.floor(m.to / world.cols) * CELL_H) * T;
  const swap = m.to !== m.from && world.byslot.has(m.to);
  ctx.strokeStyle = m.to === m.from ? '#ffffff88' : swap ? '#f2a93b' : '#3fbf7f';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 0.5 * T, y + 0.5 * T, 4 * T, 4.1 * T);
  ctx.lineWidth = 1;
  const p = state.projects.find((q) => q.id === m.id);
  if (p) text(truncate(p.name.toUpperCase(), 14), m.wx, m.wy - 6, 7, '#ffd166');
}

function setMoveMode(on) {
  if (on && decorMode) setDecorMode(false);
  if (on && view3d) setView3d(false); // arrastar e decorar usam a vista plana
  moveMode = on;
  moving = null;
  movePick = null;
  document.getElementById('btn-move').classList.toggle('active', on);
  const bar = document.getElementById('decor-bar');
  bar.hidden = !on;
  bar.classList.toggle('wrap', on);
  canvas.style.cursor = '';
  if (on) {
    bar.innerHTML = `<span class="muted">${matchMedia('(pointer: coarse)').matches ? 'Toque numa mesa e depois no lugar de destino.' : 'Arraste uma mesa para outra posição.'} Se já houver uma mesa lá, as duas trocam de lugar.</span><button id="move-done">Concluir</button>`;
    bar.querySelector('#move-done').onclick = () => setMoveMode(false);
  }
  world = computeWorld();
  resize();
}
document.getElementById('btn-move').onclick = () => setMoveMode(!moveMode);

// ---------- Modo decorar ----------
let decorMode = false;
let decorTool = 'planta'; // tipo de item, ou 'apagar'
let decorHover = null; // { tx, ty } sob o ponteiro

function decorTile(ev) {
  const r = canvas.getBoundingClientRect();
  return { tx: Math.floor((ev.clientX - r.left) / SCALE / T), ty: Math.floor((ev.clientY - r.top) / SCALE / T) };
}

// itens do mesmo tipo de camada que ocupam o mesmo espaço (um tapete pode ficar sob um móvel)
const decorBox = (d) => ({ x: d.x, y: d.y, w: DECOR_META[d.type].w, h: DECOR_META[d.type].h });
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function placeDecor(t) {
  const room = currentRoom();
  if (!t || !room) return;
  let list = (room.decor || []).filter((d) => DECOR_META[d.type]);
  if (decorTool === 'apagar') {
    const hit = list.filter((d) => overlap(decorBox(d), { x: t.tx, y: t.ty, w: 1, h: 1 }));
    if (!hit.length) return;
    // com tapete embaixo de um móvel, apaga primeiro o de cima
    const top = hit.find((d) => DECOR_META[d.type].layer !== 'tapete') || hit[0];
    list = list.filter((d) => d !== top);
  } else {
    const m = DECOR_META[decorTool];
    const item = { type: decorTool, x: t.tx, y: m.layer === 'parede' ? 0 : t.ty };
    if (!decorFits(item)) return;
    list = list.filter((d) => DECOR_META[d.type].layer !== m.layer || !overlap(decorBox(d), decorBox(item)));
    list.push(item);
  }
  room.decor = list; // aparece na hora; o hub confirma em seguida
  api('PATCH', `/api/rooms/${room.id}`, { decor: list }).catch(() => {});
}

function drawDecorCursor() {
  const { tx, ty } = decorHover;
  const m = DECOR_META[decorTool] || { w: 1, h: 1, layer: 'piso' };
  const item = { type: decorTool, x: tx, y: m.layer === 'parede' ? 0 : ty };
  const ok = decorTool === 'apagar' || decorFits(item);
  ctx.strokeStyle = ok ? '#ffffff' : '#e5534b';
  ctx.lineWidth = 1;
  ctx.strokeRect(item.x * T + 0.5, item.y * T + 0.5, m.w * T - 1, m.h * T - 1);
}

function setDecorMode(on) {
  if (on && moveMode) setMoveMode(false);
  if (on && view3d) setView3d(false);
  decorMode = on;
  decorHover = null;
  document.getElementById('btn-decor').classList.toggle('active', on);
  const bar = document.getElementById('decor-bar');
  bar.hidden = !on;
  bar.classList.remove('wrap');
  canvas.style.cursor = '';
  if (on) renderDecorBar();
}

function renderDecorBar() {
  const bar = document.getElementById('decor-bar');
  bar.innerHTML = Object.entries(DECOR_META).map(([k, m]) =>
    `<button data-tool="${k}" class="${decorTool === k ? 'active' : ''}">${m.name}</button>`).join('') +
    `<button data-tool="apagar" class="${decorTool === 'apagar' ? 'active' : ''}">🧽 Apagar</button>` +
    '<span class="muted">Clique no escritório para colocar. A cor da parede e o piso ficam em ⚙ da sala.</span>';
  bar.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => { decorTool = b.dataset.tool; renderDecorBar(); }));
}
document.getElementById('btn-decor').onclick = () => setDecorMode(!decorMode);

// ---------- API ----------
// quiet: não mostra alerta (quem chamou trata o erro, ex.: e.code === 'repo_mismatch')
async function api(method, url, body, { quiet } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Env': state.env?.id || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) showLogin(); // sessão expirou
    else if (!quiet) alert(err.error || 'Erro ao falar com o servidor');
    throw Object.assign(new Error(err.error || 'Erro ao falar com o servidor'), { code: err.code, status: res.status });
  }
  return res.status === 204 ? null : res.json();
}

let events = null;
function connect() {
  events?.close();
  events = new EventSource('/api/events');
  events.onmessage = (e) => applyState(JSON.parse(e.data));
  events.addEventListener('chat', (e) => onChatEvent(JSON.parse(e.data)));
  // caiu: confere o login antes de reconectar (a sessão pode ter expirado)
  events.onerror = () => { events.close(); setTimeout(boot, 2000); };
}

// ---------- Login ----------
let me = null; // conta logada

async function boot() {
  let status;
  try {
    status = await fetch('/api/auth/status').then((r) => r.json());
  } catch {
    return setTimeout(boot, 3000); // hub fora do ar
  }
  if (!status.user) return showLogin(status.setup, status.setupCode);
  me = status.user;
  document.getElementById('login').hidden = true;
  connect();
  connectCommunity();
}

// setup: ainda não há conta; needCode: o hub está exposto e a primeira conta pede o código de instalação
function showLogin(setup = false, needCode = false) {
  events?.close();
  const box = document.getElementById('login');
  if (!box.hidden && box.dataset.setup === String(setup)) return;
  box.hidden = false;
  box.dataset.setup = String(setup);
  let mode = setup ? 'setup' : 'login';
  const render = () => {
    const signup = mode !== 'login';
    box.querySelector('.login-card').innerHTML = `
      <h1>TECHTIE HUB</h1>
      <h2>${mode === 'setup' ? 'Criar sua conta' : signup ? 'Criar conta com convite' : 'Entrar'}</h2>
      ${mode === 'setup' ? `<p class="muted">Primeira conta deste hub. ${needCode
        ? 'Depois você pode trazer o seu escritório em PC → Backup → Importar.'
        : 'O escritório que já existe aqui passa a ser seu.'}</p>` : ''}
      <form>
        ${signup ? '<label>Nome<input name="name" maxlength="40" autocomplete="name" /></label>' : ''}
        <label>E-mail<input name="email" type="email" required autocomplete="email" /></label>
        <label>Senha<input name="password" type="password" required minlength="${signup ? 8 : 1}" autocomplete="${signup ? 'new-password' : 'current-password'}" /></label>
        ${mode === 'invite' ? '<label>Código do convite<input name="invite" required placeholder="XXXX-XXXX" /></label>' : ''}
        ${mode === 'setup' && needCode ? `<label>Código de instalação<input name="setup" required placeholder="XXXX-XXXX" /></label>
          <p class="muted login-hint">Aparece nos logs do servidor (no Coolify: aba Logs) ou é o valor de HUB_SETUP_CODE.</p>` : ''}
        <p class="login-error" hidden></p>
        <div class="row"><button class="primary">${signup ? 'Criar conta' : 'Entrar'}</button></div>
      </form>
      ${mode === 'setup' ? '' : `<p class="muted login-switch"><a href="#" data-mode="${mode === 'login' ? 'invite' : 'login'}">
        ${mode === 'login' ? 'Recebi um convite' : 'Já tenho conta'}</a></p>`}`;
    const form = box.querySelector('form');
    form.querySelector('input').focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const err = form.querySelector('.login-error');
      const res = await fetch(`/api/auth/${signup ? 'signup' : 'login'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      if (!res.ok) {
        err.textContent = (await res.json().catch(() => ({}))).error || 'Não deu certo';
        err.hidden = false;
        return;
      }
      box.hidden = true;
      boot();
    };
    box.querySelector('[data-mode]')?.addEventListener('click', (e) => {
      e.preventDefault();
      mode = e.target.dataset.mode;
      render();
    });
  };
  render();
}

// ---------- Janela da conta ----------
function openAccountWindow() {
  const win = openWindow('account', { w: 400, h: 520, cls: 'win-account' }, (win) => {
    win.titleEl.textContent = '👤 Conta';
    win.body.innerHTML = `
      <p><b>${esc(me?.name || '')}</b><br><span class="muted">${esc(me?.email || '')}</span></p>
      <h3>Trocar senha</h3>
      <form data-form="password">
        <label>Senha atual<input name="current" type="password" required autocomplete="current-password" /></label>
        <label>Nova senha<input name="next" type="password" required minlength="8" autocomplete="new-password" /></label>
        <div class="row"><button>Trocar senha</button><span class="muted" data-field="pw-msg"></span></div>
      </form>
      ${me?.isOwner ? `<h3>Convidar alguém</h3>
      <p class="muted">A pessoa cria a própria conta, com um escritório só dela, usando este código (vale 7 dias e só uma vez).</p>
      <div data-field="invite"><div class="row"><button data-act="invite">Gerar convite</button></div></div>` : ''}
      <h3>Sessão</h3>
      <div class="row"><button class="danger" data-act="logout">Sair</button></div>`;
    win.body.querySelector('[data-form=password]').onsubmit = async (e) => {
      e.preventDefault();
      await api('POST', '/api/auth/password', Object.fromEntries(new FormData(e.target)));
      e.target.reset();
      win.body.querySelector('[data-field=pw-msg]').textContent = 'Senha trocada. As outras sessões foram encerradas.';
    };
    win.body.querySelector('[data-act=invite]')?.addEventListener('click', async () => {
      const inv = await api('POST', '/api/auth/invite', {});
      win.body.querySelector('[data-field=invite]').innerHTML = `<div class="code">${esc(inv.code)}</div>
        <p class="muted">Envie o código e o endereço do hub. A pessoa clica em “Recebi um convite” na tela de entrada.</p>`;
    });
    win.body.querySelector('[data-act=logout]').onclick = async () => {
      await api('POST', '/api/auth/logout', {});
      location.reload();
    };
  });
}

// ---------- Utilidades ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return new Date(t).toLocaleDateString('pt-BR');
}

const badge = (st) => `<span class="badge st-${st}">${(STATUS[st] || STATUS.ocioso).label}</span>`;

function logList(items) {
  if (!items.length) return '<p class="muted">Nada por aqui ainda.</p>';
  return items.slice(0, 80).map((l) => {
    const a = state.agents.find((x) => x.id === l.agentId);
    return `<div class="log-item"><time>${timeAgo(l.t)}</time>${a ? '<b>' + esc(a.name) + '</b> ' : ''}${esc(l.text)}</div>`;
  }).join('');
}

function renderStats() {
  const envBtn = document.getElementById('btn-env');
  envBtn.textContent = state.env ? 'PC: ' + state.env.name : 'PC: nenhum';
  envBtn.classList.toggle('warn', !state.env);
  const count = (st) => state.agents.filter((a) => a.status === st).length;
  document.getElementById('stats').innerHTML =
    `<span><b>${state.projects.length}</b> mesas</span><span><b>${state.agents.length}</b> agentes</span>` +
    Object.entries(STATUS).map(([k, v]) => `<span><i class="dot" style="background:${v.color}"></i>${count(k)} ${v.label.toLowerCase()}</span>`).join('');
  renderUsageBar();
}

// Barra com o limite de uso da conta Claude do PC em uso (como a tela "Account & Usage" do Claude Code).
const SUBSCRIPTION_NAMES = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };

// "em 3h", "em 20 min"… para quando o limite reinicia (resetsAt é no futuro)
function timeUntil(t) {
  const s = Math.floor((t - Date.now()) / 1000);
  if (s <= 0) return 'já';
  if (s < 60) return 'em instantes';
  if (s < 3600) return `em ${Math.ceil(s / 60)} min`;
  if (s < 86400) return `em ${Math.round(s / 3600)} h`;
  return `em ${Math.round(s / 86400)} dias`;
}

function usageMeter(label, m) {
  if (!m || m.percent == null) return '';
  const cls = m.percent >= 90 ? 'bad' : m.percent >= 70 ? 'warn' : 'ok';
  const resets = m.resetsAt ? timeUntil(new Date(m.resetsAt).getTime()) : '';
  return `<span class="usage-meter" title="${label}${resets ? ' · reinicia ' + esc(resets) : ''}">
    ${label} <i class="usage-fill ${cls}" style="--pct:${Math.min(100, m.percent)}%"></i> ${Math.round(m.percent)}%</span>`;
}

function renderUsageBar() {
  const box = document.getElementById('usage-bar');
  const u = state.env && state.usage?.[state.env.id];
  if (!u || (!u.fiveHour && !u.sevenDay)) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML =
    `<span class="muted">${u.subscription ? esc(SUBSCRIPTION_NAMES[u.subscription] || u.subscription) : 'Claude'} · ${esc(state.env.name)}</span>` +
    usageMeter('Sessão (5h)', u.fiveHour) + usageMeter('Semana', u.sevenDay);
}

// ---------- Janelas flutuantes ----------
const winLayer = document.getElementById('windows');
const wins = new Map(); // key -> { key, el, body, titleEl, minimized, projectId?, render? }
let zTop = 100;

function loadPos(key) {
  try { return JSON.parse(localStorage.getItem('hub.win.' + key)); } catch { return null; }
}

function savePos(win) {
  try {
    const el = win.el;
    localStorage.setItem('hub.win.' + win.key, JSON.stringify({
      x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: win.minimized ? win.h : el.offsetHeight,
    }));
  } catch {}
}

function placeWindow(win, x, y) {
  const w = win.el.offsetWidth || 300;
  win.el.style.left = Math.round(Math.max(80 - w, Math.min(innerWidth - 80, x))) + 'px';
  win.el.style.top = Math.round(Math.max(0, Math.min(innerHeight - 40, y))) + 'px';
}

function focusWindow(win) {
  win.el.style.zIndex = ++zTop;
  for (const w of wins.values()) w.el.classList.toggle('focused', w === win);
  if (win.projectId) selected = { kind: 'project', id: win.projectId };
}

function closeWindow(win) {
  win.el.remove();
  wins.delete(win.key);
  if (win.projectId && selected?.id === win.projectId) selected = null;
  updateHint();
}

function toggleMin(win) {
  win.minimized = !win.minimized;
  if (win.minimized) {
    win.h = win.el.offsetHeight;
    win.el.style.height = '';
  } else {
    win.el.style.height = win.h + 'px';
  }
  win.el.classList.toggle('min', win.minimized);
  savePos(win);
}

// anchor: ponto na tela perto de onde a janela deve abrir (ex.: a mesa clicada)
function openWindow(key, { w = 440, h = 560, anchor, cls = '' }, build) {
  let win = wins.get(key);
  if (win) {
    if (win.minimized) toggleMin(win);
    focusWindow(win);
    return win;
  }
  const el = document.createElement('section');
  el.className = 'win ' + cls;
  el.innerHTML = `
    <header class="win-bar">
      <span class="win-title"></span>
      <button class="win-btn" data-act="min" title="Minimizar">—</button>
      <button class="win-btn" data-act="close" title="Fechar">✕</button>
    </header>
    <div class="win-body"></div>`;
  winLayer.appendChild(el);
  win = { key, el, body: el.querySelector('.win-body'), titleEl: el.querySelector('.win-title'), minimized: false };
  wins.set(key, win);

  const saved = loadPos(key);
  const width = Math.min(saved?.w || w, innerWidth - 20);
  const height = Math.min(saved?.h || h, innerHeight - 90);
  el.style.width = width + 'px';
  el.style.height = height + 'px';
  let x = saved?.x, y = saved?.y;
  if (x == null) {
    x = anchor ? anchor.x + 24 : (innerWidth - width) / 2;
    if (anchor && x + width > innerWidth - 10) x = anchor.x - width - 24 - 4 * T * SCALE; // sem espaço: abre à esquerda da mesa
    y = anchor ? anchor.y - height / 2 : 90;
  }
  placeWindow(win, x, y);

  const bar = el.querySelector('.win-bar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const dx = e.clientX - el.offsetLeft, dy = e.clientY - el.offsetTop;
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => placeWindow(win, ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      savePos(win);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMin(win); });
  el.addEventListener('pointerdown', () => focusWindow(win));
  el.querySelector('[data-act=close]').onclick = () => closeWindow(win);
  el.querySelector('[data-act=min]').onclick = () => toggleMin(win);
  new ResizeObserver(() => { if (!win.minimized) savePos(win); }).observe(el);

  build(win);
  focusWindow(win);
  updateHint();
  return win;
}

function updateHint() {
  document.getElementById('hint').hidden = wins.size > 0;
}

// ---------- Janela da mesa: conversa com o agente ----------
const chats = new Map(); // projectId -> entries

function deskAnchor(projectId) {
  const i = world?.slotOf.get(projectId);
  if (i == null) return null;
  const c = cellOf(i);
  if (using3dNow) {
    const q = v3.screenPos(c.x + 4.5 * T, c.y + 2.5 * T, 1);
    const r3 = canvas3d.getBoundingClientRect();
    return { x: r3.left + q.x, y: r3.top + q.y };
  }
  const r = canvas.getBoundingClientRect();
  return { x: r.left + (c.x + 4.5 * T) * SCALE, y: r.top + (c.y + 2.5 * T) * SCALE };
}

function openProjectWindow(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  switchRoom(project.roomId); // abre na sala da mesa, para o balão e a mesa ficarem à vista
  const win = openWindow('p:' + projectId, { anchor: deskAnchor(projectId), cls: 'win-project' }, (win) => {
    win.projectId = projectId;
    win.body.innerHTML = `
      <div class="pw-toolbar"></div>
      <div class="pw-banner" hidden></div>
      <div class="chat-log"><p class="muted chat-empty">Carregando…</p></div>
      <div class="pending-box"></div>
      <div class="pw-activity" hidden></div>
      <div class="chat-input">
        <div class="attachments" hidden></div>
        <textarea rows="2"></textarea>
        <div class="row">
          <button class="primary" data-act="send">Enviar</button>
          <button class="danger" data-act="stop" hidden>Parar</button>
          <button data-act="attach" title="Anexar imagem (ou cole um print com Ctrl+V, ou arraste para a janela)">📎</button>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden />
          <span class="spacer"></span>
          <button data-act="reset" title="Compactar a conversa: guarda o essencial na memória e começa uma sessão limpa (menos tokens)">🧹</button>
        </div>
      </div>`;
    const input = win.body.querySelector('textarea');
    const sendBtn = win.body.querySelector('[data-act=send]');
    win.attachments = [];
    const sendMsg = async () => {
      const text = input.value.trim();
      const images = win.attachments;
      if ((!text && !images.length) || sendBtn.disabled) return;
      input.value = '';
      setAttachments(win, []);
      try {
        await api('POST', `/api/projects/${projectId}/chat`, {
          message: text,
          images: images.map(({ mediaType, data }) => ({ mediaType, data })),
        });
      } catch {
        input.value = text;
        setAttachments(win, images);
      }
    };
    // imagens: colar (Ctrl+V), arrastar para a janela ou 📎
    input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      addImages(win, files);
    });
    win.el.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) e.preventDefault();
    });
    win.el.addEventListener('drop', (e) => {
      const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      addImages(win, files);
    });
    const picker = win.body.querySelector('input[type=file]');
    win.body.querySelector('[data-act=attach]').onclick = () => picker.click();
    picker.onchange = () => {
      addImages(win, [...picker.files]);
      picker.value = '';
    };
    sendBtn.onclick = sendMsg;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    };
    win.body.querySelector('[data-act=stop]').onclick = () => api('POST', `/api/projects/${projectId}/stop`, {});
    win.body.querySelector('[data-act=reset]').onclick = async () => {
      if (!confirm('Compactar a conversa? O agente guarda um resumo na memória e começa uma sessão limpa.')) return;
      const btn = win.body.querySelector('[data-act=reset]');
      btn.textContent = '⏳';
      try {
        await api('POST', `/api/projects/${projectId}/reset`, {});
      } finally {
        btn.textContent = '🧹';
      }
      loadChat(projectId);
    };
    loadChat(projectId);
    refreshGit(win);
    setTimeout(() => input.focus(), 0);
  });
  updateProjectWindow(win);
}

function updateProjectWindow(win) {
  const p = state.projects.find((x) => x.id === win.projectId);
  if (!p) return closeWindow(win);
  const a = state.agents.find((x) => x.id === p.agentId);
  const live = state.live?.[p.id];

  win.titleEl.innerHTML = `<i class="dot" style="background:${esc(p.color)}"></i>${esc(p.name)}` +
    (a ? ` <span class="muted">·</span> ${esc(a.name)} ${badge(a.status)}` : ' <span class="muted">· mesa vaga</span>');

  // barra de ferramentas (não redesenha enquanto o usuário mexe no seletor)
  const tb = win.body.querySelector('.pw-toolbar');
  if (!tb.contains(document.activeElement)) {
    tb.innerHTML = `
      ${p.folder ? `<button data-act="folder" title="${esc(p.folder)}">📁 Pasta</button><button data-act="vscode">VS Code</button>` : ''}
      <button data-act="edit-desk" title="Editar mesa">⚙ Mesa</button>
      <button data-act="memory" title="O que o agente sabe deste projeto">🧠 Memória</button>
      ${p.role === 'secretaria' ? '' : '<button data-act="report" title="O agente resume o que aconteceu hoje nesta mesa e envia para a secretária">📋 Relatório</button>'}
      <select data-act="perm" title="Quando o agente pede permissão para agir nesta mesa">
        ${Object.entries(PERMISSION_NAMES).map(([k, v]) => `<option value="${k}" ${k === (p.permissionMode || '') ? 'selected' : ''}>🔐 ${v}</option>`).join('')}
      </select>
      <select data-act="assign" title="Agente nesta mesa">
        <option value="">— sem agente —</option>
        ${state.agents.map((x) => `<option value="${x.id}" ${x.id === p.agentId ? 'selected' : ''}>👤 ${esc(x.name)}</option>`).join('')}
      </select>
      ${a ? '<button data-act="edit-agent" title="Editar agente">✎</button>' : ''}
      ${a ? `<button class="model-chip" data-act="edit-agent" title="Modelo e esforço do agente (clique para mudar)">🤖 <span data-field="model"></span></button>` : ''}
`;
    const on = (act, fn) => tb.querySelectorAll(`[data-act=${act}]`).forEach((b) => (b.onclick = fn));
    on('folder', () => api('POST', `/api/projects/${p.id}/open`, { app: 'explorer' }));
    on('vscode', () => api('POST', `/api/projects/${p.id}/open`, { app: 'vscode' }));
    on('edit-desk', () => openProjectDialog(p));
    on('memory', () => openMemoryWindow(p.id));
    on('report', async (e) => {
      if (!confirm('Gerar o relatório de hoje desta mesa e enviar para a secretária?')) return;
      e.target.disabled = true;
      e.target.textContent = 'Gerando…';
      try {
        await api('POST', `/api/projects/${p.id}/report`, {});
        alert('📋 Relatório de hoje enviado para a secretária. Ele aparece em Memória → Relatórios de hoje.');
      } finally {
        e.target.disabled = false;
        e.target.textContent = '📋 Relatório';
      }
    });
    on('edit-agent', () => openAgentDialog(a));
    tb.querySelector('[data-act=assign]').onchange = (e) => api('PATCH', `/api/projects/${p.id}`, { agentId: e.target.value || null });
    tb.querySelector('[data-act=perm]').onchange = (e) => {
      if (!setPermissionMode(p, e.target.value)) e.target.value = p.permissionMode || '';
    };
  }

  const who = a ? a.name : 'o agente';
  const input = win.body.querySelector('textarea');
  const canChat = !!p.runEnv; // a secretária não precisa de pasta de projeto
  input.placeholder = p.role === 'secretaria'
    ? `Peça algo para ${who}… (ex.: leia minhas mensagens no Bitrix e passe a demanda para a mesa certa)`
    : p.runEnv ? `Peça algo para ${who}… (Enter envia · Shift+Enter quebra linha)` : 'Defina a pasta do projeto primeiro';
  input.disabled = !canChat;
  const send = win.body.querySelector('[data-act=send]');
  send.disabled = !canChat || !!live?.running;
  send.textContent = live?.running ? 'Trabalhando…' : 'Enviar';
  win.body.querySelector('[data-act=stop]').hidden = !live?.running;
  win.body.querySelector('[data-act=reset]').disabled = !!live?.running;
  renderPending(win, p, live?.pending);
  renderModel(win, a, live);
  renderActivity(win);
  // terminou uma rodada: o commit pode ter mudado
  if (win.wasRunning && !live?.running) refreshGit(win);
  win.wasRunning = !!live?.running;
  renderBanner(win, p);
}

// Avisos da janela da mesa: pasta não configurada neste PC e commit diferente do que o agente lembra.
function renderBanner(win, p) {
  const box = win.body.querySelector('.pw-banner');
  const envName = state.env?.name || 'este PC';
  const msgs = [];
  const l = state.live?.[p.id];
  if (l?.running && l.envId !== state.env?.id) {
    msgs.push(`⚙️ Este pedido está rodando no PC <b>${esc(state.connectors?.[l.envId]?.name || state.environments?.[l.envId]?.name || 'outro PC')}</b>. Você pode acompanhar e responder daqui.`);
  }
  const queued = state.queue?.[p.id]?.length;
  if (queued) msgs.push(`📨 ${queued} demanda${queued > 1 ? 's' : ''} da secretária na fila: começa${queued > 1 ? 'm' : ''} sozinha${queued > 1 ? 's' : ''} quando a mesa ficar livre.`);
  if (state.env && outdated(state.env.id)) {
    msgs.push(state.connectors[state.env.id].version
      ? `🔄 O conector do PC <b>${esc(state.env.name)}</b> está se atualizando (espera as tarefas em andamento terminarem).`
      : `⚠️ O conector do PC <b>${esc(state.env.name)}</b> é de uma versão antiga: imagens, modelo e permissões não funcionam nele. ` +
        'Baixe o conector de novo nesse PC (<b>PC → Conectar um PC → Baixar conector</b>) e extraia por cima. Depois disso ele passa a se atualizar sozinho.');
  }
  const runName = (envId) => state.connectors?.[envId]?.name || 'outro PC';
  if (p.runEnv && p.runEnv !== state.env?.id && !l?.running && p.role !== 'secretaria') {
    msgs.push(`🛰 Os pedidos desta mesa rodam no PC <b>${esc(runName(p.runEnv))}</b>, onde está a pasta dela. Dá para usar daqui normalmente, inclusive pelo celular.`);
  } else if (!state.env && !p.runEnv) {
    msgs.push(Object.keys(state.connectors || {}).length
      ? '🖥 Escolha em qual PC executar no botão <b>PC</b> (topo).'
      : '🖥 Nenhum PC conectado ao hub. Abra o botão <b>PC</b> para conectar o seu computador.');
  } else if (!p.runEnv && !p.folder && p.role !== 'secretaria') {
    const others = Object.entries(p.folders || {})
      .map(([envId, f]) => `<b>${esc(state.environments?.[envId]?.name || 'outro PC')}</b>: ${esc(f)}`);
    msgs.push(others.length
      ? `📁 Esta mesa ainda não tem pasta em <b>${esc(envName)}</b>. Ela está em ${others.join(', ')}. Clone ou copie o projeto aqui e escolha a pasta em <b>⚙ Mesa</b>.`
      : 'Escolha a pasta do projeto em <b>⚙ Mesa</b> para conversar com o agente.');
  }
  const g = win.git;
  const short = (sha) => `<code>${esc(sha.slice(0, 7))}</code>`;
  if (p.folder && g?.git && g.state === 'missing') {
    msgs.push(`⚠️ O agente parou no commit ${short(g.last)}, que não existe nesta pasta. Dê <code>git pull</code> antes de continuar.`);
  } else if (p.folder && g?.git && g.state === 'diverged') {
    msgs.push(`⚠️ Esta pasta (${short(g.head)} em ${esc(g.branch)}) seguiu outro caminho desde o commit ${short(g.last)} em que o agente parou. Confira a branch antes de continuar.`);
  }
  const html = msgs.map((m) => `<p>${m}</p>`).join('');
  if (box.innerHTML !== html) box.innerHTML = html;
  box.hidden = !msgs.length;
}

// Etiqueta do modelo: o que está rodando agora (ou rodou por último) + a escolha do agente.
function renderModel(win, a, live) {
  const el = win.body.querySelector('[data-field=model]');
  if (!el || !a) return;
  const running = prettyModel(live?.model || win.lastModel);
  const chosen = a.model ? MODEL_NAMES[a.model] : 'padrão do PC';
  const effort = a.effort ? ' · ' + EFFORT_NAMES[a.effort].toLowerCase() : '';
  el.textContent = (running && (!a.model || running.toLowerCase().startsWith(a.model)) ? running : chosen) + effort;
}

// Linha de atividade com cronômetro: mostra se o agente está pensando ou esperando uma
// ferramenta (ex.: um MCP lento). Atualizada a cada segundo enquanto há janelas abertas.
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

function renderActivity(win) {
  const box = win.body.querySelector('.pw-activity');
  const l = state.live?.[win.projectId];
  if (!box) return;
  if (!l?.running) { box.hidden = true; return; }
  let text;
  if (l.offline) text = '📡 O PC desconectou — aguardando ele voltar (até 90 s)…';
  else if (l.pending) text = '✋ Esperando você responder acima';
  else if (!l.phase) text = '⏳ Começando…';
  else {
    const elapsed = Date.now() - clockOffset - l.phase.since;
    text = l.phase.kind === 'tool' ? `🔧 Esperando ${l.phase.name} · ${fmtElapsed(elapsed)}` : `💭 Pensando · ${fmtElapsed(elapsed)}`;
    if (elapsed > 3 * 60000) text += l.phase.kind === 'tool'
      ? ' — a ferramenta está demorando; se parecer travado, use Parar'
      : ' — tarefa grande; se parecer travado, use Parar';
  }
  box.textContent = text;
  box.hidden = false;
}

setInterval(() => {
  for (const w of wins.values()) if (w.projectId) renderActivity(w);
}, 1000);

// conector do PC com versão diferente da que o hub entrega (sem versão = muito antigo)
function outdated(envId) {
  const c = state.connectors?.[envId];
  return !!c && !!state.connectorVersion && c.version !== state.connectorVersion;
}

async function refreshGit(win) {
  try {
    win.git = await api('GET', `/api/projects/${win.projectId}/git`, undefined, { quiet: true });
  } catch {
    win.git = null;
  }
  const p = state.projects.find((x) => x.id === win.projectId);
  if (p && wins.has(win.key)) renderBanner(win, p);
}

// ---------- Janela da memória do escritório ----------
// Notas gerais + o bloco que cada mesa enviou + relatórios do dia. A secretária recebe tudo isso.
function openOfficeMemoryWindow() {
  const win = openWindow('office-memory', { w: 560, h: 640, cls: 'win-office' }, (win) => {
    win.titleEl.textContent = '🏢 Memória do escritório';
    win.render = renderOfficeMemory;
  });
  renderOfficeMemory(win);
}

function renderOfficeMemory(win) {
  if (win.body.contains(document.activeElement) && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) return;
  const mem = state.officeMemory || { general: '', projects: {} };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const reports = state.reports?.[today] || {};
  const name = (id) => state.projects.find((p) => p.id === id)?.name || '(mesa removida)';
  win.body.innerHTML = `
    <p class="muted">A visão geral do escritório. A <b>secretária</b> recebe tudo isto a cada pedido. Cada mesa envia o seu bloco
      em <b>🧠 Memória → 🏢 Enviar para o escritório</b>, e o seu relatório em <b>📋 Relatório</b>.</p>
    <h3>Notas gerais</h3>
    <textarea class="mem-text office-general" rows="5" placeholder="Regras da empresa, clientes, padrões, contatos…">${esc(mem.general || '')}</textarea>
    <div class="row"><button class="primary" data-act="save-general">Salvar notas</button><span class="muted" data-field="saved"></span></div>
    <h3>Projetos</h3>
    ${Object.entries(mem.projects).map(([id, b]) => `<details class="card office-block">
      <summary><b>${esc(name(id))}</b> <span class="muted">· ${b.agent ? esc(b.agent) + ' · ' : ''}${timeAgo(b.at)}</span></summary>
      <div class="msg-assistant office-text">${formatText(b.text)}</div>
      <div class="row"><button class="danger" data-rm="${id}">Tirar do escritório</button></div>
    </details>`).join('') || '<p class="muted">Nenhuma mesa enviou a memória ainda.</p>'}
    <h3>Recados para a secretária (hoje)</h3>
    ${(state.inbox || []).filter((m) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(m.at)) === today)
      .map((m) => `<div class="log-item"><time>${timeAgo(m.at)}</time><b>${esc(name(m.projectId))}</b>${m.agent ? ` (${esc(m.agent)})` : ''}: ${esc(m.text)}</div>`).join('')
      || '<p class="muted">Nenhum recado hoje.</p>'}
    <h3>Relatórios de hoje</h3>
    ${Object.entries(reports).map(([id, r]) => `<details class="card office-block">
      <summary><b>${esc(name(id))}</b> <span class="muted">· ${r.agent ? esc(r.agent) + ' · ' : ''}${timeAgo(r.at)}</span></summary>
      <div class="msg-assistant office-text">${formatText(r.text)}</div>
    </details>`).join('') || '<p class="muted">Nenhum relatório hoje.</p>'}`;
  win.body.querySelector('[data-act=save-general]').onclick = async () => {
    await api('PUT', '/api/office-memory', { general: win.body.querySelector('.office-general').value });
    win.body.querySelector('[data-field=saved]').textContent = 'Salvo.';
  };
  win.body.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
    if (confirm('Tirar este bloco da memória do escritório? (A memória da mesa continua.)')) await api('DELETE', `/api/office-memory/${b.dataset.rm}`);
  }));
}

// ---------- Janela de servidores MCP ----------
// Os servidores ficam no hub (segredos criptografados) e vão para os agentes de qualquer PC.
// A lista não vem no estado do escritório (tem dados sensíveis): é buscada ao abrir.
const MCP_STATUS = {
  connected: '✓ conectado',
  failed: '✗ falhou',
  'needs-auth': '🔑 precisa de login (OAuth) no PC',
  disabled: 'desligado',
  pending: '… sem resposta',
};

function openMcpWindow() {
  const win = openWindow('mcp', { w: 580, h: 620, cls: 'win-mcp' }, (win) => {
    win.titleEl.textContent = '🔌 Servidores MCP';
  });
  loadMcp(win);
}

async function loadMcp(win) {
  win.mcp = await api('GET', '/api/mcp');
  renderMcp(win);
}

const projectName = (id) => state.projects.find((p) => p.id === id)?.name || '(mesa removida)';

function renderMcp(win) {
  const list = win.mcp || [];
  win.body.innerHTML = `
    <p class="muted">Servidores MCP dão ferramentas extras aos agentes (Bitrix, bancos de dados, APIs…). Configurados aqui,
      funcionam em <b>qualquer PC conectado</b>, sem <code>.mcp.json</code> na pasta. URLs, tokens e variáveis ficam criptografados no hub.</p>
    <div class="row">
      <button class="primary" data-act="add">+ Adicionar</button>
      <button data-act="scan" title="Procura os MCPs que o Claude Code do PC em uso já conhece">Importar do PC${state.env ? ' ' + esc(state.env.name) : ''}</button>
    </div>
    <div class="mcp-scan"></div>
    <h3>Servidores</h3>
    ${list.map((s) => `<div class="card mcp-card" data-id="${s.id}">
      <div class="title"><i class="dot" style="background:${!s.enabled ? 'var(--muted)' : s.lastTest?.status === 'connected' ? 'var(--ok)' : s.lastTest ? 'var(--bad)' : 'var(--line)'}"></i>
        ${esc(s.name)} <span class="mcp-type">${s.type === 'stdio' ? 'programa' : s.type.toUpperCase()}</span>
        ${s.enabled ? '' : '<span class="muted">(desligado)</span>'}</div>
      <div class="sub mono">${esc(s.type === 'stdio' ? [s.command, ...s.args].join(' ') : s.url)}</div>
      <div class="sub">Mesas: ${s.projects === 'all' ? 'todas' : esc(s.projects.map(projectName).join(', ') || 'nenhuma')}</div>
      ${s.lost?.length ? `<div class="sub" style="color:var(--bad)">⚠️ Segredo guardado com outra chave: ${esc(s.lost.join(', '))}. Edite e digite de novo.</div>` : ''}
      ${s.lastTest ? `<div class="sub">Último teste: ${MCP_STATUS[s.lastTest.status] || esc(s.lastTest.status)}${s.lastTest.status === 'connected' ? ` · ${s.lastTest.tools} ferramentas` : ''} · ${timeAgo(s.lastTest.at)}</div>` : ''}
      <div class="mcp-test-result"></div>
      <div class="row">
        <button data-act="test">Testar</button><button data-act="edit">Editar</button>
        <button data-act="toggle">${s.enabled ? 'Desligar' : 'Ligar'}</button><button class="danger" data-act="del">Remover</button>
      </div>
    </div>`).join('') || '<p class="muted">Nenhum servidor ainda. Adicione ou importe do PC.</p>'}`;

  win.body.querySelector('[data-act=add]').onclick = () => openMcpDialog(win);
  win.body.querySelector('[data-act=scan]').onclick = () => scanMcp(win);
  win.body.querySelectorAll('.mcp-card').forEach((card) => {
    const s = list.find((x) => x.id === card.dataset.id);
    const on = (act, fn) => (card.querySelector(`[data-act=${act}]`).onclick = fn);
    on('edit', () => openMcpDialog(win, s));
    on('toggle', async () => { await api('PATCH', `/api/mcp/${s.id}`, { enabled: !s.enabled }); loadMcp(win); });
    on('del', async () => {
      if (!confirm(`Remover o servidor "${s.name}"? Os agentes perdem acesso às ferramentas dele.`)) return;
      await api('DELETE', `/api/mcp/${s.id}`);
      loadMcp(win);
    });
    on('test', async (e) => {
      const out = card.querySelector('.mcp-test-result');
      e.target.disabled = true;
      out.innerHTML = `<p class="muted">Ligando o servidor no PC ${esc(state.env?.name || '')}…</p>`;
      try {
        const r = await api('POST', `/api/mcp/${s.id}/test`, {}, { quiet: true });
        const hint = r.lost?.length
          ? `Estes segredos não abrem mais (HUB_SECRET_KEY mudou depois de cadastrar): edite e digite de novo: ${esc(r.lost.join(', '))}.`
          : r.status === 'needs-auth'
            ? (!r.sent?.length ? 'Nenhum cabeçalho foi enviado: edite o servidor e preencha, por exemplo, <code>Authorization: Bearer seu-token</code>.'
              : `O servidor recusou o que foi enviado (${esc(r.sent.join(', '))}): confira se o token está certo e completo, com "Bearer " na frente, e se não expirou.`)
            : '';
        out.innerHTML = `<p><b>${MCP_STATUS[r.status] || esc(r.status)}</b>${r.error ? ` <span class="muted">— ${esc(r.error)}</span>` : ''}</p>
          ${r.sent ? `<p class="muted">Enviado: ${r.sent.length ? esc(r.sent.join(', ')) : 'nenhum cabeçalho/variável'}</p>` : ''}
          ${hint ? `<p class="login-error">${hint}</p>` : ''}
          ${r.tools.length ? `<div class="mcp-tools">${r.tools.map((t) => `<code title="${esc(t.description)}">${esc(t.name)}</code>`).join(' ')}</div>` : ''}`;
        setTimeout(() => loadMcp(win), 4000); // atualiza o "último teste"
      } catch (err) {
        out.innerHTML = `<p class="login-error">${esc(err.message)}</p>`;
      } finally {
        e.target.disabled = false;
      }
    });
  });
}

async function scanMcp(win) {
  const box = win.body.querySelector('.mcp-scan');
  box.innerHTML = `<p class="muted">Procurando no PC ${esc(state.env?.name || '')}…</p>`;
  let r;
  try {
    r = await api('POST', '/api/mcp-scan', {}, { quiet: true });
  } catch (err) {
    box.innerHTML = `<p class="login-error">${esc(err.message)}</p>`;
    return;
  }
  if (!r.items.length) {
    box.innerHTML = '<p class="muted">Nenhum MCP encontrado nas configurações do Claude Code deste PC nem nos .mcp.json das pastas das mesas.</p>';
    return;
  }
  box.innerHTML = `<div class="pending">
    <div class="pending-title">Encontrados no PC</div>
    ${r.items.map((it) => `<label class="option"><input type="checkbox" value="${it.i}" ${it.exists ? '' : 'checked'} />
      <span><b>${esc(it.name)}</b> <span class="mcp-type">${it.type === 'stdio' ? 'programa' : it.type.toUpperCase()}</span>
      ${it.exists ? '<span class="muted">(já existe um com esse nome)</span>' : ''}<br>
      <span class="muted">${esc(it.source)} · ${esc(it.target || '')}</span></span></label>`).join('')}
    <div class="row"><button class="primary" data-act="import">Importar selecionados</button><button data-act="cancel">Cancelar</button></div>
  </div>`;
  box.querySelector('[data-act=cancel]').onclick = () => (box.innerHTML = '');
  box.querySelector('[data-act=import]').onclick = async () => {
    const picks = [...box.querySelectorAll('input:checked')].map((i) => +i.value);
    if (!picks.length) return;
    await api('POST', '/api/mcp-import', { scanId: r.scanId, picks });
    loadMcp(win);
  };
}

// ---------- Variáveis de ambiente do escritório ----------
function openVarsWindow() {
  const win = openWindow('vars', { w: 540, h: 600, cls: 'win-vars' }, (win) => {
    win.titleEl.textContent = '🔑 Variáveis do escritório';
  });
  loadVars(win);
}

async function loadVars(win) {
  win.vars = await api('GET', '/api/vars');
  renderVars(win);
}

function renderVars(win) {
  const list = win.vars || [];
  win.body.innerHTML = `
    <p class="muted">Webhooks, credenciais de banco, chaves de API… Ficam criptografadas no hub e chegam aos agentes como
      <b>variáveis de ambiente</b>, em qualquer PC conectado (ex.: <code>$BITRIX_WEBHOOK</code> no terminal,
      <code>process.env.PG_URL</code> no código). O agente sabe quais existem, mas não vê os valores aqui no chat.
      Nos servidores MCP, use <code>\${NOME}</code> na URL, nos cabeçalhos ou nas variáveis.</p>
    <div class="row"><button class="primary" data-act="add">+ Adicionar</button></div>
    <h3>Variáveis</h3>
    ${list.map((v) => `<div class="card var-card" data-id="${v.id}">
      <div class="title mono">${esc(v.name)}</div>
      ${v.description ? `<div class="sub">${esc(v.description)}</div>` : ''}
      <div class="sub mono">${esc(v.value)}</div>
      <div class="sub">Mesas: ${v.projects === 'all' ? 'todas' : esc(v.projects.map(projectName).join(', ') || 'nenhuma')}</div>
      ${v.lost ? '<div class="sub" style="color:var(--bad)">⚠️ Guardada com outra chave (HUB_SECRET_KEY mudou): edite e digite o valor de novo.</div>' : ''}
      <div class="row"><button data-act="edit">Editar</button><button class="danger" data-act="del">Remover</button></div>
    </div>`).join('') || '<p class="muted">Nenhuma variável ainda.</p>'}`;
  win.body.querySelector('[data-act=add]').onclick = () => openVarDialog(win);
  win.body.querySelectorAll('.var-card').forEach((card) => {
    const v = list.find((x) => x.id === card.dataset.id);
    card.querySelector('[data-act=edit]').onclick = () => openVarDialog(win, v);
    card.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm(`Remover a variável ${v.name}? Os agentes deixam de recebê-la.`)) return;
      await api('DELETE', `/api/vars/${v.id}`);
      loadVars(win);
    };
  });
}

function openVarDialog(win, v) {
  const projects = v?.projects || 'all';
  openDialog(`
    <h2>${v ? 'Editar variável' : 'Nova variável'}</h2>
    <label>Nome<input name="name" required maxlength="64" pattern="[A-Za-z_][A-Za-z0-9_]*" value="${esc(v?.name || '')}"
      placeholder="BITRIX_WEBHOOK" autocapitalize="characters" autocomplete="off" /></label>
    <label>Valor<textarea name="value" rows="2" ${v ? '' : 'required'} autocomplete="off" spellcheck="false"
      placeholder="https://… ou postgres://usuario:senha@host:5432/banco">${esc(v?.value || '')}</textarea></label>
    <label>Para que serve (o agente lê isto)<input name="description" maxlength="200" value="${esc(v?.description || '')}"
      placeholder="Webhook do Bitrix24 (REST) da empresa" /></label>
    <fieldset class="areas"><legend>Mesas que recebem esta variável</legend>
      <label class="option"><input type="radio" name="scope" value="all" ${projects === 'all' ? 'checked' : ''} /><span>Todas as mesas</span></label>
      <label class="option"><input type="radio" name="scope" value="some" ${projects === 'all' ? '' : 'checked'} /><span>Só estas:</span></label>
      <div class="mcp-projects">${state.projects.map((p) => `<label class="option"><input type="checkbox" name="proj" value="${p.id}"
        ${projects !== 'all' && projects.includes(p.id) ? 'checked' : ''} /><span>${esc(p.name)}</span></label>`).join('')}</div>
    </fieldset>
    ${v ? '<p class="muted dialog-hint">O valor com •••• está guardado e não aparece por segurança: deixe como está para manter, ou apague e digite um novo.</p>' : ''}
  `, async (d) => {
    const body = {
      name: d.name.trim(), value: d.value, description: d.description,
      projects: d.scope === 'all' ? 'all' : [...form.querySelectorAll('input[name=proj]:checked')].map((i) => i.value),
    };
    try {
      if (v) await api('PATCH', `/api/vars/${v.id}`, body, { quiet: true });
      else await api('POST', '/api/vars', body, { quiet: true });
      loadVars(win);
    } catch (e) {
      alert(e.message);
    }
  }, v && { label: 'Remover', confirm: `Remover a variável ${v.name}?`, action: async () => { await api('DELETE', `/api/vars/${v.id}`); loadVars(win); } });
}

// "Nome: valor" por linha <-> objeto (cabeçalhos); "NOME=valor" por linha <-> objeto (variáveis)
const toLines = (obj, sep) => Object.entries(obj || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
// aceita também o trecho do .mcp.json colado: { "Authorization": "Bearer …" } ou "Authorization": "Bearer …",
const unquote = (s) => s.trim().replace(/,$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
const fromLines = (text, sep) => {
  const raw = String(text || '').trim();
  try {
    const obj = JSON.parse(raw.startsWith('{') ? raw : `{${raw.replace(/,\s*$/, '')}}`);
    if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)]));
  } catch {}
  return Object.fromEntries(raw.split('\n').map((l) => l.trim()).filter((l) => l && l !== '{' && l !== '}')
    .map((l) => {
      // no formato JSON o separador é ":" mesmo nas variáveis
      const s = /^["']/.test(l) ? ':' : sep;
      const i = l.indexOf(s);
      return i < 0 ? [unquote(l), ''] : [unquote(l.slice(0, i)), unquote(l.slice(i + 1))];
    }));
};

function openMcpDialog(win, s) {
  const type = s?.type || 'http';
  const projects = s?.projects || 'all';
  openDialog(`
    <h2>${s ? 'Editar servidor MCP' : 'Novo servidor MCP'}</h2>
    ${s ? '' : `<details class="mcp-paste"><summary>Colar a configuração do .mcp.json</summary>
      <textarea rows="6" placeholder='{ "mcpServers": { "bitrix": { "type": "http", "url": "https://…", "headers": { "Authorization": "Bearer …" } } } }'></textarea>
      <div class="row"><button type="button" data-act="paste">Preencher com o JSON</button><span class="muted" data-field="paste-msg"></span></div>
    </details>`}
    ${s?.lost?.length ? `<p class="login-error">⚠️ Estes segredos foram guardados com outra chave (HUB_SECRET_KEY mudou) e não abrem mais: <b>${esc(s.lost.join(', '))}</b>. Digite de novo.</p>` : ''}
    <label>Nome (aparece nas ferramentas como mcp__nome__…)<input name="name" required maxlength="40" pattern="[A-Za-z0-9_\\-]+" value="${esc(s?.name || '')}" placeholder="bitrix" /></label>
    <label>Tipo<select name="type">
      <option value="http" ${type === 'http' ? 'selected' : ''}>HTTP (endereço na internet)</option>
      <option value="sse" ${type === 'sse' ? 'selected' : ''}>SSE (endereço na internet, formato antigo)</option>
      <option value="stdio" ${type === 'stdio' ? 'selected' : ''}>Programa no PC (comando)</option>
    </select></label>
    <div class="only-net">
      <label>URL<input name="url" value="${esc(s?.url || '')}" placeholder="https://…" /></label>
      <label>Cabeçalhos (um por linha: <code>Nome: valor</code>)<textarea name="headers" rows="3" placeholder="Authorization: Bearer …">${esc(toLines(s?.headers, ': '))}</textarea></label>
    </div>
    <div class="only-stdio">
      <label>Comando<input name="command" value="${esc(s?.command || '')}" placeholder="npx" /></label>
      <label>Argumentos (um por linha)<textarea name="args" rows="3" placeholder="-y&#10;nome-do-pacote-mcp">${esc((s?.args || []).join('\n'))}</textarea></label>
      <label>Variáveis de ambiente (uma por linha: <code>NOME=valor</code>)<textarea name="env" rows="3" placeholder="API_TOKEN=…">${esc(toLines(s?.env, '='))}</textarea></label>
      <p class="muted dialog-hint">O comando roda no PC que executa o pedido: ele precisa existir lá (ex.: Node.js para <code>npx</code>).</p>
    </div>
    <fieldset class="areas"><legend>Mesas que usam este servidor</legend>
      <label class="option"><input type="radio" name="scope" value="all" ${projects === 'all' ? 'checked' : ''} /><span>Todas as mesas</span></label>
      <label class="option"><input type="radio" name="scope" value="some" ${projects === 'all' ? '' : 'checked'} /><span>Só estas:</span></label>
      <div class="mcp-projects">${state.projects.map((p) => `<label class="option"><input type="checkbox" name="proj" value="${p.id}"
        ${projects !== 'all' && projects.includes(p.id) ? 'checked' : ''} /><span>${esc(p.name)}</span></label>`).join('')}</div>
    </fieldset>
    ${s ? '<p class="muted dialog-hint">Valores com •••• estão guardados e não aparecem por segurança: deixe como está para manter, ou apague e digite um novo.</p>' : ''}
  `, async (d) => {
    const body = { name: d.name.trim(), type: d.type };
    if (d.type === 'stdio') Object.assign(body, { command: d.command, args: d.args.split('\n').map((a) => a.trim()).filter(Boolean), env: fromLines(d.env, '=') });
    else Object.assign(body, { url: d.url.trim(), headers: fromLines(d.headers, ':') });
    body.projects = d.scope === 'all' ? 'all' : [...form.querySelectorAll('input[name=proj]:checked')].map((i) => i.value);
    try {
      if (s) await api('PATCH', `/api/mcp/${s.id}`, body, { quiet: true });
      else await api('POST', '/api/mcp', body, { quiet: true });
      loadMcp(win);
    } catch (e) {
      alert(e.message);
    }
  }, s && { label: 'Remover', confirm: `Remover o servidor "${s.name}"?`, action: async () => { await api('DELETE', `/api/mcp/${s.id}`); loadMcp(win); } });
  const sync = () => {
    const stdio = form.elements.type.value === 'stdio';
    form.querySelector('.only-net').hidden = stdio;
    form.querySelector('.only-stdio').hidden = !stdio;
    form.elements.url.required = !stdio;
    form.elements.command.required = stdio;
  };
  form.elements.type.onchange = sync;
  sync();
  // colar o JSON do .mcp.json: aceita { mcpServers: { nome: {...} } }, { nome: {...} } ou o servidor direto
  form.querySelector('[data-act=paste]')?.addEventListener('click', () => {
    const msg = form.querySelector('[data-field=paste-msg]');
    let obj;
    try {
      obj = JSON.parse(form.querySelector('.mcp-paste textarea').value);
    } catch {
      msg.textContent = 'JSON inválido';
      return;
    }
    let name = '';
    let cfg = obj.mcpServers || obj;
    if (!cfg.url && !cfg.command) [name, cfg] = Object.entries(cfg)[0] || [];
    if (!cfg || (!cfg.url && !cfg.command)) {
      msg.textContent = 'não achei url nem command';
      return;
    }
    if (name) form.elements.name.value = name.replace(/[^\w-]/g, '_');
    form.elements.type.value = cfg.command ? 'stdio' : cfg.type === 'sse' ? 'sse' : 'http';
    form.elements.url.value = cfg.url || '';
    form.elements.headers.value = toLines(cfg.headers, ': ');
    form.elements.command.value = cfg.command || '';
    form.elements.args.value = (cfg.args || []).join('\n');
    form.elements.env.value = toLines(cfg.env, '=');
    sync();
    msg.textContent = '✓ preenchido: confira e salve';
  });
}

// ---------- Janela de memória do agente ----------
function openMemoryWindow(projectId) {
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return;
  const win = openWindow('m:' + projectId, { w: 480, h: 520, cls: 'win-memory' }, (win) => {
    win.titleEl.innerHTML = `🧠 Memória · ${esc(p.name)}`;
    win.body.innerHTML = `
      <p class="muted mem-help">Resumo do que o agente sabe deste projeto. Ele recebe esta memória ao começar uma conversa nova
        ou ao continuar num PC onde a sessão completa não estiver disponível. Você pode editar à vontade.</p>
      <textarea class="mem-text" placeholder="Ainda não há memória. Ela é criada ao clicar em “Atualizar com a conversa” ou em “Nova conversa”."></textarea>
      <p class="muted mem-meta"></p>
      <div class="row">
        <button class="primary" data-act="save">Salvar</button>
        <button data-act="refresh" title="Pede ao Claude para resumir a conversa recente na memória">Atualizar com a conversa</button>
        <button data-act="share" title="Copia esta memória para a memória geral do escritório (a secretária enxerga)">🏢 Enviar para o escritório</button>
      </div>`;
    const text = win.body.querySelector('.mem-text');
    const meta = win.body.querySelector('.mem-meta');
    const load = async () => {
      const m = await api('GET', `/api/projects/${projectId}/memory`);
      text.value = m.memory;
      meta.textContent = (m.memoryAt ? 'Atualizada ' + timeAgo(m.memoryAt) : 'Nunca atualizada') +
        (m.lastCommit ? ` · último commit do agente: ${m.lastCommit.slice(0, 7)}` : '');
    };
    win.body.querySelector('[data-act=save]').onclick = async () => {
      await api('PUT', `/api/projects/${projectId}/memory`, { memory: text.value });
      meta.textContent = 'Salva agora';
    };
    win.body.querySelector('[data-act=share]').onclick = async (e) => {
      await api('PUT', `/api/projects/${projectId}/memory`, { memory: text.value }); // envia o que está na tela
      await api('POST', `/api/projects/${projectId}/share`, {});
      e.target.textContent = '✓ Enviada para o escritório';
    };
    win.body.querySelector('[data-act=refresh]').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Resumindo…';
      try {
        await api('POST', `/api/projects/${projectId}/memory`, {});
        await load();
      } finally {
        e.target.disabled = false;
        e.target.textContent = 'Atualizar com a conversa';
      }
    };
    load();
  });
}

// ---------- Janela "Este PC": nome, outros PCs, exportar/importar ----------
function openEnvWindow() {
  const win = openWindow('env', { w: 460, h: 580, cls: 'win-env' }, (win) => {
    win.titleEl.textContent = '🖥 PCs';
    win.render = renderEnv;
  });
  renderEnv(win);
}

function renderEnv(win) {
  if (win.body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // não atrapalha quem digita
  const online = state.connectors || {};
  // PCs pareados com a conta (para poder remover); recarrega quando alguém conecta/desconecta
  const onlineKey = Object.keys(online).sort().join();
  if (win.onlineKey !== onlineKey) {
    win.onlineKey = onlineKey;
    api('GET', '/api/connectors', undefined, { quiet: true }).then((list) => {
      win.paired = list;
      renderEnv(win);
    }).catch(() => {});
  }
  const paired = Object.fromEntries((win.paired || []).map((c) => [c.envId, c]));
  const envs = Object.entries(state.environments || {}).sort((a, b) => (b[0] in online) - (a[0] in online) || b[1].lastSeen - a[1].lastSeen);
  const p = win.pairing && win.pairing.exp > Date.now() ? win.pairing : null;
  win.body.innerHTML = `
    <p class="muted">Os agentes trabalham no PC escolhido aqui, com as pastas e o login do Claude daquele computador.
      Conversas, memória e sessões ficam no hub, então qualquer PC conectado continua de onde parou.</p>
    <h3>PCs</h3>
    ${envs.map(([id, e]) => `<div class="env-row ${id === state.env?.id ? 'active' : ''}">
      <i class="dot" style="background:${id in online ? 'var(--ok)' : 'var(--muted)'}"></i>
      <span class="env-name">${esc(online[id]?.name || e.name)}</span>
      <span class="muted">${id in online ? 'conectado' : 'visto ' + timeAgo(e.lastSeen)}</span>
      ${id in online && outdated(id) ? `<span class="badge st-bloqueado" title="${online[id].version
        ? 'Ele se atualiza sozinho assim que terminar as tarefas em andamento.'
        : 'Versão antiga, que não se atualiza sozinha: baixe o conector de novo neste PC.'}">desatualizado</span>` : ''}
      ${id === state.env?.id ? '<span class="badge st-concluido">em uso</span>'
        : id in online ? `<button data-use="${id}">Usar</button>` : ''}
      ${paired[id] ? `<button class="danger" data-revoke="${paired[id].id}" title="Desconecta e exige parear de novo">Remover</button>` : ''}
    </div>`).join('') || '<p class="muted">Nenhum PC conectou ainda.</p>'}
    ${state.env ? `<label style="margin-top:12px">Nome do PC em uso<div class="folder-row">
      <input data-field="name" maxlength="40" value="${esc(state.env.name)}" />
      <button data-act="rename">Salvar</button></div></label>` : ''}
    <h3>Conectar um PC</h3>
    <p class="muted">No PC que vai trabalhar, entre no hub com a sua conta e baixe o conector. Extraia o zip e dê dois cliques em
      <b>Iniciar Techtie.bat</b>: ele instala o que faltar, pareia o PC e abre o login do Claude se precisar.</p>
    <div class="row"><a class="btn primary" href="/api/connector-download" download>Baixar conector (Windows)</a></div>
    <p class="muted">O pacote liga o PC à <b>sua</b> conta e vale por 24 horas. Não envie para outras pessoas: cada uma baixa o dela.</p>
    <details class="pair-cli" ${p ? 'open' : ''}><summary>Já tenho o repositório clonado (linha de comando)</summary>
    ${p ? `<div class="code" data-field="cmd">node conector.js --hub ${esc(p.hub)} --codigo ${esc(p.code)} --nome "Nome do PC"</div>
      <div class="row"><button data-act="copy">Copiar comando</button><span class="muted">vale até ${new Date(p.exp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span></div>`
      : '<div class="row"><button data-act="pair">Gerar código</button></div>'}
    </details>
    <h3>Backup</h3>
    <p class="muted">Exporte tudo (mesas, agentes, conversas, memória e sessões) para um arquivo, ou restaure um backup.</p>
    <div class="row">
      <a class="btn primary" href="/api/export" download>Exportar</a>
      <button data-act="import">Importar…</button>
      <input type="file" accept=".json,application/json" hidden />
    </div>`;
  win.body.querySelectorAll('[data-use]').forEach((b) => (b.onclick = () => chooseEnv(b.dataset.use)));
  const rename = win.body.querySelector('[data-act=rename]');
  if (rename) rename.onclick = () => api('PATCH', '/api/environment', { name: win.body.querySelector('[data-field=name]').value });
  win.body.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remover este PC? Ele desconecta e só volta pareando de novo com um código.')) return;
    await api('DELETE', `/api/connectors/${b.dataset.revoke}`);
    win.onlineKey = null;
    renderEnv(win);
  }));
  const pairBtn = win.body.querySelector('[data-act=pair]');
  if (pairBtn) pairBtn.onclick = async () => {
    win.pairing = await api('POST', '/api/pairing', {});
    renderEnv(win);
  };
  const copy = win.body.querySelector('[data-act=copy]');
  if (copy) copy.onclick = (e) => {
    navigator.clipboard?.writeText(win.body.querySelector('[data-field=cmd]').textContent);
    e.target.textContent = 'Copiado!';
  };
  const file = win.body.querySelector('input[type=file]');
  win.body.querySelector('[data-act=import]').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    if (!f || !confirm(`Importar "${f.name}"? Isso substitui as mesas, agentes e conversas deste escritório.`)) return;
    try {
      await api('POST', '/api/import', JSON.parse(await f.text()));
      alert('Escritório importado.');
    } catch (e) {
      if (e instanceof SyntaxError) alert('Esse arquivo não é uma exportação válida.');
    }
  };
}

async function loadChat(projectId) {
  const data = await api('GET', `/api/projects/${projectId}/chat`);
  chats.set(projectId, data.entries);
  const win = wins.get('p:' + projectId);
  if (win) win.lastModel = data.lastModel; // modelo da última rodada, para a etiqueta
  const box = win?.body.querySelector('.chat-log');
  if (!box) return;
  box.innerHTML = data.entries.length ? '' : '<p class="muted chat-empty">Nenhuma conversa ainda. Escreva um pedido abaixo 👇</p>';
  data.entries.forEach((e) => box.appendChild(chatEntry(e)));
  box.scrollTop = box.scrollHeight;
}

function onChatEvent({ projectId, entry }) {
  if (!chats.has(projectId)) return;
  chats.get(projectId).push(entry);
  const box = wins.get('p:' + projectId)?.body.querySelector('.chat-log');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.querySelector('.chat-empty')?.remove();
  box.appendChild(chatEntry(entry));
  if (atBottom || entry.role === 'user') box.scrollTop = box.scrollHeight;
}

// markdown mínimo: blocos de código, `código` e **negrito**
function formatText(s) {
  return esc(s)
    .replace(/```\w*\n?([\s\S]*?)```/g, (_, code) => `<pre>${code}</pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

function chatEntry(e) {
  const div = document.createElement('div');
  div.className = 'msg msg-' + e.role;
  div.innerHTML = e.role === 'tool' ? '🔧 ' + esc(e.text) : formatText(e.text);
  if (e.images?.length) {
    // clicar abre a imagem inteira; se não estiver neste hub (ex.: backup importado), avisa
    const strip = document.createElement('div');
    strip.className = 'msg-images';
    strip.innerHTML = e.images.map((n) => `<a href="/api/files/${esc(n)}" target="_blank" rel="noopener"><img src="/api/files/${esc(n)}" alt="imagem anexada" loading="lazy" /></a>`).join('');
    strip.querySelectorAll('img').forEach((img) => (img.onerror = () => img.closest('a').replaceWith('[imagem indisponível]')));
    div.prepend(strip);
  }
  return div;
}

// ---------- Imagens no pedido ----------
const MAX_IMAGES = 6;
const MAX_SIDE = 1568; // o Claude reduz imagens maiores que isso; reduzir antes deixa o envio leve

// Lê a imagem, reduz se for grande e devolve { mediaType, data (base64), preview (data URL) }.
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  // print de tela fica nítido em PNG; foto grande vira JPEG para não passar do limite
  let url = canvas.toDataURL('image/png');
  if (url.length > 4.5 * 1024 * 1024) url = canvas.toDataURL('image/jpeg', 0.88);
  const [head, data] = url.split(',');
  return { mediaType: head.slice(5, head.indexOf(';')), data, preview: url };
}

async function addImages(win, files) {
  for (const file of files) {
    if (win.attachments.length >= MAX_IMAGES) { alert(`No máximo ${MAX_IMAGES} imagens por pedido.`); break; }
    try {
      setAttachments(win, [...win.attachments, await prepareImage(file)]);
    } catch {
      alert(`Não consegui ler a imagem "${file.name || 'colada'}".`);
    }
  }
  win.body.querySelector('textarea').focus();
}

function setAttachments(win, list) {
  win.attachments = list;
  const box = win.body.querySelector('.attachments');
  box.hidden = !list.length;
  box.innerHTML = list.map((a, i) => `<div class="thumb"><img src="${a.preview}" alt="" /><button data-rm="${i}" title="Tirar">✕</button></div>`).join('');
  box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => setAttachments(win, list.filter((_, i) => i !== +b.dataset.rm))));
}

// Cartão de permissão / pergunta. Só redesenha quando chega um pedido novo,
// para não apagar o que o usuário já marcou.
function renderPending(win, p, pend) {
  const box = win.body.querySelector('.pending-box');
  if ((pend?.id || '') === (box.dataset.pid || '')) return;
  box.dataset.pid = pend?.id || '';
  if (!pend) { box.innerHTML = ''; return; }
  const answer = (body) => api('POST', `/api/projects/${p.id}/answer`, { requestId: pend.id, ...body });

  if (pend.questions) {
    box.innerHTML = `<div class="pending">
      <div class="pending-title">❓ Pergunta do agente</div>
      ${pend.questions.map((q, qi) => `
        <div class="question">
          <div class="q-text">${esc(q.question)}</div>
          ${q.options.map((o) => `
            <label class="option">
              <input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="${win.key}-q${qi}" value="${esc(o.label)}" />
              <span><b>${esc(o.label)}</b>${o.description ? `<br><span class="muted">${esc(o.description)}</span>` : ''}</span>
            </label>`).join('')}
          <input class="other" data-q="${qi}" placeholder="Outra resposta (opcional)" />
        </div>`).join('')}
      <div class="row"><button class="primary" data-act="answer">Responder</button></div>
    </div>`;
    box.querySelector('[data-act=answer]').onclick = () => {
      const answers = []; // na ordem das perguntas
      for (const [qi, q] of pend.questions.entries()) {
        const other = box.querySelector(`.other[data-q="${qi}"]`).value.trim();
        const picked = [...box.querySelectorAll(`input[name="${win.key}-q${qi}"]:checked`)].map((i) => i.value);
        const value = other || picked.join(', ');
        if (!value) return alert(`Responda: "${q.question}"`);
        answers.push(value);
      }
      answer({ answers });
    };
  } else {
    box.innerHTML = `<div class="pending">
      <div class="pending-title">✋ Pedido de permissão</div>
      <div>${esc(pend.summary)}</div>
      ${pend.detail ? `<div class="code">${esc(pend.detail)}</div>` : ''}
      <div class="row">
        <button class="primary" data-d="allow">Permitir</button>
        ${pend.canRemember ? '<button data-d="always" title="Não pergunta de novo para ações iguais neste projeto">Sempre permitir</button>' : ''}
        <button class="danger" data-d="deny">Negar</button>
      </div>
      ${p.permissionMode === 'bypassPermissions' ? '' : '<a href="#" class="stop-asking" data-act="bypass">Parar de pedir permissão nesta mesa…</a>'}
    </div>`;
    box.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => answer({ decision: b.dataset.d })));
    box.querySelector('[data-act=bypass]')?.addEventListener('click', (e) => {
      e.preventDefault();
      setPermissionMode(p, 'bypassPermissions'); // libera também este pedido em aberto
    });
  }
}

// ---------- Janelas de Equipe e Atividade ----------
function openTeamWindow() {
  const win = openWindow('team', { w: 340, h: 480, cls: 'win-team' }, (win) => {
    win.titleEl.textContent = '👥 Equipe';
    win.render = renderTeam;
  });
  renderTeam(win);
}

function renderTeam(win) {
  win.body.innerHTML = (state.agents.map((a) => {
    const desk = deskOf(a.id);
    return `<div class="card" data-agent="${a.id}">
      <div class="title"><i class="dot" style="background:${esc(a.shirt)}"></i>${esc(a.name)} ${badge(a.status)}</div>
      <div class="sub">${esc(a.role || '')} · ${desk ? esc(desk.project.name) : 'sem mesa'}</div>
      ${a.message ? `<div class="sub">“${esc(a.message)}”</div>` : ''}
    </div>`;
  }).join('') || '<p class="muted">Ninguém contratado ainda.</p>') +
    '<div class="row"><button class="primary" data-act="hire">+ Contratar</button></div>';
  win.body.querySelector('[data-act=hire]').onclick = () => openAgentDialog();
  win.body.querySelectorAll('[data-agent]').forEach((n) => (n.onclick = () => {
    const a = state.agents.find((x) => x.id === n.dataset.agent);
    const desk = deskOf(a.id);
    if (desk) openProjectWindow(desk.project.id);
    else openAgentDialog(a);
  }));
}

function openLogWindow() {
  const win = openWindow('log', { w: 380, h: 480, cls: 'win-log' }, (win) => {
    win.titleEl.textContent = '📜 Atividade';
    win.render = (w) => { w.body.innerHTML = logList(state.log); };
  });
  win.render(win);
}

// ---------- Janela do monitor de servidores ----------
const since = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};
const uptimeText = (s) => (s == null ? '—' : s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor(s % 86400 / 3600)} h` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`);

// nome de exibição do servidor: o apelido, se houver, ou o nome do host
const monName = (h) => h.alias || h.host;
const plainText = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // a fonte pixel do 2D não tem acentos
const monPct = (v) => (v == null ? '—' : `${v}%`);

// ---- serviços (envio v2): origem, nome, status, saúde, CPU (% de UM núcleo, sem corte em 100), memória e reinícios/réplicas
const SVC_STATUS = { online: 'online', running: 'rodando', active: 'ativo', launching: 'iniciando', stopped: 'parado', inactive: 'inativo', exited: 'saiu', restarting: 'reiniciando', errored: 'erro', failed: 'falhou', other: 'outro' };
const SVC_HEALTH = { ok: 'ok', unhealthy: 'sem saúde', starting: 'iniciando', none: '—' }; // "none" = o container não tem healthcheck
const SVC_SRC = { pm2: 'PM2', docker: 'Docker', swarm: 'Swarm', systemd: 'systemd' };
const svcBad = (x) => x.status === 'errored' || x.status === 'failed' || x.health === 'unhealthy';
const svcWarn = (x) => x.status === 'restarting' || x.status === 'exited' || x.status === 'stopped' || x.status === 'other';

function servicesSection(h, win) {
  if (h.v !== 2) return '<h3>Serviços</h3><p class="muted">Este servidor ainda envia no formato v1 (só os totais). A lista por serviço aparece quando ele passar a enviar no v2.</p>';
  const all = h.services || [];
  if (!all.length) return '<h3>Serviços</h3><p class="muted">Nenhum serviço listado neste envio.</p>';
  const flagged = all.filter((x) => svcBad(x) || svcWarn(x));
  const bySrc = {};
  for (const x of all) bySrc[x.src] = (bySrc[x.src] || 0) + 1;
  const chips = [['todos', 'Todos', all.length], ...(flagged.length ? [['problema', 'Com problema', flagged.length]] : []),
    ...Object.keys(SVC_SRC).filter((k) => bySrc[k]).map((k) => [k, SVC_SRC[k], bySrc[k]])];
  const want = win.svcFilter?.[h.host] || 'todos', f = chips.some((c) => c[0] === want) ? want : 'todos';
  const list = f === 'todos' ? all : f === 'problema' ? flagged : all.filter((x) => x.src === f);
  const num = (v, suf = '') => (v == null ? '—' : `${v}${suf}`);
  const mem = (v) => (v == null ? '—' : v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`);
  const rows = list.map((x) => {
    const col = svcBad(x) ? MON_COLOR.critico : svcWarn(x) ? MON_COLOR.atencao : MON_COLOR.ok;
    const extra = x.replicas ? `${x.replicas} réplicas` : x.instances != null ? `${x.instances} inst.` : '';
    return `<tr>
      <td><span class="src">${esc(x.src)}</span></td>
      <td class="mono">${esc(x.name)}${x.project && x.project !== x.name ? `<div class="muted">${esc(x.project)}</div>` : ''}</td>
      <td style="color:${col}"><b>${esc(SVC_STATUS[x.status] || x.status)}</b></td>
      <td style="color:${x.health === 'unhealthy' ? MON_COLOR.critico : 'inherit'}" ${x.health === 'none' ? 'title="sem healthcheck configurado"' : ''}>${esc(SVC_HEALTH[x.health] || x.health || '—')}</td>
      <td class="r">${num(x.cpu_core_pct, '%')}</td>
      <td class="r">${mem(x.mem_mb)}</td>
      <td class="r">${x.restarts == null ? '—' : esc(x.restarts)}${extra ? `<div class="muted">${esc(extra)}</div>` : ''}</td></tr>`;
  }).join('');
  return `<h3>Serviços</h3>
    <div class="mon-chips">${chips.map(([k, label, n]) => `<button class="mon-chip ${k === f ? 'on' : ''}" data-act="filter" data-host="${esc(h.host)}" data-f="${k}">${label} <b>${n}</b></button>`).join('')}</div>
    <div class="svc-wrap"><table class="svc">
      <thead><tr><th>Origem</th><th>Serviço</th><th>Status</th><th>Saúde</th><th class="r" title="% de um núcleo: acima de 100% é normal em serviço com mais de uma thread">CPU/núcleo</th><th class="r">Memória</th><th class="r" title="Acumulados desde o boot; o Docker e o Swarm não informam">Reinícios</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${h.truncated ? '<div class="sub" style="color:var(--warn)">Lista cortada em 60 itens: os que têm problema vêm primeiro, os demais podem não aparecer.</div>' : ''}`;
}

// ---- aba de um servidor: cabeçalho com apelido, métricas, problemas e serviços
function serverTab(h, win) {
  const col = MON_COLOR[h.status], editing = win.editAlias === h.host, he = esc(h.host);
  const tile = (label, value, sub, color) => `<div class="mon-tile" style="border-top-color:${color || 'var(--line)'}"><div class="lab">${label}</div><div class="val">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const title = editing
    ? `<input data-alias-input maxlength="24" value="${esc(h.alias || '')}" placeholder="Apelido, ex.: VPS Nova" />
       <button class="primary mini" data-act="alias-save" data-host="${he}">Salvar</button><button class="mini" data-act="alias-cancel">Cancelar</button>
       ${h.alias ? `<button class="danger mini" data-act="alias-clear" data-host="${he}">Remover apelido</button>` : ''}`
    : `<b class="mon-name">${esc(monName(h))}</b>${h.alias ? ` <span class="mono muted">${he}</span>` : ''} <button class="mini" data-act="alias-edit" data-host="${he}" title="Dar um apelido a este servidor">✏️ Apelido</button>`;
  const probs = [[h.v === 2 ? 'PM2 reiniciando' : 'PM2 com muitos reinícios (acumulados desde o boot)', h.pm2.highRestarts], ['PM2 com erro', h.pm2.errored], ['Containers unhealthy', h.docker.unhealthy], ['Serviços systemd em falha', h.systemd.failed]].filter(([, g]) => g.count);
  const problems = probs.length
    ? `<div class="mon-prob">${probs.map(([l, g]) => `<div class="sub">${l}: ${g.names.length ? `<b>${g.names.map(esc).join(', ')}</b>` : `<b>${g.count}</b> (o monitor não envia os nomes)`}</div>`).join('')}</div>`
    : '<div class="mon-ok">✓ Nenhum problema nos serviços</div>';
  return `<div class="mon-head" style="border-left-color:${col}">
      <div class="mon-title">${title}</div>
      <div class="mon-meta"><span class="badge" style="background:${col};color:#000">${MON_LABEL[h.status]}</span>
        <span class="muted">${h.own ? '🔑 segredo próprio' : 'segredo geral'} · formato v${h.v || 1} · último envio há ${since(h.at)} (a cada ${h.interval}s)</span></div>
    </div>
    <div class="mon-tiles">
      ${tile('Carga 1 min', monPct(h.cpu), `% dos ${h.cpus ? h.cpus + ' ' : ''}vCPUs`, loadLevel(h.cpu))}
      ${tile('Memória', monPct(h.mem), h.memTotalMb ? `de ${Math.round(h.memTotalMb / 1024 * 10) / 10} GB` : '', level(h.mem, 80, 90))}
      ${tile('Disco', monPct(h.disk), '', level(h.disk, 80, 90))}
      ${h.swap != null ? tile('Swap', monPct(h.swap), '', 'var(--line)') : ''}
      ${tile('Ligado há', uptimeText(h.uptime), '', 'var(--line)')}
      ${tile('Portas expostas', h.ports.exposed ?? '—', h.ports.listening != null ? `de ${h.ports.listening} abertas` : '', 'var(--line)')}
    </div>
    <div class="sub">PM2: <b>${h.pm2.total}</b> processos · Docker${h.v === 2 ? '/Swarm' : ''}: <b>${h.docker.total}</b> ${h.v === 2 ? 'itens' : 'containers'} · systemd: <b>${h.systemd.total ?? '—'}</b> ${h.v === 2 ? 'unidades listadas' : 'serviços'}</div>
    <h3>Problemas</h3>${problems}
    ${servicesSection(h, win)}`;
}

// ---- aba de resumo: todos os servidores numa tabela (clique para abrir o servidor)
function summaryTab() {
  if (!monitor.hosts.length) return '<p class="muted">Nenhum servidor enviou dados ainda. Gere um segredo na aba ⚙ Conexão e configure o monitor na VPS.</p>';
  const rows = monitor.hosts.map((h) => {
    const bad = h.pm2.errored.count + h.docker.unhealthy.count + h.systemd.failed.count;
    return `<tr class="click" data-act="tab" data-tab="${esc(h.host)}">
      <td><b>${esc(monName(h))}</b>${h.alias ? `<div class="muted">${esc(h.host)}</div>` : ''}</td>
      <td><span class="badge" style="background:${MON_COLOR[h.status]};color:#000">${MON_LABEL[h.status]}</span></td>
      <td class="r" style="color:${loadLevel(h.cpu)}">${monPct(h.cpu)}</td>
      <td class="r" style="color:${level(h.mem, 80, 90)}">${monPct(h.mem)}</td>
      <td class="r" style="color:${level(h.disk, 80, 90)}">${monPct(h.disk)}</td>
      <td class="r">${bad ? `<b style="color:${MON_COLOR.critico}">${bad}</b>` : '0'}</td>
      <td class="r muted">há ${since(h.at)}</td></tr>`;
  }).join('');
  return `<div class="svc-wrap"><table class="svc">
    <thead><tr><th>Servidor</th><th>Status</th><th class="r" title="Carga média de 1 min ÷ vCPUs">Carga</th><th class="r">Memória</th><th class="r">Disco</th><th class="r" title="PM2 com erro, containers sem saúde e serviços systemd em falha">Com problema</th><th class="r">Último envio</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="muted">Clique em um servidor para ver as métricas e os serviços dele.</p>`;
}

// ---- aba de conexão: endereço e segredos
function connectionTab(win) {
  const url = location.origin + '/api/monitor/report';
  return `<h3>Conexão</h3>
    <p class="muted">A VPS envia um resumo para o hub (o hub nunca acessa a VPS). Endereço:
      <code>${esc(url)}</code><br>Cabeçalho: <code>Authorization: Bearer &lt;segredo&gt;</code>, JSON de até 32 KB.</p>
    ${win.secret ? `<div class="card"><div class="sub"><b>Segredo${win.secretHost ? ` do servidor <span class="mono">${esc(win.secretHost)}</span>` : ' geral'} (aparece só agora — copie e guarde na VPS, não no chat):</b></div>
      <div class="title mono" style="word-break:break-all;user-select:all">${esc(win.secret)}</div></div>` : ''}
    <h3>Segredo por servidor</h3>
    <p class="muted">Cada servidor pode ter o seu segredo, que só vale para o nome (<code>host</code>) dele: revogar um não derruba os outros. O segredo geral continua valendo para qualquer servidor.</p>
    ${(monitor.secrets?.hosts || []).map((x) => `<div class="card"><div class="title mono">${esc(x.host)}${x.alias ? ` <span class="muted">· ${esc(x.alias)}</span>` : ''} <span class="muted" style="font-size:11px">criado ${x.createdAt ? new Date(x.createdAt).toLocaleDateString('pt-BR') : ''}</span></div>
      <div class="row"><button data-act="host-secret" data-host="${esc(x.host)}">Gerar novo</button><button class="danger" data-act="host-revoke" data-host="${esc(x.host)}">Revogar</button></div></div>`).join('')}
    <div class="row"><input data-host-name placeholder="nome do servidor (host), ex.: srv1854371" maxlength="64" style="flex:1" />
      <button class="primary" data-act="host-new">Gerar segredo do servidor</button></div>
    <h3>Segredo geral</h3>
    <div class="row"><button class="primary" data-act="secret">${monitor.secrets?.general ? 'Gerar novo segredo geral' : 'Gerar segredo geral'}</button>
      ${monitor.secrets?.general ? '<button class="danger" data-act="revoke">Revogar o geral</button>' : ''}</div>`;
}

function renderMonitor(win) {
  if (monitor.denied) { win.body.innerHTML = '<p class="muted">Só a dona do hub vê o monitor de servidores.</p>'; return; }
  const ae = document.activeElement;
  if (win.drawn && ae && win.body.contains(ae) && ae.matches('input')) return; // a atualização periódica não apaga o que está sendo digitado
  let tab = win.tab || 'resumo';
  if (tab !== 'resumo' && tab !== 'conexao' && !monitor.hosts.some((h) => h.host === tab)) tab = 'resumo';
  const host = monitor.hosts.find((h) => h.host === tab);
  const tabs = [['resumo', 'Resumo', ''], ...monitor.hosts.map((h) => [h.host, truncate(monName(h), 16), MON_COLOR[h.status]]), ['conexao', '⚙ Conexão', '']];
  const keepScroll = win.drawnTab === tab ? win.body.scrollTop : 0;
  win.body.innerHTML = `<div class="mon-tabs">${tabs.map(([id, label, dot]) => `<button class="mon-tab ${id === tab ? 'on' : ''}" data-act="tab" data-tab="${esc(id)}">${dot ? `<i class="dot" style="background:${dot}"></i>` : ''}${esc(label)}</button>`).join('')}</div>
    ${tab === 'resumo' ? summaryTab() : tab === 'conexao' ? connectionTab(win) : serverTab(host, win)}`;
  win.body.scrollTop = keepScroll;
  win.drawn = true; win.drawnTab = tab;
}

function openMonitorWindow(host) {
  const win = openWindow('monitor', { w: 740, h: 680, cls: 'win-vars' }, (win) => {
    win.titleEl.textContent = '🖥️ Servidores';
    win.render = renderMonitor;
    win.body.onclick = async (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const fa = document.activeElement;
      if (fa && win.body.contains(fa) && fa.matches('input')) fa.blur(); // sair do campo libera a tela para atualizar (nem todo navegador foca o botão ao clicar)
      const act = el.dataset.act;
      const host = el.dataset.host || (act === 'host-new' ? (win.body.querySelector('[data-host-name]')?.value || '').trim() : '');
      if (act === 'tab') { win.tab = el.dataset.tab; win.secret = null; win.editAlias = null; return renderMonitor(win); } // sair da aba esconde o segredo mostrado
      if (act === 'filter') { (win.svcFilter ||= {})[host] = el.dataset.f; return renderMonitor(win); }
      if (act === 'alias-edit') { win.editAlias = host; renderMonitor(win); win.body.querySelector('[data-alias-input]')?.focus(); return; }
      if (act === 'alias-cancel') { win.editAlias = null; return renderMonitor(win); }
      if (act === 'alias-save' || act === 'alias-clear') {
        const alias = act === 'alias-clear' ? '' : win.body.querySelector('[data-alias-input]')?.value ?? '';
        await api('POST', '/api/monitor/alias', { host, alias });
        win.editAlias = null;
      } else if (act === 'secret') {
        if (monitor.secrets?.general && !confirm('Gerar um novo segredo geral? Os servidores que usam o geral deixam de ser aceitos até você trocar o segredo neles (os que têm segredo próprio não são afetados).')) return;
        win.secret = (await api('POST', '/api/monitor/secret', {})).secret; win.secretHost = null;
      } else if (act === 'host-new' || act === 'host-secret') {
        if (!host) return alert('Digite o nome do servidor (o campo "host" que o monitor envia).');
        if (act === 'host-secret' && !confirm(`Gerar um novo segredo para "${host}"? O monitor desse servidor deixa de ser aceito até você trocar o segredo nele.`)) return;
        win.secret = (await api('POST', '/api/monitor/secret', { host })).secret; win.secretHost = host;
      } else if (act === 'revoke') {
        if (!confirm('Revogar o segredo geral? Os servidores que usam o geral deixam de enviar e os racks deles somem (os que têm segredo próprio continuam).')) return;
        await api('DELETE', '/api/monitor/secret');
        win.secret = null;
      } else if (act === 'host-revoke') {
        if (!confirm(`Revogar o segredo de "${host}"? Esse servidor deixa de enviar e o rack dele some.`)) return;
        await api('DELETE', '/api/monitor/secret?host=' + encodeURIComponent(host));
        win.secret = null;
      } else return;
      await loadMonitor();
      if (world?.server) { world = computeWorld(); resize(); }
      renderMonitor(win);
    };
    win.body.onkeydown = (e) => { // Enter salva, Esc cancela; sai do campo antes para a tela poder atualizar
      const t = e.target, q = (s) => win.body.querySelector(s);
      if (t.matches('[data-alias-input]') && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); t.blur(); q(e.key === 'Enter' ? '[data-act=alias-save]' : '[data-act=alias-cancel]')?.click(); }
      else if (t.matches('[data-host-name]') && e.key === 'Enter') { e.preventDefault(); t.blur(); q('[data-act=host-new]')?.click(); }
    };
  });
  if (host) win.tab = host;
  win.drawn = false;
  loadMonitor().finally(() => renderMonitor(win));
  renderMonitor(win);
}

// ---------- Barra de salas ----------
// Quantos agentes da sala estão esperando você (pergunta, permissão ou bloqueio).
function waitingIn(rid) {
  return roomProjects(rid).filter((p) => {
    const a = state.agents.find((x) => x.id === p.agentId);
    return state.live?.[p.id]?.pending || a?.status === 'bloqueado';
  }).length;
}

function renderRooms() {
  const bar = document.getElementById('room-tabs');
  const cur = currentRoom();
  // sala de servidores não tem mesas para mover
  document.getElementById('btn-move').hidden = cur?.kind === 'servidor';
  if (cur?.kind === 'servidor' && moveMode) setMoveMode(false);
  bar.innerHTML = state.rooms.map((r) => {
    const waiting = waitingIn(r.id);
    return `<button class="room-tab ${r === cur ? 'active' : ''}" data-room="${r.id}" title="${r === cur ? 'Clique para configurar a sala' : 'Ir para a sala'}">
      ${esc(r.name)} <span class="muted">${roomProjects(r.id).length}</span>
      ${waiting ? `<span class="room-alert">${waiting}</span>` : ''}
      ${r === cur ? '<span class="room-gear">⚙</span>' : ''}
    </button>`;
  }).join('') + '<button class="room-tab room-add" data-act="add-room" title="Criar sala">+ Sala</button>';
  bar.querySelectorAll('[data-room]').forEach((b) => (b.onclick = () => {
    if (b.dataset.room === cur.id) openRoomDialog(cur);
    else switchRoom(b.dataset.room);
  }));
  bar.querySelector('[data-act=add-room]').onclick = () => openRoomDialog();
}

function refreshUI() {
  renderStats();
  renderRooms();
  for (const win of [...wins.values()]) {
    if (win.projectId) updateProjectWindow(win);
    else win.render?.(win);
  }
}

// ---------- Diálogos ----------
const dialog = document.getElementById('dialog');
const form = document.getElementById('dialog-form');

// danger: { label, confirm, action } — botão destrutivo opcional à esquerda
function openDialog(html, onSubmit, danger) {
  form.innerHTML = html + `<div class="row">
    ${danger ? `<button type="button" class="danger" data-act="danger" style="margin-right:auto">${danger.label}</button>` : ''}
    <button value="cancel" formnovalidate>Cancelar</button><button class="primary" value="ok">Salvar</button></div>`;
  form.onsubmit = (e) => {
    if (e.submitter?.value !== 'ok') return;
    onSubmit(Object.fromEntries(new FormData(form)));
  };
  if (danger) form.querySelector('[data-act=danger]').onclick = () => {
    if (!confirm(danger.confirm)) return;
    dialog.close();
    danger.action();
  };
  dialog.showModal();
  form.querySelector('input')?.focus();
}

const FLOOR_NAMES = { madeira: 'Madeira', carpete: 'Carpete azul', piso: 'Piso claro', escuro: 'Escuro' };

function openRoomDialog(r) {
  openDialog(`
    <h2>${r ? 'Configurar sala' : 'Nova sala'}</h2>
    <label>Nome da sala<input name="name" required maxlength="30" placeholder="Ex.: Clientes, Produto, Jurídico" value="${esc(r?.name || '')}" /></label>
    <label>Tipo<select name="kind">
      <option value="" ${!r?.kind ? 'selected' : ''}>Escritório (mesas e agentes)</option>
      <option value="servidor" ${r?.kind === 'servidor' ? 'selected' : ''}>Sala de servidores (monitor de VPS)</option>
    </select></label>
    <label>Mesas por fileira: <b id="cols-out">${r?.cols || 4}</b>
      <input type="range" name="cols" min="2" max="8" value="${r?.cols || 4}" />
    </label>
    <fieldset class="areas"><legend>Áreas da coluna lateral</legend>
      ${AREA_ORDER.map((k) => `<label class="option"><input type="checkbox" name="areas" value="${k}"
        ${(r?.areas || AREA_ORDER).includes(k) ? 'checked' : ''} /><span>${AREA_NAMES[k]}</span></label>`).join('')}
    </fieldset>
    <label>Piso<select name="floor">${Object.entries(FLOOR_NAMES).map(([k, v]) =>
      `<option value="${k}" ${k === (r?.floor || 'carpete') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Parede<select name="wall">${Object.entries(WALL_NAMES).map(([k, v]) =>
      `<option value="${k}" ${k === (r?.wall || 'cinza') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    ${r ? '' : '<p class="muted">As mesas podem ser movidas entre salas em ⚙ Mesa.</p>'}
  `, async (d) => {
    d.areas = [...form.querySelectorAll('input[name=areas]:checked')].map((i) => i.value);
    if (r) await api('PATCH', `/api/rooms/${r.id}`, d);
    else {
      const created = await api('POST', '/api/rooms', d);
      setTimeout(() => switchRoom(created.id), 100);
    }
  }, r && state.rooms.length > 1 && {
    label: 'Remover sala',
    confirm: `Remover a sala "${r.name}"? As mesas dela vão para outra sala.`,
    action: () => api('DELETE', `/api/rooms/${r.id}`),
  });
  form.elements.cols.oninput = (e) => (form.querySelector('#cols-out').textContent = e.target.value);
}

const PALETTE = ['#4f8cff', '#f2a93b', '#3fbf7f', '#e5534b', '#b072f5', '#2ec4c4', '#f272b6'];

function openProjectDialog(p) {
  const color = p?.color || PALETTE[state.projects.length % PALETTE.length];
  openDialog(`
    <h2>${p ? 'Editar mesa' : 'Nova mesa (projeto)'}</h2>
    <label>Nome do projeto<input name="name" required maxlength="40" value="${esc(p?.name || '')}" /></label>
    <label>Descrição<textarea name="description" rows="2">${esc(p?.description || '')}</textarea></label>
    <label class="option"><input type="checkbox" name="secretaria" ${p?.role === 'secretaria' ? 'checked' : ''} />
      <span><b>Mesa da secretária</b><br><span class="muted">Recebe a memória do escritório e os relatórios, enxerga todas as mesas e pode
      passar demandas para elas. Não precisa de pasta de projeto.</span></span></label>
    <label>Pasta do projeto no PC ${esc(state.env?.name || '(nenhum PC conectado)')}
      <div class="folder-row">
        <input name="folder" placeholder="C:\\Users\\...\\meu-projeto" value="${esc(p?.folder || '')}" />
        <button type="button" id="pick-folder">Escolher…</button>
      </div>
    </label>
    <div class="colors">
      <label>Cor<input type="color" name="color" value="${esc(color)}" /></label>
      <label>Sala<select name="roomId">${state.rooms.map((r) =>
        `<option value="${r.id}" ${r.id === (p?.roomId || currentRoom().id) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
    </div>
    ${p ? '' : `<label>Agente<select name="agentId"><option value="">— sem agente —</option>${state.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>`}
  `, async (d) => {
    d.role = d.secretaria ? 'secretaria' : '';
    delete d.secretaria;
    const submit = async (body) => {
      try {
        if (p) await api('PATCH', `/api/projects/${p.id}`, body, { quiet: true });
        else {
          const created = await api('POST', '/api/projects', { ...body, agentId: body.agentId || null }, { quiet: true });
          setTimeout(() => openProjectWindow(created.id), 100);
        }
        const w = p && wins.get('p:' + p.id);
        if (w) refreshGit(w);
      } catch (e) {
        if (e.code === 'repo_mismatch') {
          if (confirm(e.message + '\n\nUsar esta pasta mesmo assim?')) submit({ ...body, forceFolder: true });
        } else alert(e.message);
      }
    };
    submit(d);
  }, p && { label: 'Remover mesa', confirm: `Remover a mesa "${p.name}"?`, action: () => api('DELETE', `/api/projects/${p.id}`) });
  form.querySelector('#pick-folder').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Veja a janela…';
    try {
      const { folder } = await api('POST', '/api/pick-folder', {});
      if (folder) form.elements.folder.value = folder;
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Escolher…';
    }
  };
}

// Modos de permissão da mesa (Claude Code). Em todos, perguntas de decisão continuam chegando.
const PERMISSION_NAMES = {
  '': 'Perguntar sempre',
  acceptEdits: 'Editar sem pedir',
  auto: 'Automático (Claude decide)',
  bypassPermissions: 'Liberar tudo',
};

// Devolve false se o usuário desistiu no aviso.
function setPermissionMode(p, mode) {
  if (mode === 'bypassPermissions' && !confirm(
    `Liberar tudo na mesa "${p.name}"?\n\nO agente vai rodar comandos e editar/apagar arquivos no PC sem pedir permissão. ` +
    'As perguntas de decisão continuam chegando para você.\n\nUse em projetos com git (para poder desfazer). Dá para voltar a qualquer momento no 🔐 da mesa.')) return false;
  api('PATCH', `/api/projects/${p.id}`, { permissionMode: mode });
  return true;
}

const MODEL_NAMES = { '': 'Padrão do PC', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const EFFORT_NAMES = { '': 'Padrão do PC', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };

// claude-opus-5-5 → "Opus 5.5" (ignora sufixos de data)
function prettyModel(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id || '');
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : id || '';
}

const HAIR_NAMES = { '': 'Automático', curto: 'Curto', longo: 'Longo', coque: 'Coque' };
const ACCESSORY_NAMES = { '': 'Nenhum', oculos: 'Óculos', fone: 'Fone de ouvido', bone: 'Boné' };
const OUTFIT_NAMES = { '': 'Automático', moletom: 'Moletom', blazer: 'Blazer', cardigan: 'Cardigan com saia', bomber: 'Jaqueta bomber', colete: 'Colete com gravata' };
// cor opcional: vazia = automática (a caixa "auto" fica marcada até o usuário escolher uma cor)
const autoColor = (name, label, value, fallback) => `<label>${label}
  <input type="color" name="${name}" value="${esc(value || fallback)}" />
  <span class="auto-check"><input type="checkbox" name="${name}_auto" ${value ? '' : 'checked'} /> auto</span></label>`;

function openAgentDialog(a) {
  const shirt = a?.shirt || PALETTE[state.agents.length % PALETTE.length];
  openDialog(`
    <h2>${a ? 'Editar agente' : 'Contratar agente'}</h2>
    <label>Nome<input name="name" required maxlength="16" value="${esc(a?.name || '')}" /></label>
    <label>Cargo<input name="role" maxlength="40" placeholder="Ex.: Dev back-end" value="${esc(a?.role || '')}" /></label>
    <div class="colors">
      <label>Camisa<input type="color" name="shirt" value="${esc(shirt)}" /></label>
      <label>Cabelo<input type="color" name="hair" value="${esc(a?.hair || '#3b2416')}" /></label>
      <label>Pele<input type="color" name="skin" value="${esc(a?.skin || '#f1c7a0')}" /></label>
    </div>
    <div class="colors">
      <label>Roupa<select name="outfit">${Object.entries(OUTFIT_NAMES).map(([k, v]) =>
        `<option value="${k}" ${k === (a?.outfit || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <div class="colors">
      ${autoColor('second', 'Cor 2', a?.second, '#3f6cc6')}
      ${autoColor('pants', 'Calça', a?.pants, '#3d4668')}
      ${autoColor('shoe', 'Calçado', a?.shoe, '#f4f1ea')}
    </div>
    <div class="colors">
      <label>Estilo do cabelo<select name="hairStyle">${Object.entries(HAIR_NAMES).map(([k, v]) =>
        `<option value="${k}" ${k === (a?.hairStyle || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Acessório<select name="accessory">${Object.entries(ACCESSORY_NAMES).map(([k, v]) =>
        `<option value="${k}" ${k === (a?.accessory || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <div class="colors">
      <label>Modelo<select name="model">${Object.entries(MODEL_NAMES).map(([k, v]) =>
        `<option value="${k}" ${k === (a?.model || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Esforço<select name="effort">${Object.entries(EFFORT_NAMES).map(([k, v]) =>
        `<option value="${k}" ${k === (a?.effort || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <p class="muted dialog-hint">“Padrão do PC” usa o que estiver configurado no Claude Code do computador que executa.
      Mais esforço pensa mais (melhor em tarefas difíceis), mas demora e gasta mais do seu plano.</p>
  `, async (d) => {
    for (const k of ['second', 'pants', 'shoe']) { // "auto" marcado: manda vazio e o personagem usa o padrão
      if (d[k + '_auto'] !== undefined) d[k] = '';
      delete d[k + '_auto'];
    }
    if (a) await api('PATCH', `/api/agents/${a.id}`, d);
    else await api('POST', '/api/agents', d);
  }, a && { label: 'Demitir', confirm: `Demitir ${a.name}?`, action: () => api('DELETE', `/api/agents/${a.id}`) });
  // escolher uma cor desmarca o "auto" dela
  for (const c of form.querySelectorAll('.auto-check')) {
    const color = c.parentElement.querySelector('input[type=color]');
    color.addEventListener('input', () => { c.querySelector('input').checked = false; });
  }
}

document.getElementById('btn-new-project').onclick = () => openProjectDialog();
document.getElementById('btn-new-agent').onclick = () => openAgentDialog();
document.getElementById('btn-team').onclick = () => openTeamWindow();
document.getElementById('btn-log').onclick = () => openLogWindow();

// Parar todas as mesas que estão rodando (cada uma sem perder o que já foi feito, como o ⏹ da mesa)
document.getElementById('btn-stopall').onclick = async () => {
  const running = state.projects.filter((p) => state.live?.[p.id]);
  if (!running.length) return alert('Nenhuma mesa está rodando agora.');
  if (!confirm(`Parar ${running.length} mesa${running.length > 1 ? 's' : ''} que está${running.length > 1 ? 'ão' : ''} rodando?\n\n${running.map((p) => '• ' + p.name).join('\n')}`)) return;
  await Promise.all(running.map((p) => api('POST', `/api/projects/${p.id}/stop`, {}, { quiet: true }).catch(() => {})));
};

const soundBtn = document.getElementById('btn-sound');
const renderSound = () => (soundBtn.textContent = soundOn ? '🔔 Som do telefone: ligado' : '🔕 Som do telefone: desligado');
soundBtn.onclick = () => { soundOn = !soundOn; store('hub.sound', soundOn); renderSound(); if (soundOn) ringPhone(); };
renderSound();
document.getElementById('btn-env').onclick = () => openEnvWindow();
document.getElementById('btn-account').onclick = () => openAccountWindow();
document.getElementById('btn-mcp').onclick = () => openMcpWindow();
document.getElementById('btn-vars').onclick = () => openVarsWindow();
document.getElementById('btn-office-memory').onclick = () => openOfficeMemoryWindow();

// ---------- Menu "Mais" (agrupa os botões secundários do topo) ----------
const moreMenu = document.getElementById('more-menu');
document.getElementById('btn-more').addEventListener('click', (e) => {
  e.stopPropagation();
  moreMenu.hidden = !moreMenu.hidden;
});
moreMenu.addEventListener('click', (e) => { if (e.target.closest('button')) moreMenu.hidden = true; });
document.addEventListener('click', (e) => { if (!moreMenu.hidden && !e.target.closest('.menu')) moreMenu.hidden = true; });

// ---------- Chat da comunidade ----------
// Sala geral + conversas individuais entre contas. Canal próprio (SSE), separado do escritório.
const comm = { people: [], unread: { general: 0, dm: {} }, active: 'general', msgs: {}, stream: null };

const commUnreadTotal = () => comm.unread.general + Object.values(comm.unread.dm).reduce((a, b) => a + b, 0);

function renderCommBadge() {
  const n = commUnreadTotal();
  document.getElementById('btn-community').textContent = '💬 Comunidade' + (n ? ` (${n > 99 ? '99+' : n})` : '');
  document.getElementById('btn-more').textContent = '☰ Mais' + (n ? ' •' : '') + (voice.on ? ' 🎙️' : '');
}

async function loadCommunity() {
  try {
    Object.assign(comm, await api('GET', '/api/community/summary', undefined, { quiet: true }));
  } catch { return; }
  renderCommBadge();
  const win = wins.get('community');
  if (win) renderCommTabs(win);
}

function connectCommunity() {
  comm.stream?.close();
  comm.stream = new EventSource('/api/community/events');
  comm.stream.addEventListener('msg', (e) => onCommMessage(JSON.parse(e.data)));
  comm.stream.addEventListener('tasks', () => { const w = wins.get('tasks'); if (w) loadTasks(w); });
  comm.stream.addEventListener('voice', (e) => onVoiceMembers(JSON.parse(e.data).members));
  comm.stream.addEventListener('voice-signal', (e) => onVoiceSignal(JSON.parse(e.data)));
  // ao (re)conectar, recupera o que passou enquanto estava fora
  comm.stream.onopen = async () => {
    await loadCommunity();
    const win = wins.get('community');
    if (win) loadCommChat(win, comm.active);
  };
}

const commUnreadOf = (key) => (key === 'general' ? comm.unread.general : comm.unread.dm[key] || 0);

function onCommMessage({ chat, from, to, msg }) {
  const key = chat === 'general' ? 'general' : from === me.id ? to : from;
  if (chat === 'dm' && !comm.people.some((p) => p.id === key)) loadCommunity();
  if (comm.msgs[key] && !comm.msgs[key].some((m) => m.id === msg.id)) comm.msgs[key].push(msg);
  const win = wins.get('community');
  const watching = win && !win.minimized && comm.active === key && !document.hidden;
  if (msg.from !== me.id) {
    if (watching) api('PUT', `/api/community/${key === 'general' ? 'general' : 'dm/' + key}`, {}, { quiet: true }).catch(() => {});
    else if (key === 'general') comm.unread.general++;
    else comm.unread.dm[key] = (comm.unread.dm[key] || 0) + 1;
  }
  if (win && comm.active === key) renderCommLog(win);
  if (win) renderCommTabs(win);
  renderCommBadge();
}

const commPath = (key) => (key === 'general' ? '/api/community/general' : `/api/community/dm/${key}`);

function renderCommTabs(win) {
  const tab = (key, label) => {
    const n = commUnreadOf(key);
    return `<button class="comm-tab ${comm.active === key ? 'on' : ''}" data-chat="${esc(key)}">${esc(label)}${n ? ` <b>${n}</b>` : ''}</button>`;
  };
  win.body.querySelector('.comm-tabs').innerHTML =
    tab('general', '# Geral') + comm.people.map((p) => tab(p.id, p.name)).join('');
  // a dona do hub visita o escritório de quem está na conversa aberta
  const visit = win.body.querySelector('.comm-visit');
  const person = me?.isOwner && comm.people.find((p) => p.id === comm.active);
  visit.hidden = !person;
  visit.onclick = () => person && openVisitWindow(person);
  if (person) visit.textContent = `🏢 Visitar escritório de ${person.name}`;
}

function renderCommLog(win) {
  const log = win.body.querySelector('.comm-log');
  const list = comm.msgs[comm.active];
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  if (!list) { log.innerHTML = '<p class="muted">Carregando…</p>'; return; }
  const dm = comm.active !== 'general';
  log.innerHTML = list.length ? list.map((m) => {
    const mine = m.from === me.id;
    const time = new Date(m.t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `<div class="msg ${mine ? 'msg-user' : 'msg-assistant'}">${!mine && !dm ? `<b class="comm-name">${esc(m.name)}</b>` : ''}${esc(m.text)}<time class="comm-time">${time}</time></div>`;
  }).join('') : `<p class="muted">${dm ? 'Nenhuma mensagem ainda. Diga oi!' : 'A sala está quieta. Comece a conversa!'}</p>`;
  if (atEnd || win.stickBottom) log.scrollTop = log.scrollHeight;
  win.stickBottom = false;
}

async function loadCommChat(win, key) {
  comm.active = key;
  win.stickBottom = true;
  renderCommTabs(win);
  renderCommLog(win);
  try {
    comm.msgs[key] = await api('GET', commPath(key), undefined, { quiet: true });
  } catch { return; }
  if (comm.active !== key) return; // trocou de conversa enquanto carregava
  renderCommLog(win);
  if (commUnreadOf(key)) {
    if (key === 'general') comm.unread.general = 0;
    else delete comm.unread.dm[key];
    renderCommTabs(win);
    renderCommBadge();
    api('PUT', commPath(key), {}, { quiet: true }).catch(() => {});
  }
  win.body.querySelector('textarea').placeholder = key === 'general'
    ? 'Mensagem para todos… (Enter envia, Shift+Enter quebra a linha)'
    : `Mensagem para ${comm.people.find((p) => p.id === key)?.name || ''}…`;
}

function openCommunityWindow() {
  const win = openWindow('community', { w: 520, h: 560, cls: 'win-community' }, (win) => {
    win.titleEl.textContent = '💬 Comunidade';
    win.body.innerHTML = `
      <div class="comm-tabs"></div>
      <button class="comm-visit" hidden></button>
      <div class="chat-log comm-log"></div>
      <form class="chat-input">
        <textarea rows="2" maxlength="2000"></textarea>
        <div class="row"><button class="primary">Enviar</button></div>
      </form>`;
    const form = win.body.querySelector('form');
    const box = form.querySelector('textarea');
    win.body.querySelector('.comm-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-chat]');
      if (b) loadCommChat(win, b.dataset.chat);
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = box.value.trim();
      if (!text) return;
      const key = comm.active;
      box.value = '';
      try {
        const msg = await api('POST', commPath(key), { text });
        // o servidor também manda pelo SSE; o id evita duplicar
        if (comm.msgs[key] && !comm.msgs[key].some((m) => m.id === msg.id)) comm.msgs[key].push(msg);
        win.stickBottom = true;
        if (comm.active === key) renderCommLog(win);
      } catch { box.value = text; }
    };
    box.addEventListener('keydown', (e) => {
      // no celular o Enter quebra a linha (o botão envia); no PC o Enter envia
      if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); form.requestSubmit(); }
    });
    loadCommunity().then(() => loadCommChat(win, comm.active));
  });
  return win;
}

document.getElementById('btn-community').onclick = () => openCommunityWindow();

// ---------- Sala de voz da equipe ----------
// WebRTC em malha: cada pessoa liga direto a cada uma das outras, então o áudio não passa pelo hub (ele só
// repassa a sinalização pelo SSE da comunidade). Quem entra manda a oferta para quem já estava na sala.
// Só STUN: atrás de redes muito fechadas (algumas de empresa) a ligação pode não fechar sem um servidor TURN.
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const voice = {
  on: false, joining: false, stream: null, muted: false, members: [],
  peers: new Map(), // id -> { pc, audio, muted, state, queue }
  levels: new Map(), // id -> { an, buf } (medidor de quem está falando)
  speaking: new Set(), ctx: null, timer: null,
};

const voiceName = (id) => voice.members.find((m) => m.id === id)?.name || 'alguém';

function renderVoiceBadge() {
  const n = voice.members.length;
  document.getElementById('btn-voice').textContent = '🎙️ Voz' + (voice.on ? ' (você está na sala)' : n ? ` (${n} na sala)` : '');
  renderCommBadge(); // o "Mais" mostra 🎙️ enquanto você está na voz
  const win = wins.get('voice');
  if (win) renderVoiceWindow(win);
}

function voiceSend(to, data) {
  api('POST', '/api/community/voice/signal', { to, data }, { quiet: true }).catch(() => {});
}

function voiceWatch(id, stream) {
  try {
    voice.ctx ??= new AudioContext();
    const an = voice.ctx.createAnalyser();
    an.fftSize = 512;
    voice.ctx.createMediaStreamSource(stream).connect(an); // sem ligar na saída: o som já toca pelo <audio>
    voice.levels.set(id, { an, buf: new Uint8Array(an.fftSize) });
  } catch {}
}

// de tempos em tempos mede o volume de cada pessoa e marca quem está falando
function voiceTick() {
  if (voice.ctx?.state === 'suspended') voice.ctx.resume().catch(() => {});
  const now = new Set();
  for (const [id, { an, buf }] of voice.levels) {
    if (id === me.id && voice.muted) continue;
    if (id !== me.id && voice.peers.get(id)?.muted) continue;
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    if (Math.sqrt(sum / buf.length) > 0.02) now.add(id);
  }
  const same = now.size === voice.speaking.size && [...now].every((id) => voice.speaking.has(id));
  voice.speaking = now;
  if (!same) wins.get('voice')?.body.querySelectorAll('[data-vid]').forEach((el) => el.classList.toggle('speaking', now.has(el.dataset.vid)));
}

function voicePeer(id, initiator) {
  if (voice.peers.has(id)) return voice.peers.get(id);
  const pc = new RTCPeerConnection(ICE);
  const peer = { pc, audio: new Audio(), muted: false, state: 'conectando', queue: [] };
  voice.peers.set(id, peer);
  for (const t of voice.stream.getTracks()) pc.addTrack(t, voice.stream);
  pc.onicecandidate = (e) => e.candidate && voiceSend(id, { candidate: e.candidate });
  pc.ontrack = (e) => {
    peer.audio.srcObject = e.streams[0];
    peer.audio.muted = peer.muted;
    peer.audio.play().catch(() => {});
    voiceWatch(id, e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    peer.state = { connected: 'conectado', failed: 'falhou', disconnected: 'instável', closed: 'fechado' }[pc.connectionState] || 'conectando';
    const win = wins.get('voice');
    if (win) renderVoiceWindow(win);
  };
  if (initiator) {
    pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => voiceSend(id, { sdp: pc.localDescription })).catch(() => {});
  }
  return peer;
}

function voiceDrop(id) {
  const peer = voice.peers.get(id);
  if (peer) {
    peer.pc.close();
    peer.audio.srcObject = null;
    voice.peers.delete(id);
  }
  voice.levels.delete(id);
  voice.speaking.delete(id);
}

async function onVoiceSignal({ from, data }) {
  if (!voice.on || !data) return;
  // oferta nova de quem já tínhamos: a pessoa saiu e voltou, a ligação antiga não serve mais
  if (data.sdp?.type === 'offer' && voice.peers.get(from)?.pc.remoteDescription) voiceDrop(from);
  const peer = voicePeer(from, false);
  const pc = peer.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      for (const c of peer.queue.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        voiceSend(from, { sdp: pc.localDescription });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.queue.push(data.candidate); // chegou antes da oferta
    }
  } catch {}
}

// A lista da sala mudou: fecha a ligação de quem saiu e liga em quem entrou antes de nós.
function onVoiceMembers(members) {
  voice.members = members;
  if (voice.on) {
    for (const id of [...voice.peers.keys()]) if (!members.some((m) => m.id === id)) voiceDrop(id);
    // o hub nos tirou (ficamos sem conexão por um tempo): entra de novo
    if (!members.some((m) => m.id === me.id)) joinVoice(true);
  }
  renderVoiceBadge();
}

async function joinVoice(rejoin = false) {
  if (voice.joining || (voice.on && !rejoin)) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    return alert('O navegador só libera o microfone em páginas seguras (https). Abra o hub pelo endereço com https.');
  }
  voice.joining = true;
  try {
    if (!voice.stream) {
      try {
        voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch {
        return alert('Não consegui usar o microfone. Libere a permissão do microfone para este site no navegador e tente de novo.');
      }
      voice.stream.getAudioTracks().forEach((t) => (t.enabled = !voice.muted));
      voiceWatch(me.id, voice.stream);
    }
    const { members } = await api('POST', '/api/community/voice/join');
    voice.on = true;
    voice.members = members;
    // quem já estava na sala não sabe de nós: nós mandamos a oferta
    for (const m of members) if (m.id !== me.id) voicePeer(m.id, true);
    clearInterval(voice.timer);
    voice.timer = setInterval(voiceTick, 200);
  } catch {
    voice.on = false;
  } finally {
    voice.joining = false;
    renderVoiceBadge();
  }
}

function leaveVoice() {
  if (!voice.on && !voice.stream) return;
  voice.on = false;
  clearInterval(voice.timer);
  for (const id of [...voice.peers.keys()]) voiceDrop(id);
  voice.stream?.getTracks().forEach((t) => t.stop());
  voice.stream = null;
  voice.levels.clear();
  voice.speaking.clear();
  api('POST', '/api/community/voice/leave', {}, { quiet: true }).catch(() => {});
  renderVoiceBadge();
}

function toggleSelfMute() {
  voice.muted = !voice.muted;
  voice.stream?.getAudioTracks().forEach((t) => (t.enabled = !voice.muted));
  renderVoiceWindow(wins.get('voice'));
}

// Silenciar uma pessoa só vale para você: ela continua falando para os outros.
function togglePeerMute(id) {
  const peer = voice.peers.get(id);
  if (!peer) return;
  peer.muted = !peer.muted;
  peer.audio.muted = peer.muted;
  renderVoiceWindow(wins.get('voice'));
}

window.addEventListener('pagehide', () => { if (voice.on) navigator.sendBeacon?.('/api/community/voice/leave', new Blob(['{}'], { type: 'application/json' })); });

function renderVoiceWindow(win) {
  if (!win) return;
  const rows = voice.members.map((m) => {
    const self = m.id === me.id;
    const peer = voice.peers.get(m.id);
    const muted = self ? voice.muted : peer?.muted;
    const state = self ? 'você' : !voice.on ? '' : peer ? peer.state : 'conectando';
    return `<div class="card voice-row ${voice.speaking.has(m.id) ? 'speaking' : ''}" data-vid="${esc(m.id)}">
      <span class="voice-dot"></span>
      <div class="title">${esc(m.name)} ${muted ? '<span title="Mutado">🔇</span>' : ''}</div>
      <div class="sub">${state}</div>
      ${voice.on ? `<button data-act="${self ? 'self' : 'peer'}" data-id="${esc(m.id)}">${self ? (voice.muted ? '🎙️ Ativar meu microfone' : '🔇 Mutar meu microfone') : (muted ? '🔈 Ouvir' : '🔇 Mutar para mim')}</button>` : ''}
    </div>`;
  }).join('');
  win.body.innerHTML = `
    <p class="muted">Sala de voz de toda a equipe, para conversar como num chat de voz. O áudio vai direto entre as pessoas, sem passar pelo hub.
      Até 6 pessoas. Mutar alguém só vale para você.</p>
    <div class="row">${voice.on
      ? `<button class="danger" data-act="leave">Sair da sala</button>`
      : `<button class="primary" data-act="join">🎙️ Entrar na sala de voz</button>`}</div>
    <h3>Na sala (${voice.members.length})</h3>
    ${rows || '<p class="muted">Ninguém na sala agora.</p>'}`;
}

function openVoiceWindow() {
  const win = openWindow('voice', { w: 420, h: 520, cls: 'win-vars' }, (win) => {
    win.titleEl.textContent = '🎙️ Sala de voz';
    win.body.onclick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'join') joinVoice();
      else if (b.dataset.act === 'leave') leaveVoice();
      else if (b.dataset.act === 'self') toggleSelfMute();
      else if (b.dataset.act === 'peer') togglePeerMute(b.dataset.id);
    };
  });
  api('GET', '/api/community/voice', undefined, { quiet: true }).then((d) => onVoiceMembers(d.members)).catch(() => {});
  renderVoiceWindow(win);
}
document.getElementById('btn-voice').onclick = () => openVoiceWindow();

// ---------- Visita (só a dona do hub) ----------
// Resumo só de leitura do escritório de um colega: mesas, agentes e o que estão fazendo.
async function openVisitWindow(person) {
  const data = await api('GET', `/api/team/${person.id}/office`);
  const win = openWindow('visit-' + person.id, { w: 460, h: 520 }, (win) => { win.titleEl.textContent = `🏢 Escritório de ${person.name}`; });
  const desk = (d) => `<div class="log-item"><b>${esc(d.name)}</b>${d.secretaria ? ' 🗂️' : ''} ${d.agent ? badge(d.ocupada ? 'trabalhando' : d.agent.status) : '<span class="muted">sem agente</span>'}
    <br><span class="muted">${d.agent ? esc(d.agent.name) + (d.agent.role ? ' · ' + esc(d.agent.role) : '') : ''}${d.naFila ? ` · ${d.naFila} na fila` : ''}</span>
    ${d.agent?.message ? `<br>${esc(d.agent.message)}` : ''}</div>`;
  win.body.innerHTML = '<p class="muted">Visita somente leitura.</p>' + data.rooms.map((r) =>
    `<h3>${esc(r.name)}</h3>${data.desks.filter((d) => d.roomId === r.id).map(desk).join('') || '<p class="muted">Sem mesas.</p>'}`).join('');
}

// ---------- Tarefas ----------
const tk = { tasks: [], people: [], filter: 'open' };
const TASK_STATUS = { todo: 'A fazer', doing: 'Em andamento', done: 'Concluída' };

async function loadTasks(win) {
  // não recria a lista enquanto a pessoa digita dentro dela
  if (win.body.querySelector('.task-list :focus')) { win.dirty = true; return; }
  const r = await api('GET', '/api/tasks', undefined, { quiet: true }).catch(() => null);
  if (!r) return;
  Object.assign(tk, r);
  win.dirty = false;
  renderTasks(win);
}

function taskCard(t) {
  const mine = t.by === me.id;
  const who = [mine ? null : `de ${t.byName}`, ...t.people.map((id) => (id === me.id ? 'você' : tk.people.find((p) => p.id === id)?.name)).filter(Boolean)].filter(Boolean);
  const last = t.delegations.at(-1);
  const desks = state.projects.filter((p) => p.agentId || p.role === 'secretaria');
  return `<details class="task st-${t.status}" data-id="${esc(t.id)}">
    <summary><span class="task-title">${esc(t.title)}</span>
      <span class="muted">${esc(TASK_STATUS[t.status])}${t.priority === 'alta' ? ' · 🔺 alta' : ''}${t.due ? ' · ' + esc(t.due.split('-').reverse().join('/')) : ''}${who.length ? ' · ' + esc(who.join(', ')) : ''}${last ? ' · 🤖 ' + esc(last.desk) : ''}</span></summary>
    <label>Título<input data-f="title" value="${esc(t.title)}" maxlength="200" /></label>
    <label>Detalhes<textarea data-f="description" rows="3">${esc(t.description)}</textarea></label>
    <div class="colors">
      <label>Status<select data-f="status">${Object.entries(TASK_STATUS).map(([k, v]) => `<option value="${k}" ${k === t.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Prioridade<select data-f="priority">${['baixa', 'normal', 'alta'].map((k) => `<option ${k === t.priority ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>Prazo<input data-f="due" type="date" value="${esc(t.due || '')}" /></label>
    </div>
    <label>Bitrix (link ou número)<input data-f="bitrix" value="${esc(t.bitrix)}" maxlength="200" /></label>
    ${mine && tk.people.length ? `<div class="task-people muted">Compartilhar com: ${tk.people.map((p) =>
      `<label class="inline"><input type="checkbox" data-person="${esc(p.id)}" ${t.people.includes(p.id) ? 'checked' : ''} /> ${esc(p.name)}</label>`).join(' ')}</div>` : ''}
    <div class="row">
      <select data-f-desk><option value="">Delegar a um agente…</option>${desks.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.role === 'secretaria' ? ' (secretária)' : ''}</option>`).join('')}</select>
      ${mine ? '<button class="danger" data-act="del">Apagar</button>' : ''}
    </div>
    ${t.delegations.length ? `<p class="muted">${t.delegations.map((d) => `${esc(d.byName)} passou para ${esc(d.desk)} (${timeAgo(d.at)})`).join('<br>')}</p>` : ''}
  </details>`;
}

function renderTasks(win) {
  const open = new Set([...win.body.querySelectorAll('.task[open]')].map((d) => d.dataset.id)); // mantém abertas
  const shown = tk.tasks.filter((t) => tk.filter === 'all' || (tk.filter === 'done') === (t.status === 'done'))
    .sort((a, b) => (a.status === 'done') - (b.status === 'done') || (a.due || '9') .localeCompare(b.due || '9') || b.updatedAt - a.updatedAt);
  const list = win.body.querySelector('.task-list');
  list.innerHTML = shown.map(taskCard).join('') || '<p class="muted">Nenhuma tarefa por aqui.</p>';
  for (const d of list.querySelectorAll('.task')) if (open.has(d.dataset.id)) d.open = true;
  for (const b of win.body.querySelectorAll('[data-filter]')) b.classList.toggle('on', b.dataset.filter === tk.filter);
}

function openTasksWindow() {
  const win = openWindow('tasks', { w: 520, h: 600, cls: 'win-tasks' }, (win) => {
    win.titleEl.textContent = '📋 Tarefas';
    win.body.innerHTML = `
      <form class="task-new"><input name="title" placeholder="Nova tarefa…" maxlength="200" required />
        <button class="primary">Adicionar</button></form>
      <div class="comm-tabs">${[['open', 'Abertas'], ['done', 'Concluídas'], ['all', 'Todas']].map(([k, v]) => `<button class="comm-tab" data-filter="${k}">${v}</button>`).join('')}</div>
      <div class="task-list"></div>`;
    const q = (s) => win.body.querySelector(s);
    q('.task-new').onsubmit = async (e) => {
      e.preventDefault();
      const title = e.target.title.value;
      e.target.reset();
      await api('POST', '/api/tasks', { title });
      loadTasks(win);
    };
    win.body.addEventListener('click', (e) => {
      const f = e.target.closest('[data-filter]');
      if (f) { tk.filter = f.dataset.filter; renderTasks(win); }
    });
    const list = q('.task-list');
    const idOf = (el) => el.closest('.task').dataset.id;
    list.addEventListener('change', async (e) => {
      const el = e.target;
      const id = idOf(el);
      try {
        if (el.dataset.f) await api('PATCH', `/api/tasks/${id}`, { [el.dataset.f]: el.value });
        else if (el.dataset.person) {
          const t = tk.tasks.find((x) => x.id === id);
          const people = new Set(t.people);
          el.checked ? people.add(el.dataset.person) : people.delete(el.dataset.person);
          await api('PATCH', `/api/tasks/${id}`, { people: [...people] });
        } else if ('fDesk' in el.dataset) {
          if (!el.value) return;
          const r = await api('POST', `/api/tasks/${id}/delegate`, { mesa: el.value });
          alert(r.naFila ? `Entrou na fila de ${r.mesa} (${r.motivo}).` : `${r.mesa} começou a trabalhar nisso.`);
        }
      } catch {}
      win.dirty = false;
      loadTasks(win);
    });
    list.addEventListener('click', async (e) => {
      if (e.target.dataset.act !== 'del') return;
      if (confirm('Apagar esta tarefa para todos que a veem?')) { await api('DELETE', `/api/tasks/${idOf(e.target)}`); loadTasks(win); }
    });
    list.addEventListener('focusout', () => setTimeout(() => { if (win.dirty) loadTasks(win); }, 200));
    loadTasks(win);
  });
  return win;
}

document.getElementById('btn-tasks').onclick = () => openTasksWindow();

// ---------- Início ----------
boot();
requestAnimationFrame(frame);
setInterval(() => { if (world) refreshUI(); }, 30000);

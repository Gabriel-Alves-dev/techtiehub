// Techtie Hub — escritório em pixel art. Cada mesa é um projeto, cada personagem é um agente.
'use strict';

// ---------- Layout do mundo (em pixels "de mundo"; a tela multiplica por SCALE) ----------
const T = 16; // tamanho do tile
const CELL_W = 5, CELL_H = 5; // tiles por mesa
const WALL_H = 3; // parede do topo, em tiles
const DESK_X0 = 1;
const LOUNGE_W = 7;
const SPEED = 48; // px de mundo por segundo

const STATUS = {
  trabalhando: { label: 'Trabalhando', color: '#3fbf7f' },
  ocioso: { label: 'Ocioso', color: '#9097b0' },
  bloqueado: { label: 'Bloqueado', color: '#e5534b' },
  concluido: { label: 'Concluído', color: '#4f8cff' },
};

const canvas = document.getElementById('office');
const ctx = canvas.getContext('2d');
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
  const first = currentRoom() === state.rooms[0];
  return state.agents.filter((a) => {
    const desk = deskOf(a.id);
    return desk ? desk.here : first;
  });
}

function computeWorld() {
  const room = currentRoom();
  const cols = room?.cols || 4;
  const slots = roomProjects().length + 1; // +1 = mesa vazia para criar projeto
  const rows = Math.max(2, Math.ceil(slots / cols));
  const loungeX = DESK_X0 + cols * CELL_W;
  const areas = AREA_ORDER.filter((a) => (room?.areas || AREA_ORDER).includes(a));
  if (!areas.length) areas.push('copa');
  const areaTiles = areas.reduce((sum, a) => sum + AREA_H[a], 0);
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
    cols, rows, W, H, L, top, bottom, mid, spots, blocks, floor: room?.floor || 'madeira',
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
  for (const p of state.projects) p.folder = id ? p.folders?.[id] || null : null;
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
  const i = roomProjects().indexOf(project);
  return { project, here: i >= 0, cell: i >= 0 ? cellOf(i) : null };
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
      rt.wanderAt = Date.now() + 10000 + Math.random() * 20000;
      start = world.spots[rt.spot];
    }
    runtime.set(a.id, Object.assign(rt, { x: start.x, y: start.y }));
  }
  for (const id of runtime.keys()) if (!visible.some((a) => a.id === id)) runtime.delete(id);
}

let clockOffset = 0; // relógio do navegador − relógio do hub

function applyState(next) {
  const firstLoad = !world;
  state = next;
  if (state.now) clockOffset = Date.now() - state.now;
  if (!state.rooms.some((r) => r.id === roomId)) roomId = state.rooms[0]?.id;
  resolveEnv();
  world = computeWorld();
  syncRuntime(firstLoad);
  if (selected && !state.projects.some((p) => p.id === selected.id)) selected = null;
  resize();
  refreshUI();
  // localhost:4321/#<id-da-mesa> já abre a conversa daquela mesa
  if (firstLoad && state.projects.some((p) => p.id === location.hash.slice(1))) openProjectWindow(location.hash.slice(1));
}

// ---------- Simulação ----------
function pickSpot(agentId) {
  const taken = new Set();
  for (const [id, rt] of runtime) if (id !== agentId && rt.spot != null) taken.add(rt.spot);
  const free = world.spots.map((_, i) => i).filter((i) => !taken.has(i));
  const pool = free.length ? free : world.spots.map((_, i) => i);
  return pool[Math.floor(Math.random() * pool.length)];
}

function switchRoom(id) {
  if (id === currentRoom()?.id) return;
  roomId = id;
  store('hub.room', id);
  runtime.clear();
  world = computeWorld();
  syncRuntime(true);
  wrap.scrollTo(0, 0);
  resize();
  refreshUI();
}

function update(dt, now) {
  for (const a of visibleAgents()) {
    const rt = runtime.get(a.id);
    const desk = deskOf(a.id);
    let target, key;

    if (desk && a.status !== 'ocioso') {
      target = desk.cell.seat;
      key = 'desk:' + desk.project.id + ':' + roomProjects().indexOf(desk.project) + ':' + world.cols;
      rt.spot = null;
    } else {
      if (rt.spot == null || now > rt.wanderAt) {
        rt.spot = pickSpot(a.id);
        rt.wanderAt = now + 10000 + Math.random() * 20000;
      }
      target = world.spots[rt.spot];
      key = 'spot:' + rt.spot + ':' + world.H + ':' + world.W;
    }

    if (key !== rt.targetKey) {
      rt.targetKey = key;
      rt.path = route(rt, target);
    }

    rt.moving = false;
    let budget = SPEED * dt;
    while (budget > 0 && rt.path.length) {
      const p = rt.path[0];
      const dx = p.x - rt.x, dy = p.y - rt.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.01) { rt.path.shift(); continue; }
      const step = Math.min(budget, d);
      rt.x += (dx / d) * step;
      rt.y += (dy / d) * step;
      budget -= step;
      rt.walk += step;
      rt.moving = true;
      rt.facing = Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : dx < 0 ? 'left' : 'right';
    }
    const arrived = !rt.path.length;
    rt.seated = arrived && key.startsWith('desk');
    rt.atSpot = arrived && !rt.seated && rt.spot != null ? world.spots[rt.spot] : null;
    if (rt.seated) rt.facing = 'up';
    else if (rt.atSpot) rt.facing = rt.atSpot.facing;
    else if (!rt.moving) rt.facing = 'down';
  }
}

// ---------- Desenho ----------
const rect = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };

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
  // paredes
  rect(0, 0, W * T, top, '#5b6178');
  rect(0, top - 4, W * T, 4, '#3d4256');
  rect(0, 0, T, H * T, '#3d4256');
  rect((W - 1) * T, 0, T, H * T, '#3d4256');
  rect(0, bottom, W * T, T, '#3d4256');
  rect(0, 0, W * T, 3, '#2b2f3e');

  // janelas
  const [sky1, sky2] = skyColor();
  for (let x = 2 * T; x + 3 * T < L; x += 5 * T) {
    rect(x - 2, 0.6 * T - 2, 3 * T + 4, 1.6 * T + 4, '#2b2f3e');
    rect(x, 0.6 * T, 3 * T, 0.8 * T, sky1);
    rect(x, 1.4 * T, 3 * T, 0.8 * T, sky2);
    rect(x + 1.5 * T - 1, 0.6 * T, 2, 1.6 * T, '#2b2f3e');
  }

  // relógio de verdade no lounge
  const cx = L + 3.5 * T, cy = 1.3 * T;
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

  // porta
  rect(world.door.x - 12, bottom, 24, T, '#2b2f3e');
  rect(world.door.x - 10, bottom + 2, 20, T - 2, '#7a5a3a');

  drawAreas(now);
}

function plant(x, y) {
  rect(x - 5, y - 6, 10, 8, '#b5643c');
  rect(x - 6, y - 7, 12, 2, '#8e4a2c');
  ctx.fillStyle = '#3f9b54';
  for (const [ox, oy, r] of [[0, -14, 6], [-5, -10, 5], [5, -10, 5], [0, -19, 4]]) {
    ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2); ctx.fill();
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

function drawCopa({ y0 }, now) {
  const { L } = world;
  // bancada com cafeteira
  rect(L + 0.3 * T, y0, 6.4 * T, T, '#d8d2c4');
  rect(L + 0.3 * T, y0 + T, 6.4 * T, 4, '#a49d8c');
  rect(L + 1 * T, y0 - 10, 12, 16, '#2d2d2d');
  rect(L + 1 * T + 3, y0 - 6, 6, 4, now % 1000 < 500 ? '#e5534b' : '#702a26');
  rect(L + 2.2 * T, y0 + 2, 6, 7, '#f5f5f5');
  rect(L + 2.7 * T, y0 + 2, 6, 7, '#4f8cff');
  // galão de água
  rect(L + 5.6 * T, y0 - 14, 12, 12, '#8fd3ff');
  rect(L + 5.6 * T, y0 - 2, 12, 14, '#e8eaf2');
  // mesinha
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
  rect(ax, ay, 16, 30, '#2b2f6e');
  rect(ax, ay, 16, 4, '#e5534b');
  rect(ax + 3, ay + 7, 10, 8, playing ? ['#3fbf7f', '#f2a93b', '#4f8cff', '#e5534b'][Math.floor(now / 180) % 4] : '#111');
  rect(ax + 2, ay + 18, 12, 3, '#1c1c24');
}

function drawDesk(i, now) {
  const project = roomProjects()[i];
  const c = cellOf(i);
  const agent = project ? state.agents.find((a) => a.id === project.agentId) : null;
  const rt = agent && runtime.get(agent.id);
  const isSel = selected && ((selected.kind === 'project' && project && selected.id === project.id) || (selected.kind === 'slot' && !project));
  const isHover = hover && hover.kind === (project ? 'project' : 'slot') && (!project || hover.id === project.id);

  if (!project) {
    // mesa vaga: clique para criar um projeto
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
  } else if (st === 'concluido' && present) {
    rect(mx, my, mw, mh, '#1a3a7a');
    text('✓', mx + mw / 2, my + mh / 2 + 0.5, 10, '#fff');
  } else {
    rect(mx, my, mw, mh, '#22232d');
    rect(mx + 2, my + 2, 4, 2, '#33354a');
  }

  // teclado e caneca
  rect(c.x + 2 * T, dy + 0.5 * T, T, 4, '#d0d0d8');
  rect(c.x + 3.4 * T, dy + 0.25 * T, 5, 5, project.color || '#fff');

  // cadeira (assento; o encosto é desenhado depois do agente)
  rect(c.seat.x - 7, c.seat.y - 6, 14, 6, '#2d3142');
  if (!present) rect(c.seat.x - 7, c.seat.y - 2, 14, 7, '#3a3f55');

  text(truncate(project.name.toUpperCase(), 14), c.x + 2.5 * T, c.y + 4.25 * T, 7, '#fff');
}

function drawAgent(a, rt, now) {
  const x = Math.round(rt.x), y = Math.round(rt.y);
  const step = rt.moving ? Math.floor(rt.walk / 4) % 2 : 0;
  const back = rt.facing === 'up';

  ctx.fillStyle = '#0005';
  ctx.beginPath(); ctx.ellipse(x, y, 6, 2.5, 0, 0, Math.PI * 2); ctx.fill();

  // pernas
  rect(x - 4, y - 6, 3, 6 - (step ? 1 : 0), '#2a2f45');
  rect(x + 1, y - 6, 3, 6 - (step ? 0 : 1), '#2a2f45');
  // corpo e braços
  rect(x - 5, y - 12, 10, 7, a.shirt || '#4f8cff');
  const armSwing = rt.moving ? (step ? 1 : -1) : 0;
  rect(x - 7, y - 11 + armSwing, 2, 5, a.shirt || '#4f8cff');
  rect(x + 5, y - 11 - armSwing, 2, 5, a.shirt || '#4f8cff');
  rect(x - 7, y - 6 + armSwing, 2, 2, a.skin || '#f1c7a0');
  rect(x + 5, y - 6 - armSwing, 2, 2, a.skin || '#f1c7a0');
  // cabeça
  rect(x - 4, y - 20, 8, 8, a.skin || '#f1c7a0');
  const hair = a.hair || '#3b2416';
  if (back) {
    rect(x - 4, y - 21, 8, 8, hair);
  } else {
    rect(x - 4, y - 21, 8, 3, hair);
    rect(x - 5, y - 20, 1, 5, hair);
    rect(x + 4, y - 20, 1, 5, hair);
    const eo = rt.facing === 'left' ? -1 : rt.facing === 'right' ? 1 : 0;
    const blink = now % 4000 < 120;
    if (!blink) { rect(x - 2 + eo, y - 16, 1, 2, '#1a1a1a'); rect(x + 1 + eo, y - 16, 1, 2, '#1a1a1a'); }
  }

  // digitando: mãos alternando sobre o teclado
  if (rt.seated && a.status === 'trabalhando') {
    const k = Math.floor(now / 140) % 2;
    rect(x - 5, y - 24 - k, 3, 2, a.skin || '#f1c7a0');
    rect(x + 2, y - 24 - (1 - k), 3, 2, a.skin || '#f1c7a0');
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

function draw(now) {
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  ctx.imageSmoothingEnabled = false;
  drawRoom(now);
  const slots = roomProjects().length + 1;
  for (let i = 0; i < slots; i++) drawDesk(i, now);

  const ordered = visibleAgents().map((a) => [a, runtime.get(a.id)]).sort((p, q) => p[1].y - q[1].y);
  for (const [a, rt] of ordered) {
    drawAgent(a, rt, now);
    if (rt.seated || rt.atSpot?.chair === 'bottom') drawChairBack(rt);
  }
  const talkers = ordered.filter(([, rt]) => rt.atSpot?.act === 'reuniao').map(([a]) => a.id);
  for (const [a, rt] of ordered) drawLabels(a, rt, now, talkers);
}

// ---------- Loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (world) {
    update(dt, Date.now());
    draw(Date.now());
    updateBubbles();
  }
  requestAnimationFrame(frame);
}

const MIN_ZOOM = 1, MAX_ZOOM = 6;

function resize() {
  if (!world) return;
  const ww = world.W * T, wh = world.H * T;
  const fit = Math.floor(Math.min((wrap.clientWidth - 16) / ww, (wrap.clientHeight - 16) / wh));
  SCALE = zoom ?? Math.max(MIN_ZOOM, Math.min(4, fit));
  if (canvas.width !== ww * SCALE || canvas.height !== wh * SCALE) {
    canvas.width = ww * SCALE;
    canvas.height = wh * SCALE;
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

document.getElementById('zoom-in').onclick = () => setZoom(SCALE + 1);
document.getElementById('zoom-out').onclick = () => setZoom(SCALE - 1);
document.getElementById('zoom-fit').onclick = () => setZoom(null);
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
  drag = { x: e.clientX, y: e.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop, moved: false };
});
window.addEventListener('pointermove', (e) => {
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
  if (a.status === 'concluido') return { cls: 'done', text: '✓ Pronto!' };
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
    // sentado: acima do monitor; andando: acima do nome
    const by = rt.seated ? rt.y - 46 : rt.y - 34;
    el.style.transform = `translate(${Math.round(ox + rt.x * SCALE)}px, ${Math.round(oy + by * SCALE)}px) translate(-50%, -100%)`;
  }
  for (const [id, el] of bubbleEls) if (!seen.has(id)) { el.remove(); bubbleEls.delete(id); }
}

// ---------- Interação no canvas ----------
function hitTest(ev) {
  const r = canvas.getBoundingClientRect();
  const wx = (ev.clientX - r.left) / SCALE, wy = (ev.clientY - r.top) / SCALE;
  const ordered = visibleAgents().map((a) => [a, runtime.get(a.id)]).sort((p, q) => q[1].y - p[1].y);
  for (const [a, rt] of ordered) {
    if (wx > rt.x - 8 && wx < rt.x + 8 && wy > rt.y - 24 && wy < rt.y + 2) return { kind: 'agent', id: a.id };
  }
  const rp = roomProjects();
  for (let i = 0; i <= rp.length; i++) {
    const c = cellOf(i);
    if (wx > c.x + 0.5 * T && wx < c.x + 4.5 * T && wy > c.y + 0.5 * T && wy < c.y + 4.3 * T) {
      return rp[i] ? { kind: 'project', id: rp[i].id } : { kind: 'slot' };
    }
  }
  return null;
}

canvas.addEventListener('mousemove', (ev) => {
  if (drag?.moved) return;
  hover = hitTest(ev);
  canvas.style.cursor = hover ? 'pointer' : 'default';
  if (!hover || hover.kind === 'slot') { tooltip.hidden = true; return; }
  let html;
  if (hover.kind === 'agent') {
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
});
canvas.addEventListener('mouseleave', () => { hover = null; tooltip.hidden = true; });

canvas.addEventListener('click', (ev) => {
  if (suppressClick) { suppressClick = false; return; } // foi um arrasto, não um clique
  const hit = hitTest(ev);
  if (!hit) return;
  if (hit.kind === 'slot') return openProjectDialog();
  if (hit.kind === 'project') return openProjectWindow(hit.id);
  const a = state.agents.find((x) => x.id === hit.id);
  const desk = deskOf(a.id);
  if (desk) openProjectWindow(desk.project.id);
  else openAgentDialog(a);
});

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
      <h3>Convidar alguém</h3>
      <p class="muted">A pessoa cria a própria conta, com um escritório só dela, usando este código (vale 7 dias e só uma vez).</p>
      <div data-field="invite"><div class="row"><button data-act="invite">Gerar convite</button></div></div>
      <h3>Sessão</h3>
      <div class="row"><button class="danger" data-act="logout">Sair</button></div>`;
    win.body.querySelector('[data-form=password]').onsubmit = async (e) => {
      e.preventDefault();
      await api('POST', '/api/auth/password', Object.fromEntries(new FormData(e.target)));
      e.target.reset();
      win.body.querySelector('[data-field=pw-msg]').textContent = 'Senha trocada. As outras sessões foram encerradas.';
    };
    win.body.querySelector('[data-act=invite]').onclick = async () => {
      const inv = await api('POST', '/api/auth/invite', {});
      win.body.querySelector('[data-field=invite]').innerHTML = `<div class="code">${esc(inv.code)}</div>
        <p class="muted">Envie o código e o endereço do hub. A pessoa clica em “Recebi um convite” na tela de entrada.</p>`;
    };
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
  const i = roomProjects().findIndex((p) => p.id === projectId);
  if (i < 0) return null;
  const c = cellOf(i);
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
          <button data-act="reset" title="Começa uma conversa do zero (o agente esquece o contexto)">Nova conversa</button>
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
      if (!confirm('Começar uma conversa nova? O agente guarda um resumo na memória e começa uma sessão limpa.')) return;
      win.body.querySelector('[data-act=reset]').textContent = 'Guardando memória…';
      await api('POST', `/api/projects/${projectId}/reset`, {});
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
  const canChat = !!p.folder || p.role === 'secretaria'; // a secretária não precisa de pasta de projeto
  input.placeholder = p.role === 'secretaria'
    ? `Peça algo para ${who}… (ex.: leia minhas mensagens no Bitrix e passe a demanda para a mesa certa)`
    : p.folder ? `Peça algo para ${who}… (Enter envia · Shift+Enter quebra linha)` : 'Defina a pasta do projeto primeiro';
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
  if (!state.env) {
    msgs.push(Object.keys(state.connectors || {}).length
      ? '🖥 Escolha em qual PC executar no botão <b>PC</b> (topo).'
      : '🖥 Nenhum PC conectado ao hub. Abra o botão <b>PC</b> para conectar o seu computador.');
  } else if (!p.folder && p.role !== 'secretaria') {
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
        out.innerHTML = `<p><b>${MCP_STATUS[r.status] || esc(r.status)}</b>${r.error ? ` <span class="muted">— ${esc(r.error)}</span>` : ''}</p>
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

// "Nome: valor" por linha <-> objeto (cabeçalhos); "NOME=valor" por linha <-> objeto (variáveis)
const toLines = (obj, sep) => Object.entries(obj || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
const fromLines = (text, sep) => Object.fromEntries(String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => { const i = l.indexOf(sep); return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

function openMcpDialog(win, s) {
  const type = s?.type || 'http';
  const projects = s?.projects || 'all';
  openDialog(`
    <h2>${s ? 'Editar servidor MCP' : 'Novo servidor MCP'}</h2>
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
    <label>Mesas por fileira: <b id="cols-out">${r?.cols || 4}</b>
      <input type="range" name="cols" min="2" max="8" value="${r?.cols || 4}" />
    </label>
    <fieldset class="areas"><legend>Áreas da coluna lateral</legend>
      ${AREA_ORDER.map((k) => `<label class="option"><input type="checkbox" name="areas" value="${k}"
        ${(r?.areas || AREA_ORDER).includes(k) ? 'checked' : ''} /><span>${AREA_NAMES[k]}</span></label>`).join('')}
    </fieldset>
    <label>Piso<select name="floor">${Object.entries(FLOOR_NAMES).map(([k, v]) =>
      `<option value="${k}" ${k === (r?.floor || 'carpete') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
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
      <label>Modelo<select name="model">${Object.entries(MODEL_NAMES).map(([k, v]) =>
        `<option value="${k}" ${k === (a?.model || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Esforço<select name="effort">${Object.entries(EFFORT_NAMES).map(([k, v]) =>
        `<option value="${k}" ${k === (a?.effort || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <p class="muted dialog-hint">“Padrão do PC” usa o que estiver configurado no Claude Code do computador que executa.
      Mais esforço pensa mais (melhor em tarefas difíceis), mas demora e gasta mais do seu plano.</p>
  `, async (d) => {
    if (a) await api('PATCH', `/api/agents/${a.id}`, d);
    else await api('POST', '/api/agents', d);
  }, a && { label: 'Demitir', confirm: `Demitir ${a.name}?`, action: () => api('DELETE', `/api/agents/${a.id}`) });
}

document.getElementById('btn-new-project').onclick = () => openProjectDialog();
document.getElementById('btn-new-agent').onclick = () => openAgentDialog();
document.getElementById('btn-team').onclick = () => openTeamWindow();
document.getElementById('btn-log').onclick = () => openLogWindow();
document.getElementById('btn-env').onclick = () => openEnvWindow();
document.getElementById('btn-account').onclick = () => openAccountWindow();
document.getElementById('btn-mcp').onclick = () => openMcpWindow();
document.getElementById('btn-office-memory').onclick = () => openOfficeMemoryWindow();

// ---------- Início ----------
boot();
requestAnimationFrame(frame);
setInterval(() => { if (world) refreshUI(); }, 30000);

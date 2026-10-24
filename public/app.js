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
  const W = loungeX + LOUNGE_W + 1;
  const H = WALL_H + rows * CELL_H + 1;
  const L = loungeX * T;
  const top = WALL_H * T;
  const bottom = (H - 1) * T;
  const mid = (top + bottom) / 2;

  const spots = [];
  for (let i = 0; i < 4; i++) spots.push({ x: L + (1.2 + i * 1.5) * T, y: top + 2.2 * T });
  for (let i = 0; i < 3; i++) spots.push({ x: L + (1.5 + i * 2) * T, y: mid + 0.6 * T });
  for (let i = 0; i < 3; i++) spots.push({ x: L + (1.8 + i * 1.6) * T, y: bottom - 2.4 * T });

  return {
    cols, rows, W, H, L, top, bottom, mid, spots, floor: room?.floor || 'madeira',
    trunkX: (loungeX - 0.4) * T,
    door: { x: (loungeX - 0.4) * T, y: bottom + 0.6 * T },
  };
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
    const start = atSeats && desk && a.status !== 'ocioso' ? desk.cell.seat : world.door;
    runtime.set(a.id, { x: start.x, y: start.y, path: [], targetKey: null, walk: 0, facing: 'up', wanderAt: 0 });
  }
  for (const id of runtime.keys()) if (!visible.some((a) => a.id === id)) runtime.delete(id);
}

function applyState(next) {
  const firstLoad = !world;
  state = next;
  if (!state.rooms.some((r) => r.id === roomId)) roomId = state.rooms[0]?.id;
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
        rt.wanderAt = now + 6000 + Math.random() * 9000;
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
    rt.seated = !rt.path.length && key.startsWith('desk');
    if (rt.seated) rt.facing = 'up';
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

  drawLounge(now);
}

function plant(x, y) {
  rect(x - 5, y - 6, 10, 8, '#b5643c');
  rect(x - 6, y - 7, 12, 2, '#8e4a2c');
  ctx.fillStyle = '#3f9b54';
  for (const [ox, oy, r] of [[0, -14, 6], [-5, -10, 5], [5, -10, 5], [0, -19, 4]]) {
    ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2); ctx.fill();
  }
}

function drawLounge(now) {
  const { L, top, bottom, mid } = world;
  // bancada com cafeteira
  rect(L + 0.3 * T, top, 6.4 * T, T, '#d8d2c4');
  rect(L + 0.3 * T, top + T, 6.4 * T, 4, '#a49d8c');
  rect(L + 1 * T, top - 10, 12, 16, '#2d2d2d');
  rect(L + 1 * T + 3, top - 6, 6, 4, now % 1000 < 500 ? '#e5534b' : '#702a26');
  rect(L + 2.2 * T, top + 2, 6, 7, '#f5f5f5');
  rect(L + 2.7 * T, top + 2, 6, 7, '#4f8cff');
  // galão de água
  rect(L + 5.6 * T, top - 14, 12, 12, '#8fd3ff');
  rect(L + 5.6 * T, top - 2, 12, 14, '#e8eaf2');
  // mesa de centro
  ctx.fillStyle = '#7a5a3a';
  ctx.beginPath(); ctx.ellipse(L + 3.5 * T, mid, 18, 9, 0, 0, Math.PI * 2); ctx.fill();
  rect(L + 3.5 * T - 3, mid - 4, 6, 5, '#f5f5f5');
  // sofá
  const sy = bottom - 1.8 * T;
  rect(L + 0.8 * T, sy, 5.4 * T, 1.5 * T, '#c0392b');
  rect(L + 0.8 * T, sy + 1.1 * T, 5.4 * T, 0.4 * T, '#8e2a20');
  rect(L + 0.8 * T, sy - 2, 8, 1.5 * T + 2, '#a5311f');
  rect(L + 6.2 * T - 8, sy - 2, 8, 1.5 * T + 2, '#a5311f');
  // plantas
  plant(L + 0.6 * T, top + 3.2 * T);
  plant(L + 6.4 * T, mid + 1.2 * T);
  plant(1.6 * T, world.bottom - 0.2 * T);
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

function drawLabels(a, rt, now) {
  const isSel = selected?.kind === 'project' && deskOf(a.id)?.project.id === selected.id;
  const y = rt.y - 27; // acima da cabeça
  const nameY = rt.seated ? rt.y + 9 : y; // sentado: nome embaixo da cadeira, para não tampar o monitor
  text(a.name, rt.x, nameY, 7, isSel ? '#ffd166' : '#fff');
  const st = STATUS[a.status] || STATUS.ocioso;
  ctx.fillStyle = st.color;
  ctx.beginPath(); ctx.arc(rt.x + a.name.length * 7 / SCALE / 2 + 4, nameY, 2, 0, Math.PI * 2); ctx.fill();

  if (!rt.seated && !rt.moving && a.status === 'ocioso' && Math.floor(now / 3000) % 3 === 0) {
    text('☕', rt.x + 8, y - 6, 8, '#fff');
  }
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
    if (rt.seated) drawChairBack(rt);
  }
  for (const [a, rt] of ordered) drawLabels(a, rt, now);
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
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Erro ao falar com o servidor');
    throw new Error(err.error);
  }
  return res.status === 204 ? null : res.json();
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => applyState(JSON.parse(e.data));
  es.addEventListener('chat', (e) => onChatEvent(JSON.parse(e.data)));
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
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
      <div class="chat-log"><p class="muted chat-empty">Carregando…</p></div>
      <div class="pending-box"></div>
      <div class="chat-input">
        <textarea rows="2"></textarea>
        <div class="row">
          <button class="primary" data-act="send">Enviar</button>
          <button class="danger" data-act="stop" hidden>Parar</button>
          <span class="spacer"></span>
          <button data-act="reset" title="Começa uma conversa do zero (o agente esquece o contexto)">Nova conversa</button>
        </div>
      </div>`;
    const input = win.body.querySelector('textarea');
    const sendBtn = win.body.querySelector('[data-act=send]');
    const sendMsg = async () => {
      const text = input.value.trim();
      if (!text || sendBtn.disabled) return;
      input.value = '';
      try {
        await api('POST', `/api/projects/${projectId}/chat`, { message: text });
      } catch {
        input.value = text;
      }
    };
    sendBtn.onclick = sendMsg;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    };
    win.body.querySelector('[data-act=stop]').onclick = () => api('POST', `/api/projects/${projectId}/stop`, {});
    win.body.querySelector('[data-act=reset]').onclick = async () => {
      if (!confirm('Começar uma conversa nova? O agente esquece o contexto desta.')) return;
      await api('POST', `/api/projects/${projectId}/reset`, {});
      loadChat(projectId);
    };
    loadChat(projectId);
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
      <select data-act="assign" title="Agente nesta mesa">
        <option value="">— sem agente —</option>
        ${state.agents.map((x) => `<option value="${x.id}" ${x.id === p.agentId ? 'selected' : ''}>👤 ${esc(x.name)}</option>`).join('')}
      </select>
      ${a ? '<button data-act="edit-agent" title="Editar agente">✎</button>' : ''}
      ${p.folder ? '' : '<p class="muted pw-note">Escolha a pasta do projeto em <b>⚙ Mesa</b> para conversar com o agente.</p>'}`;
    const on = (act, fn) => { const b = tb.querySelector(`[data-act=${act}]`); if (b) b.onclick = fn; };
    on('folder', () => api('POST', `/api/projects/${p.id}/open`, { app: 'explorer' }));
    on('vscode', () => api('POST', `/api/projects/${p.id}/open`, { app: 'vscode' }));
    on('edit-desk', () => openProjectDialog(p));
    on('edit-agent', () => openAgentDialog(a));
    tb.querySelector('[data-act=assign]').onchange = (e) => api('PATCH', `/api/projects/${p.id}`, { agentId: e.target.value || null });
  }

  const who = a ? a.name : 'o agente';
  const input = win.body.querySelector('textarea');
  input.placeholder = p.folder ? `Peça algo para ${who}… (Enter envia · Shift+Enter quebra linha)` : 'Defina a pasta do projeto primeiro';
  input.disabled = !p.folder;
  const send = win.body.querySelector('[data-act=send]');
  send.disabled = !p.folder || !!live?.running;
  send.textContent = live?.running ? 'Trabalhando…' : 'Enviar';
  win.body.querySelector('[data-act=stop]').hidden = !live?.running;
  win.body.querySelector('[data-act=reset]').disabled = !!live?.running;
  renderPending(win, p, live?.pending);
}

async function loadChat(projectId) {
  const data = await api('GET', `/api/projects/${projectId}/chat`);
  chats.set(projectId, data.entries);
  const box = wins.get('p:' + projectId)?.body.querySelector('.chat-log');
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
  return div;
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
    </div>`;
    box.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => answer({ decision: b.dataset.d })));
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
    <label>Piso<select name="floor">${Object.entries(FLOOR_NAMES).map(([k, v]) =>
      `<option value="${k}" ${k === (r?.floor || 'carpete') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    ${r ? '' : '<p class="muted">As mesas podem ser movidas entre salas em ⚙ Mesa.</p>'}
  `, async (d) => {
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
    <label>Pasta do projeto
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
    if (p) await api('PATCH', `/api/projects/${p.id}`, d);
    else {
      const created = await api('POST', '/api/projects', { ...d, agentId: d.agentId || null });
      setTimeout(() => openProjectWindow(created.id), 100);
    }
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
  `, async (d) => {
    if (a) await api('PATCH', `/api/agents/${a.id}`, d);
    else await api('POST', '/api/agents', d);
  }, a && { label: 'Demitir', confirm: `Demitir ${a.name}?`, action: () => api('DELETE', `/api/agents/${a.id}`) });
}

document.getElementById('btn-new-project').onclick = () => openProjectDialog();
document.getElementById('btn-new-agent').onclick = () => openAgentDialog();
document.getElementById('btn-team').onclick = () => openTeamWindow();
document.getElementById('btn-log').onclick = () => openLogWindow();

// ---------- Início ----------
connect();
requestAnimationFrame(frame);
setInterval(() => { if (world) refreshUI(); }, 30000);

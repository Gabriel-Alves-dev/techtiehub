// Sala de servidores em 3D: um rack por VPS (as seis unidades são CPU, memória, disco, PM2, Docker e systemd), com LEDs,
// ventoinhas, farol de status, cabos e uma placa no chão com o nome. Só desenha: o app.js manda o resumo de cada host
// em `s.server` a cada quadro e este módulo atualiza luzes e textura sem recriar nada (a sala só é refeita quando a lista
// de hosts muda). Os utilitários de malha vêm do office3d.js (parâmetro U), para não duplicar nem importar em círculo.
import * as THREE from './vendor/three.module.min.js';
import { Builder } from './char/geometry.js';

const CRIT = '#e5534b', WARN = '#f2a93b', OKC = '#3fbf7f', IDLE = '#6b7088';
const STATUS_COLOR = { ok: OKC, atencao: WARN, critico: CRIT, 'sem-sinal': IDLE };
const STATUS_LABEL = { ok: 'OK', atencao: 'ATENÇÃO', critico: 'CRÍTICO', 'sem-sinal': 'SEM SINAL' };
const ORDER = ['ok', 'atencao', 'critico', 'sem-sinal'];

// medidas do rack (unidades do mundo = tiles)
const RW = 2.3, RD = 1.4, IH = 2.6, BASE = 0.12, TOPY = BASE + IH + 0.1;
const PW = RW - 0.38, UH = (IH - 0.1) / 6, PH = UH * 6; // painel da frente: largura, altura de uma unidade e total
const CW = 512, CH = Math.round((CW * PH) / PW); // textura da frente
const ZF = RD / 2 - 0.1; // face das unidades
const FONT = 'Inter, system-ui, sans-serif';

let glowTex = null;
const glowTexture = (U) => (glowTex ??= U.canvasTex(64, 64, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}));

let shellMat = null;
const shellMaterial = () => (shellMat ??= Object.assign(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 }), { userData: { shared: true } }));
const redraw = (tex, fn) => { const c = tex.image; fn(c.getContext('2d'), c.width, c.height); tex.needsUpdate = true; };
const glowSprite = (U, color, size, opacity = 1) => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(U), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity }));
  sp.scale.set(size, size, 1);
  return sp;
};
const basic = (color, o = {}) => new THREE.MeshBasicMaterial({ color, toneMapped: false, ...o });

// ---------- texturas ----------
// frente do rack: nome, valor e barra de cada unidade (os LEDs, que piscam, são malhas à parte)
function drawFront(g, w, h, units, stale) {
  g.clearRect(0, 0, w, h);
  const uh = h / 6;
  units.forEach((u, i) => {
    const y0 = i * uh, col = stale ? '#4a4f66' : u.color;
    g.fillStyle = '#0b0d14'; g.beginPath(); g.arc(48, y0 + uh / 2, 15, 0, 7); g.fill(); // soquete do LED
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.font = `700 28px ${FONT}`; g.fillStyle = stale ? '#6b7088' : '#c3cbe3'; g.fillText(u.name, 84, y0 + uh * 0.3);
    if (u.note) { // aviso ao lado do nome (ex.: "2 com erro · api")
      const nx = 84 + g.measureText(u.name).width + 18;
      g.font = `600 21px ${FONT}`; g.fillStyle = stale ? '#6b7088' : u.noteColor || WARN; g.fillText(u.note, nx, y0 + uh * 0.3 + 1);
    }
    g.textAlign = 'right'; g.font = `700 32px ${FONT}`; g.fillStyle = stale ? '#6b7088' : '#ffffff'; g.fillText(u.text, w - 34, y0 + uh * 0.3);
    // barra: percentual (CPU, memória, disco) ou segmentos (um por processo/contêiner/serviço, os ruins primeiro)
    const bx = 84, bw = w - 84 - 34, by = y0 + uh * 0.58, bh = 15;
    g.fillStyle = '#0b0d14'; g.beginPath(); g.roundRect(bx, by, bw, bh, 7); g.fill();
    if (u.fill != null) {
      if (u.fill > 0) { g.fillStyle = col; g.beginPath(); g.roundRect(bx, by, Math.max(10, bw * u.fill), bh, 7); g.fill(); }
    } else {
      const n = Math.min(u.total || 0, 24);
      if (n > 0) {
        const gap = 3, sw = (bw - gap * (n - 1)) / n;
        for (let k = 0; k < n; k++) {
          g.fillStyle = stale ? '#4a4f66' : k < (u.bad || 0) ? CRIT : k < (u.bad || 0) + (u.warn || 0) ? WARN : '#2f8a5f';
          g.fillRect(bx + k * (sw + gap), by, sw, bh);
        }
      }
    }
  });
}

function drawPlate(g, w, h, host, status) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(15,17,26,.82)'; g.beginPath(); g.roundRect(0, 0, w, h, 38); g.fill();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 68px ${FONT}`; g.fillStyle = '#fff'; g.fillText(host.toUpperCase().slice(0, 16), w / 2, h * 0.4);
  g.font = `700 44px ${FONT}`; g.fillStyle = STATUS_COLOR[status]; g.fillText(STATUS_LABEL[status], w / 2, h * 0.76);
}

function drawBoard(g, w, h, counts, total) {
  g.fillStyle = '#0f1828'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffffff14'; g.fillRect(0, 70, w, 2);
  g.textBaseline = 'middle'; g.textAlign = 'left';
  g.font = `700 34px ${FONT}`; g.fillStyle = '#9fb0d8'; g.fillText('SERVIDORES', 28, 36);
  g.textAlign = 'right'; g.font = `700 44px ${FONT}`; g.fillStyle = '#fff'; g.fillText(`${total} ${total === 1 ? 'host' : 'hosts'}`, w - 28, 36);
  ORDER.forEach((st, i) => {
    const y = 120 + i * 64;
    g.fillStyle = STATUS_COLOR[st]; g.beginPath(); g.arc(46, y, 15, 0, 7); g.fill();
    g.textAlign = 'left'; g.font = `700 34px ${FONT}`; g.fillStyle = '#c3d0ea'; g.fillText(STATUS_LABEL[st], 82, y + 2);
    g.textAlign = 'right'; g.font = `700 52px ${FONT}`; g.fillStyle = '#fff'; g.fillText(String(counts[i] || 0), w - 34, y + 2);
  });
}

function floorTex(U, w, d) {
  const t = U.canvasTex(512, 512, (g, cw, ch) => {
    const n = 4, sz = cw / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? '#222844' : '#1a2036'; g.fillRect(x * sz, y * sz, sz, sz);
      if ((x + y) % 4 === 0) { // placa perfurada (corredor frio)
        g.fillStyle = '#0a0c12';
        for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) { g.beginPath(); g.arc(x * sz + (i + 0.5) * sz / 6, y * sz + (j + 0.5) * sz / 6, 3.2, 0, 7); g.fill(); }
      }
    }
    g.fillStyle = '#3d4d80';
    for (let i = 0; i <= n; i++) { g.fillRect(i * sz - 1.5, 0, 3, ch); g.fillRect(0, i * sz - 1.5, cw, 3); }
  }, { repeat: true, aniso: U.aniso });
  t.repeat.set(w / 4, d / 4);
  return t;
}

// ---------- um rack ----------
function makeRack(U, parent, cx, cz, rack, idx, ctx) {
  const g = new THREE.Group(); g.position.set(cx, 0, cz); parent.add(g);
  // casca, trilhos, unidades e discos das ventoinhas viram uma malha só (cor por vértice): uma chamada de desenho em vez de ~30
  const S = new Builder(), by = BASE + IH / 2;
  S.box(RW + 0.14, BASE, RD + 0.14, '#0b0d14', { y: BASE / 2 }, 0.02); // base
  for (const sg of [-1, 1]) {
    S.box(0.08, IH, RD, '#303752', { x: sg * (RW / 2 - 0.04), y: by }, 0.02); // laterais
    S.box(0.12, IH, 0.08, '#454e70', { x: sg * (RW / 2 - 0.1), y: by, z: RD / 2 - 0.06 }, 0.02); // trilhos da frente
    S.cyl(0.42, 0.42, 0.024, '#0e1019', { x: sg * 0.62, y: TOPY + 0.012, z: -0.12 }, 20); // disco da ventoinha
  }
  S.box(RW, 0.1, RD, '#303752', { y: BASE + IH + 0.05 }, 0.02); // tampo
  S.box(RW - 0.1, IH, 0.06, '#0a0c12', { y: by, z: -RD / 2 + 0.05 }, 0.02); // fundo
  S.box(RW - 0.3, IH - 0.05, 0.04, '#07080d', { y: by, z: ZF - 1.1 }, 0.01); // interior escuro atrás das unidades
  // seis unidades de servidor: corpo em relevo + a textura com os textos por cima
  const unitY = (u) => BASE + 0.05 + PH - (u + 0.5) * UH;
  for (let u = 0; u < 6; u++) {
    S.box(PW, UH - 0.05, 1.05, '#343b58', { y: unitY(u), z: ZF - 0.525 }, 0.03);
    S.box(0.34, 0.035, 0.05, '#3a405a', { x: PW / 2 - 0.3, y: unitY(u) - UH * 0.31, z: ZF + 0.02 }, 0.01); // puxador
  }
  const shell = new THREE.Mesh(S.build(), shellMaterial()); shell.castShadow = true; g.add(shell);
  const front = U.canvasTex(CW, CH, () => {}, { aniso: U.aniso });
  const overlay = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), basic('#ffffff', { map: front, transparent: true, depthWrite: false }));
  overlay.position.set(0, BASE + 0.05 + PH / 2, ZF + 0.012); overlay.renderOrder = 2; g.add(overlay);
  const gloss = U.glossPlane(PW, PH); gloss.position.set(0, BASE + 0.05 + PH / 2, ZF + 0.02); g.add(gloss);

  // LEDs: núcleo + brilho aditivo (a cor e o piscar mudam por quadro)
  const leds = [];
  for (let u = 0; u < 6; u++) {
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), basic('#1c1f2b'));
    core.position.set(-PW / 2 + (48 / CW) * PW, unitY(u) + UH * 0.0, ZF + 0.03); g.add(core);
    const glow = glowSprite(U, '#ffffff', 0.26, 0); glow.position.copy(core.position); glow.position.z += 0.02;
    if (!U.mobile) g.add(glow); // celular: sem o brilho dos LEDs (uma chamada de desenho a menos por LED)
    leds.push({ core, glow, key: '' });
  }

  // faixa de status no pé do rack e farol no topo
  const strip = new THREE.Mesh(new THREE.BoxGeometry(RW - 0.3, 0.05, 0.05), basic(IDLE)); strip.position.set(0, 0.06, RD / 2 + 0.085); g.add(strip);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), basic(IDLE)); beacon.position.set(0, TOPY, 0.1); g.add(beacon);
  const beaconGlow = glowSprite(U, '#ffffff', 1.1, 0); beaconGlow.position.set(0, TOPY + 0.14, 0.1); g.add(beaconGlow);

  // ventoinhas no tampo (giram mais rápido com a CPU)
  const fans = [];
  for (const sg of [-1, 1]) {
    const FB = new Builder();
    for (let b = 0; b < 5; b++) {
      const a = (b / 5) * Math.PI * 2;
      FB.add(new THREE.BoxGeometry(0.34, 0.012, 0.1), '#3a4263', { x: Math.cos(a) * 0.19, z: Math.sin(a) * 0.19, ry: -a + 0.35 });
    }
    FB.cyl(0.07, 0.07, 0.03, '#1b1f2e', { y: 0.004 }, 12);
    const blades = new THREE.Mesh(FB.build(), shellMaterial()); blades.position.set(sg * 0.62, TOPY + 0.028, -0.12); g.add(blades);
    fans.push(blades);
  }

  // cabos do tampo até a bandeja do teto
  const cableColors = ['#4f8cff', '#f2a93b', '#9aa0b4'];
  if (rack.row === 0) [-0.8, -0.1, 0.8].forEach((x, k) => { // só a fileira da frente da bandeja liga por cabos
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, TOPY, -0.55), new THREE.Vector3(x + 0.05, TOPY + 0.14, -0.62), new THREE.Vector3(x, 3.0, -0.7), new THREE.Vector3(x, 3.1, ctx.trayZ - cz),
    ]);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 14, 0.03, 6, false), U.mat(cableColors[(k + idx) % 3])); tube.castShadow = true; g.add(tube);
    ctx.wallItems.push(tube);
  });

  // brilho no chão em frente ao rack e a placa com o nome
  const floorGlow = new THREE.Mesh(new THREE.PlaneGeometry(RW + 0.8, 2.1), new THREE.MeshBasicMaterial({ color: IDLE, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  floorGlow.rotation.x = -Math.PI / 2; floorGlow.position.set(0, 0.02, RD / 2 + 1.0); g.add(floorGlow);
  const plateTex = U.canvasTex(640, 210, () => {});
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.79), new THREE.MeshBasicMaterial({ map: plateTex, transparent: true, depthWrite: false }));
  plate.rotation.x = -Math.PI / 2; plate.position.set(0, 0.035, RD / 2 + 0.95); plate.renderOrder = 1; g.add(plate); ctx.flat.push(plate);

  // contorno de seleção e área de clique
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(RW + 0.2, TOPY + 0.12, RD + 0.2)), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95 }));
  outline.position.y = (TOPY + 0.12) / 2; outline.visible = false; g.add(outline);
  const hit = new THREE.Mesh(new THREE.BoxGeometry(RW + 0.3, TOPY + 0.3, RD + 1.9), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.set(0, (TOPY + 0.3) / 2, 0.95 - 0.0); hit.userData = { kind: 'rack', host: rack.host }; g.add(hit); ctx.hitList.push(hit);

  return { host: rack.host, idx, g, leds, strip, beacon, beaconGlow, fans, floorGlow, outline, front, plateTex, key: '', plateKey: '', spin: [Math.random() * 6, Math.random() * 6], cur: { strip: '', beacon: '' } };
}

// rack vazio (sem monitor configurado, sem dados ou sem permissão): contorno tracejado e a mensagem no chão
function makeGhost(U, parent, cx, cz, msg, ctx) {
  const g = new THREE.Group(); g.position.set(cx, 0, cz); parent.add(g);
  const body = new THREE.Mesh(new THREE.BoxGeometry(RW, TOPY, RD), new THREE.MeshBasicMaterial({ color: '#4f8cff', transparent: true, opacity: 0.07, depthWrite: false }));
  body.position.y = TOPY / 2; g.add(body);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(RW, TOPY, RD)), new THREE.LineDashedMaterial({ color: '#ffffff', dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.6 }));
  edges.computeLineDistances(); edges.position.y = TOPY / 2; g.add(edges);
  const tex = U.canvasTex(768, 256, (c, w, h) => {
    c.fillStyle = 'rgba(15,17,26,.8)'; c.beginPath(); c.roundRect(0, 0, w, h, 40); c.fill();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `700 62px ${FONT}`; c.fillStyle = '#fff'; c.fillText(msg, w / 2, h * 0.38);
    c.font = `600 38px ${FONT}`; c.fillStyle = '#ffffffaa'; c.fillText('clique para configurar o monitor', w / 2, h * 0.72);
  });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.13), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  plate.rotation.x = -Math.PI / 2; plate.position.set(0, 0.035, RD / 2 + 1.0); plate.renderOrder = 1; g.add(plate); ctx.flat.push(plate);
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(RW + 0.2, TOPY + 0.12, RD + 0.2)), new THREE.LineBasicMaterial({ color: '#ffffff' }));
  outline.position.y = (TOPY + 0.12) / 2; outline.visible = false; g.add(outline);
  const hit = new THREE.Mesh(new THREE.BoxGeometry(RW + 0.4, TOPY + 0.3, RD + 2.2), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.set(0, (TOPY + 0.3) / 2, 0.8); hit.userData = { kind: 'rack', host: null }; g.add(hit); ctx.hitList.push(hit);
  return { outline };
}

// ---------- sala ----------
export function buildServerRoom(U, s, g, { hitList, flat }) {
  const { box, add } = U;
  const { W, H: Hh } = s, zMin = U.WALL_H, zMax = Hh - 1, wTiles = W - 2, depth = zMax - zMin;
  const sv = s.server, wallItems = [];
  const trayZ = zMin + 0.38;

  // piso elevado com placas perfuradas
  const floor = add(g, new THREE.PlaneGeometry(wTiles, depth), new THREE.MeshStandardMaterial({ map: floorTex(U, wTiles, depth), roughness: 0.38, metalness: 0.18 }), W / 2, 0, (zMin + zMax) / 2, { cast: false });
  floor.rotation.x = -Math.PI / 2;

  // paredes (mais escuras que as do escritório)
  const wm = new THREE.MeshStandardMaterial({ map: U.wallTexture(s.wallColors[0], s.wallColors[1]), color: '#b4bddc', roughness: 0.95, side: THREE.FrontSide });
  add(g, new THREE.PlaneGeometry(wTiles, U.WALL_UP), wm, W / 2, U.WALL_UP / 2, zMin, { cast: false });
  const lw = add(g, new THREE.PlaneGeometry(depth, U.WALL_UP), wm, 1, U.WALL_UP / 2, (zMin + zMax) / 2, { cast: false }); lw.rotation.y = Math.PI / 2;
  const rw = add(g, new THREE.PlaneGeometry(depth, U.WALL_UP), wm, W - 1, U.WALL_UP / 2, (zMin + zMax) / 2, { cast: false }); rw.rotation.y = -Math.PI / 2;
  const fw = add(g, new THREE.PlaneGeometry(wTiles, 0.9), U.mat(s.wallColors[1], { side: THREE.FrontSide }), W / 2, 0.45, zMax, { cast: false }); fw.rotation.y = Math.PI;
  wallItems.push(box(g, wTiles, 0.08, 0.1, s.wallColors[1], W / 2, U.WALL_UP, zMin + 0.05));

  // bandeja de cabos no teto e faixa de luz na parede do fundo
  wallItems.push(box(g, wTiles - 0.2, 0.08, 0.5, '#2a2f45', W / 2, 3.12, trayZ));
  for (const dz of [-0.25, 0.25]) wallItems.push(box(g, wTiles - 0.2, 0.14, 0.04, '#3a405a', W / 2, 3.17, trayZ + dz));
  const light = new THREE.Mesh(new THREE.BoxGeometry(wTiles - 1.5, 0.05, 0.05), basic('#8fd3ff')); light.position.set(W / 2, 3.3, zMin + 0.08); g.add(light); wallItems.push(light);

  // faixa de segurança no chão, em frente aos racks
  const hz = U.canvasTex(256, 32, (c, w, h) => {
    c.fillStyle = '#f2a93b'; c.fillRect(0, 0, w, h); c.fillStyle = '#14161f';
    for (let x = -h; x < w + h; x += 48) { c.beginPath(); c.moveTo(x, h); c.lineTo(x + 24, h); c.lineTo(x + 24 + h, 0); c.lineTo(x + h, 0); c.fill(); }
  }, { repeat: true, aniso: U.aniso });
  hz.repeat.set((wTiles - 1.2) / 0.9, 1);
  const line = new THREE.Mesh(new THREE.PlaneGeometry(wTiles - 1.2, 0.1), new THREE.MeshBasicMaterial({ map: hz, transparent: true, opacity: 0.75, depthWrite: false }));
  line.rotation.x = -Math.PI / 2; line.position.set(W / 2, 0.025, zMin + 0.95 + RD / 2 + 2.45); g.add(line);

  // racks
  const gap = sv.rowGap || 5.2, rcz = (row) => zMin + 0.95 + row * gap, ctx = { hitList, flat, wallItems, trayZ };
  const racks = [], ghost = sv.racks.length ? null : makeGhost(U, g, sv.rackX0 + 1.5, rcz(0), sv.msg, ctx);
  sv.racks.forEach((rk, i) => racks.push(makeRack(U, g, sv.rackX0 + rk.col * 4 + 1.5, rcz(rk.row), rk, i, ctx)));
  const nrows = Math.max(1, ...sv.racks.map((r) => r.row + 1));
  for (let r = 1; r < nrows; r++) { // faixa de segurança também entre as fileiras de trás
    const ln = line.clone(); ln.position.z = rcz(r) + RD / 2 + 2.45; g.add(ln);
  }

  // quadro de status na parede esquerda
  const zc = (zMin + zMax) / 2 + 1;
  box(g, 0.1, 1.45, 3.0, '#10131d', 1.07, 2.05, zc);
  const boardTex = U.canvasTex(512, 300, () => {});
  const board = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.64), basic('#ffffff', { map: boardTex }));
  board.rotation.y = Math.PI / 2; board.position.set(1.13, 2.05, zc); g.add(board);
  const bgl = U.glossPlane(2.8, 1.64); bgl.rotation.y = Math.PI / 2; bgl.position.set(1.14, 2.05, zc); g.add(bgl);

  // ar-condicionado na parede direita
  const az = zMin + 5.2;
  box(g, 1.1, 2.4, 1.7, '#2b3042', W - 1.6, 1.2, az);
  const grille = U.canvasTex(256, 384, (c, w, h) => {
    c.fillStyle = '#1b2030'; c.fillRect(0, 0, w, h); c.fillStyle = '#0c0e15';
    for (let y = 24; y < h - 24; y += 22) c.fillRect(24, y, w - 48, 8);
    c.fillStyle = OKC; c.beginPath(); c.arc(w - 36, 20, 7, 0, 7); c.fill();
  });
  const gp = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.2), new THREE.MeshStandardMaterial({ map: grille, roughness: 0.7 }));
  gp.rotation.y = -Math.PI / 2; gp.position.set(W - 1.6 - 0.56, 1.2, az); g.add(gp);

  // luzes frias sobre o corredor (as luzes quentes do escritório ficam desligadas nesta sala)
  for (const fx of [0.3, 0.7]) {
    const pl = new THREE.PointLight('#7ab8ff', 9, 14, 1.4); pl.position.set(W * fx, 2.7, zMin + 3.2); g.add(pl);
  }

  return { racks, ghost, board: { tex: boardTex, key: '' }, wallItems, zMin, zMax };
}

// atualização por quadro: dados, LEDs, farol, ventoinhas e seleção
export function updateServerRoom(rt, s, now, dt) {
  const sv = s.server;
  const hover = sv.hover;
  if (rt.ghost) rt.ghost.outline.visible = hover === '';
  const counts = ORDER.map((st) => sv.racks.filter((r) => r.status === st).length);
  const bkey = counts.join() + '|' + sv.racks.length;
  if (bkey !== rt.board.key) { rt.board.key = bkey; redraw(rt.board.tex, (c, w, h) => drawBoard(c, w, h, counts, sv.racks.length)); }

  for (const r of rt.racks) {
    const d = sv.racks.find((x) => x.host === r.host);
    if (!d) continue;
    const stale = d.status === 'sem-sinal', crit = d.status === 'critico';
    const key = JSON.stringify([d.units, stale]);
    if (key !== r.key) { r.key = key; redraw(r.front, (c, w, h) => drawFront(c, w, h, d.units, stale)); }
    if (d.status !== r.plateKey) { r.plateKey = d.status; redraw(r.plateTex, (c, w, h) => drawPlate(c, w, h, r.host, d.status)); }
    const sc = STATUS_COLOR[d.status];

    // LEDs: piscam em ritmo próprio; em alarme piscam rápido; sem sinal ficam apagados
    r.leds.forEach((l, u) => {
      const color = d.units[u].color;
      const on = stale ? false : color === CRIT ? Math.floor(now / 250) % 2 === 0 : Math.floor(now / (700 + u * 130) + r.idx) % 5 !== 0;
      const k = (on ? color : 'off') + stale;
      if (k !== l.key) {
        l.key = k;
        l.core.material.color.set(on ? color : stale ? '#2a2d3d' : '#1c1f2b');
        l.glow.material.color.set(color); l.glow.material.opacity = on ? 0.85 : 0;
      }
    });
    if (sc !== r.cur.strip) { r.cur.strip = sc; r.beaconGlow.material.color.set(sc); r.floorGlow.material.color.set(sc); }
    // farol: pulsa rápido em alarme, devagar em atenção, fixo quando está tudo bem, apagado sem sinal
    const pulse = stale ? 0 : crit ? 0.5 + 0.5 * Math.sin(now / 110) : d.status === 'atencao' ? 0.75 + 0.25 * Math.sin(now / 480) : 0.85;
    r.beacon.material.color.set(stale ? '#2a2d3d' : sc).multiplyScalar(0.3 + 0.7 * pulse);
    r.beaconGlow.material.opacity = stale ? 0 : 0.2 + 0.7 * pulse;
    r.floorGlow.material.opacity = stale ? 0 : (crit ? 0.1 + 0.1 * pulse : 0.08);
    r.strip.material.color.set(stale ? '#33364a' : sc);
    const speed = stale ? 0 : 1.5 + (Math.min(100, d.cpu || 0) / 100) * 16;
    r.fans.forEach((f, i) => { r.spin[i] += dt * speed * (i ? -1 : 1); f.rotation.y = r.spin[i]; });
    r.outline.visible = hover === r.host;
  }
}

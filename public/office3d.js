// Escritório em 3D (Three.js). Só desenha: a lógica (posições, status, caminhos) continua no app.js, que manda um
// "retrato" da cena a cada quadro. 1 unidade 3D = 1 tile; o ponto (x, y) do mundo 2D vira (x / 16, altura, y / 16).
import * as THREE from './vendor/three.module.min.js';
import { buildCharacter, releaseCharacter, setCharQuality } from './char/character.js';
import { animateRig } from './char/animations.js';
import { buildServerRoom, updateServerRoom } from './server3d.js';

const T = 16;
const WALL_H = 3; // tiles de parede no topo do mapa 2D (a parede 3D começa em z = 3)
const WALL_UP = 3.4; // altura da parede em unidades
const DESK_Y = 0.7; // altura do tampo da mesa
const SEAT_Y = 0.27; // altura do assento
const HIP_STAND = 0.52, HIP_SIT = 0.34;

const FACE = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const rotFor = (f) => { const [dx, dz] = FACE[f] || FACE.down; return Math.atan2(dx, dz); };
const lerpAngle = (a, b, k) => { let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * k; };

// ---------- texturas desenhadas em canvas ----------
function canvasTex(w, h, draw, { repeat = false, aniso = 4 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const rnd = (seed) => { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); };

function floorTexture(kind, colors, aniso) {
  const [fa, fb, fline] = colors;
  return canvasTex(512, 512, (g, w, h) => {
    const r = rnd(7), n = 4, s = w / n;
    if (kind !== 'madeira') {
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        g.fillStyle = (x + y) % 2 ? fa : fb;
        g.fillRect(x * s, y * s, s, s);
      }
    }
    if (kind === 'madeira') {
      // tábuas contínuas: 2 por tile (largura de meio tile), emendas deslocadas e veios; cada tábua com um tom
      g.fillStyle = fa; g.fillRect(0, 0, w, h);
      const rows = n * 2, bh = h / rows;
      for (let y = 0; y < rows; y++) {
        let x0 = -(r() * w * 0.5);
        while (x0 < w) {
          const len = w * (0.4 + r() * 0.4);
          g.fillStyle = r() > 0.5 ? fb : fa; g.fillRect(x0, y * bh, len, bh);
          g.fillStyle = `rgba(${r() > 0.5 ? '0,0,0' : '255,255,255'},${0.02 + r() * 0.06})`; g.fillRect(x0, y * bh, len, bh);
          for (let i = 0; i < 5; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.07})`; g.fillRect(x0 + r() * len, y * bh + r() * bh, 20 + r() * 80, 1); }
          g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x0, y * bh, 2, bh);
          x0 += len;
        }
        g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(0, y * bh, w, 2);
      }
    } else if (kind === 'piso' || kind === 'escuro') {
      g.fillStyle = fline || '#00000030';
      for (let i = 0; i <= n; i++) { g.fillRect(i * s - 1, 0, 2, h); g.fillRect(0, i * s - 1, w, 2); }
      for (let i = 0; i < 500; i++) { g.fillStyle = `rgba(255,255,255,${r() * 0.04})`; g.fillRect(r() * w, r() * h, 2, 2); }
    } else {
      for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '0,0,0'},${r() * 0.07})`; g.fillRect(r() * w, r() * h, 2, 2); }
    }
  }, { repeat: true, aniso });
}

function wallTexture(main, trim) {
  return canvasTex(64, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, main); gr.addColorStop(1, main);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    const sh = g.createLinearGradient(0, 0, 0, h);
    sh.addColorStop(0, 'rgba(255,255,255,.14)'); sh.addColorStop(0.6, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.12)');
    g.fillStyle = sh; g.fillRect(0, 0, w, h);
    g.fillStyle = trim; g.fillRect(0, h * 0.86, w, h * 0.14); // rodapé alto
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(0, h * 0.86, w, 3);
  });
}

function textPlane(text, { w = 512, h = 96, px = 52, color = '#fff', weight = 700, bg = null } = {}) {
  return canvasTex(w, h, (g) => {
    if (bg) { g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, w, h, h / 2); g.fill(); }
    g.font = `${weight} ${px}px Inter, system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 6;
    g.fillStyle = color; g.fillText(text, w / 2, h / 2 + 2);
  });
}

// mancha de luz macia (textura radial branca): vira poça de luz no chão com cor e opacidade
let radialTexture = null;
const radialTex = () => (radialTexture ??= canvasTex(128, 128, (g, w, h) => {
  const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}));
const WARM_WHITE = new THREE.Color('#fff0d6'), STRIP_OFF = new THREE.Color('#3a3f52'), STRIP_ON = new THREE.Color('#fff1c4');

// ---------- utilidades de malha ----------
const matCache = new Map();
function mat(color, o = {}) {
  const key = color + JSON.stringify(o);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.02, ...o }));
  return matCache.get(key);
}
function add(parent, geo, material, x = 0, y = 0, z = 0, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = cast; m.receiveShadow = receive;
  parent.add(m);
  return m;
}
// caixa com as quinas arredondadas (um retângulo extrudado com chanfro): pega a luz nas bordas, como móvel de verdade.
// Peças finas demais (tapetes, ponteiros) continuam retas. As geometrias são reaproveitadas entre peças iguais.
const rbCache = new Map();
function roundedBoxGeo(w, h, d, r) {
  const key = [w, h, d, r].join(',');
  if (rbCache.has(key)) return rbCache.get(key);
  const iw = w - 2 * r, ih = h - 2 * r, id = d - 2 * r;
  const sh = new THREE.Shape();
  sh.moveTo(-iw / 2, -ih / 2); sh.lineTo(iw / 2, -ih / 2); sh.lineTo(iw / 2, ih / 2); sh.lineTo(-iw / 2, ih / 2); sh.closePath();
  const geo = new THREE.ExtrudeGeometry(sh, { depth: id, bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: 2, curveSegments: 1 });
  geo.translate(0, 0, -id / 2);
  rbCache.set(key, geo);
  return geo;
}
const box = (p, w, h, d, c, x, y, z, o) => {
  const m = Math.min(w, h, d);
  const geo = m >= 0.06 ? roundedBoxGeo(w, h, d, Math.min(0.03, m * 0.3)) : new THREE.BoxGeometry(w, h, d);
  return add(p, geo, typeof c === 'string' ? mat(c) : c, x, y, z, o);
};

// reflexo diagonal por cima de telas e vidros
let glossTexture = null;
function glossPlane(w, h) {
  glossTexture ??= canvasTex(128, 128, (g, cw, ch) => {
    const gr = g.createLinearGradient(0, 0, cw, ch);
    gr.addColorStop(0, 'rgba(255,255,255,.30)'); gr.addColorStop(0.42, 'rgba(255,255,255,.07)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, cw, ch);
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: glossTexture, transparent: true, depthWrite: false, toneMapped: false }));
}
const cyl = (p, r1, r2, h, c, x, y, z, seg = 20) => add(p, new THREE.CylinderGeometry(r1, r2, h, seg), typeof c === 'string' ? mat(c) : c, x, y, z);
const sph = (p, r, c, x, y, z, seg = 16) => add(p, new THREE.SphereGeometry(r, seg, seg - 4), typeof c === 'string' ? mat(c) : c, x, y, z);
const caps = (p, r, len, c, x, y, z) => add(p, new THREE.CapsuleGeometry(r, len, 6, 12), typeof c === 'string' ? mat(c) : c, x, y, z);

// ---------- móveis ----------
function makeChair(color = '#3a3f55') {
  const g = new THREE.Group(); // costas do lado +z
  const m = mat(color);
  cyl(g, 0.05, 0.05, SEAT_Y - 0.06, '#1c1c24', 0, (SEAT_Y - 0.06) / 2, 0, 10);
  cyl(g, 0.3, 0.3, 0.03, '#1c1c24', 0, 0.03, 0, 5);
  add(g, new THREE.CylinderGeometry(0.34, 0.34, 0.07, 24), m, 0, SEAT_Y - 0.035, 0);
  box(g, 0.6, 0.56, 0.07, color, 0, SEAT_Y + 0.3, 0.3);
  return g;
}

function makePlant() {
  const g = new THREE.Group();
  cyl(g, 0.3, 0.22, 0.4, '#b5643c', 0, 0.2, 0);
  cyl(g, 0.33, 0.33, 0.06, '#8e4a2c', 0, 0.42, 0);
  const leaves = new THREE.Group(); leaves.position.y = 0.42; g.add(leaves);
  for (const [x, y, z, r] of [[0, 0.5, 0, 0.32], [-0.2, 0.32, 0.05, 0.25], [0.2, 0.36, -0.05, 0.26], [0.02, 0.82, 0, 0.2], [0.05, 0.25, 0.2, 0.2]]) sph(leaves, r, '#3f9b54', x, y, z);
  g.userData.sway = leaves;
  return g;
}

function makeSofa() {
  const g = new THREE.Group();
  const w = 5, red = '#c0392b', dark = '#a5311f';
  box(g, w, 0.4, 1.6, dark, 0, 0.22, 0);
  box(g, w - 0.7, 0.2, 1.2, red, 0, 0.52, 0.12);
  box(g, w, 0.9, 0.42, dark, 0, 0.7, -0.62);
  box(g, 0.4, 0.62, 1.6, dark, -w / 2 + 0.2, 0.46, 0);
  box(g, 0.4, 0.62, 1.6, dark, w / 2 - 0.2, 0.46, 0);
  for (const x of [-1.6, 0, 1.6]) box(g, 1.4, 0.55, 0.22, red, x, 0.72, -0.4);
  return g;
}

function makeBookcase() {
  const g = new THREE.Group();
  box(g, 2, 1.8, 0.6, '#6b4429', 0, 0.9, 0);
  box(g, 1.84, 1.64, 0.5, '#7a5538', 0, 0.9, 0.06);
  const cores = ['#e5534b', '#4f8cff', '#f2a93b', '#3fbf7f', '#b072f5'];
  for (let s = 0; s < 4; s++) {
    box(g, 1.84, 0.05, 0.52, '#6b4429', 0, 0.2 + s * 0.42, 0.06);
    for (let i = 0; i < 9; i++) box(g, 0.14, 0.28 + (i % 3) * 0.04, 0.34, cores[(i + s) % 5], -0.78 + i * 0.19, 0.38 + s * 0.42, 0.1);
  }
  return g;
}

function makeArcade() {
  const g = new THREE.Group();
  box(g, 1, 1.8, 0.9, '#2b2f6e', 0, 0.9, 0);
  box(g, 1, 0.2, 0.9, '#e5534b', 0, 1.75, 0);
  const scr = box(g, 0.7, 0.5, 0.04, new THREE.MeshStandardMaterial({ color: '#111', emissive: '#000', roughness: 0.3 }), 0, 1.2, 0.46);
  box(g, 0.8, 0.12, 0.35, '#1c1c24', 0, 0.78, 0.55);
  g.userData.screen = scr;
  return g;
}

function makeFrameTexture() {
  return canvasTex(256, 160, (g, w, h) => {
    g.fillStyle = '#e8d9a8'; g.fillRect(0, 0, w, h);
    const sk = g.createLinearGradient(0, 0, 0, h * 0.6); sk.addColorStop(0, '#9ed0f5'); sk.addColorStop(1, '#f7e2b0');
    g.fillStyle = sk; g.fillRect(0, 0, w, h * 0.65);
    g.fillStyle = '#f2a93b'; g.beginPath(); g.arc(w * 0.7, h * 0.4, 20, 0, 7); g.fill();
    g.fillStyle = '#4f8f5a'; g.beginPath(); g.moveTo(0, h * 0.7); g.quadraticCurveTo(w * 0.35, h * 0.4, w * 0.7, h * 0.72); g.lineTo(w, h * 0.66); g.lineTo(w, h); g.lineTo(0, h); g.fill();
    g.fillStyle = '#3f7a4a'; g.fillRect(0, h * 0.8, w, h * 0.2);
  });
}

// ---------- personagem ----------
// ---------- personagens: estilo "desenho animado" ----------
// Material toon (luz em 3 degraus) + contorno escuro por "casco invertido" (a malha de novo, um pouco maior, só com as costas
// visíveis). Técnica clássica de cel shading; referência: MeshToonMaterial e OutlineEffect do próprio Three.js.
let toonGrad = null;
const toonCache = new Map();
const OUTLINE = new THREE.MeshBasicMaterial({ color: '#1b1424', side: THREE.BackSide });
function toon(color, o = {}) {
  toonGrad ??= (() => {
    const t = new THREE.DataTexture(new Uint8Array([110, 190, 255]), 3, 1, THREE.RedFormat);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true;
    return t;
  })();
  const key = color + JSON.stringify(o);
  if (!toonCache.has(key)) { const m = new THREE.MeshToonMaterial({ color, gradientMap: toonGrad, ...o }); m.userData.shared = true; toonCache.set(key, m); }
  return toonCache.get(key);
}
function shade(hex, k) { // clareia (k > 0) ou escurece (k < 0) uma cor
  const c = new THREE.Color(hex);
  return '#' + (k > 0 ? c.lerp(new THREE.Color('#fff'), k) : c.multiplyScalar(1 + k)).getHexString();
}
const hash = (id, m) => [...String(id)].reduce((h, c) => (h * m + c.charCodeAt(0)) % 9973, 7);

function buildAgentClassic(a) {
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  const outlined = new Set();
  const tm = (c, o) => { const m = toon(c, o); outlined.add(m); return m; };
  const skinC = a.skin || '#f1c7a0', shirtC = a.shirt || '#4f8cff', hairC = a.hair || '#3b2416';
  const skin = tm(skinC), shirt = tm(shirtC), hair = tm(hairC), pants = tm('#2f3550'), shoe = tm('#f4f1ea'), sole = tm('#2a2f3e');
  const outfit = hash(a.id, 31) % 3; // 0 camiseta, 1 moletom com capuz, 2 colete por cima de camisa

  // tronco arredondado, um pouco mais largo nos ombros
  const torso = caps(body, 0.17, 0.2, shirt, 0, 0.3, 0); torso.scale.set(1.08, 1, 0.92);
  const hips = sph(body, 0.17, pants, 0, 0.1, 0, 14); hips.scale.set(1.05, 0.62, 0.9);
  const belt = cyl(body, 0.178, 0.178, 0.03, '#1c1c24', 0, 0.135, 0, 20); belt.castShadow = false;
  const neck = cyl(body, 0.065, 0.075, 0.09, skin, 0, 0.62, 0, 10); neck.castShadow = false;
  if (outfit === 1) { // moletom: capuz nas costas e bolso na frente
    const hood = add(body, new THREE.TorusGeometry(0.1, 0.045, 8, 16, Math.PI * 1.5), shirt, 0, 0.6, -0.05, { cast: false }); hood.rotation.x = Math.PI / 2 - 0.5; hood.rotation.z = Math.PI * 0.75;
    box(body, 0.22, 0.09, 0.05, shade(shirtC, -0.16), 0, 0.22, 0.17, { cast: false });
  } else if (outfit === 2) { // colete: gola branca e frente escura
    box(body, 0.2, 0.34, 0.05, shade(shirtC, -0.3), 0, 0.33, 0.158, { cast: false });
    const col = add(body, new THREE.TorusGeometry(0.09, 0.026, 8, 18), tm('#f4f1ea'), 0, 0.585, 0.01, { cast: false }); col.rotation.x = Math.PI / 2;
  } else {
    const col = add(body, new THREE.TorusGeometry(0.09, 0.028, 8, 18), shirt, 0, 0.585, 0, { cast: false }); col.rotation.x = Math.PI / 2;
  }

  // cabeça grande (proporção chibi): o grupo é ampliado, então olhos, cabelo e acessórios acompanham
  const HEAD_S = 1.32, headY = 0.92;
  const head = new THREE.Group(); head.position.y = headY; head.scale.setScalar(HEAD_S); body.add(head);
  const skull = sph(head, 0.21, skin, 0, 0, 0, 28); skull.scale.set(1, 1.02, 0.98);
  const jaw = sph(head, 0.17, skin, 0, -0.07, 0.02, 20); jaw.scale.set(1.05, 0.8, 0.95); jaw.castShadow = false;
  const cap = (r, y = 0, z = 0, rx = -0.32, m = hair, th = Math.PI * 0.56) => {
    const mesh = add(head, new THREE.SphereGeometry(r, 28, 16, 0, Math.PI * 2, 0, th), m, 0, y, z);
    mesh.rotation.x = rx;
    return mesh;
  };
  const style = a.hairStyle || ['curto', 'longo', 'coque'][hash(a.id, 17) % 3];
  const hat = a.accessory === 'bone';
  // mecha: elipsoide alongado (mais orgânico que esfera ou cápsula); tx inclina para frente/trás, tz para os lados
  const lock = (x, y, z, rx, ry, rz, tx = 0, tz = 0) => { const l = sph(head, 1, hair, x, y, z, 12); l.scale.set(rx, ry, rz); l.rotation.set(tx, 0, tz); return l; };
  if (!hat) { // com boné o cabelo só aparece por baixo da aba: a calota e a franja atravessariam o boné
    cap(0.226);
    for (let i = 0; i < 7; i++) { // franja em mechas varridas para o lado, de comprimentos diferentes
      const t = i / 6 - 0.5, ph = t * 2.1;
      lock(Math.sin(ph) * 0.175, 0.165 - Math.abs(t) * 0.05, Math.cos(ph) * 0.15 + 0.03, 0.06, 0.06 + (i % 2) * 0.012, 0.05, 0.55, -ph * 0.6 + 0.3);
    }
  }
  for (const x of [-1, 1]) lock(x * 0.205, hat ? -0.07 : -0.02, -0.01, 0.045, 0.1, 0.07, 0, x * 0.06); // costeletas
  if (style === 'curto') {
    if (!hat) for (const [x, z, r] of [[-0.07, -0.02, 0.07], [0.04, 0.03, 0.075], [0.09, -0.05, 0.06], [-0.02, -0.11, 0.07]]) lock(x, 0.205, z, r, r * 0.8, r, 0, x * 2);
    lock(0, -0.075, -0.17, 0.15, 0.07, 0.07); // nuca
  }
  if (style === 'longo') {
    const hy = hat ? -0.16 : -0.07; // sobe até a calota; com boné começa abaixo da aba
    lock(0, hy, -0.15, hat ? 0.16 : 0.18, hat ? 0.13 : 0.2, 0.1);
    lock(0, hy - 0.14, -0.15, 0.15, 0.13, 0.08);
    for (const x of [-1, 1]) {
      lock(x * 0.075, hy - 0.26, -0.14, 0.065, 0.1, 0.05, 0, x * 0.1);
      lock(x * 0.205, hy - 0.03, -0.02, 0.055, 0.15, 0.075, 0, x * 0.05);
    }
  }
  if (style === 'coque') {
    if (hat) lock(0, -0.1, -0.17, 0.09, 0.09, 0.08);
    else {
      lock(0, 0.26, -0.09, 0.12, 0.1, 0.11);
      add(head, new THREE.TorusGeometry(0.1, 0.014, 6, 16), tm(shade(hairC, 0.25)), 0, 0.2, -0.09, { cast: false }).rotation.x = Math.PI / 2;
      lock(0, 0.03, -0.17, 0.15, 0.1, 0.07); // nuca presa
    }
  }

  // rosto: olhos grandes (branco, íris, pupila e brilho; piscam), sobrancelhas e boca por humor, bochechas
  const eyes = [];
  for (const x of [-0.088, 0.088]) {
    // olho achatado e embutido na curva do rosto (virado para fora conforme o lado), só o brilho aparece à frente
    const eye = new THREE.Group(); eye.position.set(x, -0.005, 0.172); eye.rotation.y = Math.sign(x) * 0.42; head.add(eye);
    const wh = sph(eye, 0.043, '#ffffff', 0, 0, 0, 16); wh.scale.set(0.92, 1.25, 0.3); wh.castShadow = false;
    const ir = sph(eye, 0.031, shade(hairC, 0.1), 0, -0.004, 0.006, 14); ir.scale.set(1, 1.15, 0.3); ir.castShadow = false;
    const pu = sph(eye, 0.018, '#120d18', 0, -0.004, 0.011, 10); pu.scale.z = 0.3; pu.castShadow = false;
    const hl = sph(eye, 0.01, '#ffffff', 0.01, 0.014, 0.017, 6); hl.scale.z = 0.4; hl.castShadow = false;
    const hl2 = sph(eye, 0.005, '#ffffff', -0.009, -0.013, 0.016, 6); hl2.scale.z = 0.4; hl2.castShadow = false;
    eyes.push(eye);
  }
  const browM = tm(shade(hairC, -0.25));
  const brows = [-1, 1].map((side) => box(head, 0.08, 0.018, 0.02, browM, side * 0.088, 0.085, 0.2, { cast: false }));
  const lip = '#b25a48';
  const mN = box(head, 0.06, 0.014, 0.02, lip, 0, -0.095, 0.2, { cast: false });
  const mS = add(head, new THREE.TorusGeometry(0.048, 0.012, 6, 14, Math.PI), mat(lip), 0, -0.06, 0.198, { cast: false }); mS.rotation.z = Math.PI; mS.visible = false;
  const mF = add(head, new THREE.TorusGeometry(0.036, 0.012, 6, 14, Math.PI), mat(lip), 0, -0.125, 0.198, { cast: false }); mF.visible = false;
  const nose = sph(head, 0.016, shade(skinC, -0.08), 0, -0.04, 0.208, 8); nose.castShadow = false;
  for (const x of [-0.135, 0.135]) { const ch = sph(head, 0.042, mat('#ff7f8a', { transparent: true, opacity: 0.35 }), x, -0.05, 0.168, 8); ch.scale.set(1, 0.6, 0.3); ch.castShadow = false; }
  for (const x of [-0.205, 0.205]) { const ear = sph(head, 0.042, skin, x, -0.01, 0.0, 10); ear.castShadow = false; }

  if (a.accessory === 'oculos') {
    for (const x of [-0.088, 0.088]) add(head, new THREE.TorusGeometry(0.066, 0.012, 8, 22), tm('#1a1a1a'), x, 0.0, 0.205, { cast: false });
    box(head, 0.05, 0.012, 0.012, '#1a1a1a', 0, 0.01, 0.21, { cast: false });
    for (const x of [-1, 1]) box(head, 0.012, 0.012, 0.2, '#1a1a1a', x * 0.158, 0.01, 0.11, { cast: false });
  } else if (a.accessory === 'fone') {
    add(head, new THREE.TorusGeometry(0.262, 0.02, 8, 24, Math.PI), tm('#2d3142'), 0, 0.0, 0);
    for (const x of [-0.262, 0.262]) { const c = cyl(head, 0.08, 0.08, 0.07, tm('#e5534b'), x, -0.01, 0, 16); c.rotation.z = Math.PI / 2; }
  } else if (a.accessory === 'bone') {
    cap(0.245, 0.02, 0, -0.18, tm('#e5534b'));
    const brim = box(head, 0.3, 0.025, 0.2, tm('#b33a33'), 0, 0.09, 0.24); brim.rotation.x = 0.1;
    const bt = sph(head, 0.022, '#fff', 0, 0.23, 0.0, 8); bt.castShadow = false;
  }

  // braços: manga com punho e mão arredondada (luva)
  const mkArm = (side) => {
    const sh = new THREE.Group(); sh.position.set(side * 0.235, 0.52, 0); body.add(sh);
    sph(sh, 0.075, shirt, 0, 0.0, 0, 12);
    caps(sh, 0.06, 0.13, shirt, 0, -0.11, 0);
    const el = new THREE.Group(); el.position.y = -0.22; sh.add(el);
    caps(el, 0.053, 0.11, shirt, 0, -0.095, 0);
    const cuff = cyl(el, 0.058, 0.058, 0.03, shade(shirtC, outfit === 1 ? -0.16 : 0.2), 0, -0.185, 0, 12); cuff.castShadow = false;
    const hand = sph(el, 0.066, skin, 0, -0.235, 0, 12); hand.scale.set(1, 0.92, 1);
    return { sh, el };
  };
  const L = mkArm(-1), R = mkArm(1);
  // pernas: calça, tênis branco com sola e biqueira
  const mkLeg = (side) => {
    const hp = new THREE.Group(); hp.position.set(side * 0.1, 0, 0); body.add(hp);
    caps(hp, 0.078, 0.12, pants, 0, -0.1, 0);
    const kn = new THREE.Group(); kn.position.y = -0.22; hp.add(kn);
    caps(kn, 0.07, 0.15, pants, 0, -0.14, 0);
    const sh = sph(kn, 0.1, shoe, 0, -0.285, 0.04, 14); sh.scale.set(0.95, 0.68, 1.55);
    box(kn, 0.17, 0.035, 0.3, sole, 0, -0.325, 0.045, { cast: false });
    return { hp, kn };
  };
  const LL = mkLeg(-1), RL = mkLeg(1);

  // contorno: uma cópia maior só com as costas visíveis, para cada peça de roupa, pele e cabelo
  root.traverse((m) => {
    if (!m.isMesh || !outlined.has(m.material)) return;
    const o = new THREE.Mesh(m.geometry, OUTLINE);
    o.scale.setScalar(1.075);
    o.userData.outline = true;
    m.add(o);
  });

  // área de clique
  const hit = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.9, 0.8), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 0.95; root.add(hit);
  hit.userData = { kind: 'agent', id: a.id };

  root.scale.setScalar(1.22);
  root.userData = { style: 'classico', body, head, headY, L, R, LL, RL, sitk: 0, moveK: 0, rot: 0, hit, eyes, brows, mN, mS, mF };
  return root;
}

const EMOJI_TEX = new Map();
function emojiSprite(e) {
  if (!EMOJI_TEX.has(e)) EMOJI_TEX.set(e, canvasTex(96, 96, (g) => { g.font = '64px "Segoe UI Emoji", "Apple Color Emoji", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(e, 48, 52); }));
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: EMOJI_TEX.get(e), transparent: true, depthTest: false }));
  s.scale.set(0.45, 0.45, 1); s.renderOrder = 10;
  return s;
}

// ---------- o módulo ----------
export function create3D({ canvas, wrap, onDrag }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const mobile = innerWidth <= 760;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0d0f16');
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);

  // luzes
  const hemi = new THREE.HemisphereLight('#cfe0ff', '#7b6650', 1.1);
  scene.add(hemi);
  const fill = new THREE.DirectionalLight('#a9bcff', 0.55); // luz de preenchimento sem sombra, do lado oposto ao sol: levanta o lado escuro das roupas e do rosto
  fill.position.set(-6, 5, -8);
  scene.add(fill);
  const sun = new THREE.DirectionalLight('#fff3dd', 2.6);
  sun.castShadow = true;
  const sm = mobile ? 1024 : 2048;
  sun.shadow.mapSize.set(sm, sm);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  sun.shadow.intensity = 0.7; // sombras menos pesadas: a mesa e o chão não escurecem tanto em volta dos personagens
  scene.add(sun, sun.target);
  const warm = [0, 1, 2].map(() => { const l = new THREE.PointLight('#ffb866', 0, 9, 1.6); scene.add(l); return l; });

  const staticGroup = new THREE.Group(); scene.add(staticGroup);
  const agentsGroup = new THREE.Group(); scene.add(agentsGroup);
  const hitList = []; // áreas de clique das mesas (as dos personagens ficam em cada personagem)
  // estilo dos personagens: 'novo' (procedural refinado, pasta char/) ou 'classico' (o anterior, como alternativa)
  let charStyle = 'novo';
  setCharQuality(mobile ? 0.6 : 1); // celular: menos segmentos e mechas por personagem
  function buildAgent(a) {
    if (charStyle === 'novo') { try { return buildCharacter(a); } catch (e) { console.warn('Personagem novo falhou, usando o clássico:', e); } }
    return buildAgentClassic(a);
  }
  // remove um personagem sem invalidar recursos compartilhados: os novos devolvem suas geometrias, o clássico é descartado
  function freeAgent(g) {
    const u = g.userData;
    if (u.name) g.remove(u.name); // a etiqueta tem cache próprio (agentSprites)
    if (u.cres) {
      releaseCharacter(g);
      u.hit.geometry.dispose(); u.hit.material.dispose();
      if (u.emoji) u.emoji.material.dispose();
      g.clear();
    } else disposeGroup(g);
  }
  const state = { srv: null, pools: [], strips: [], door: null, lk: undefined, key: '', room: null, desks: new Map(), agents: new Map(), plants: [], arcade: null, steam: null, lamp: null, clock: null, tv: null, glass: [], glassKey: '', lastNow: 0, lastFrame: 0 };

  // câmera orbital: azimute e elevação em torno do centro da sala
  const cam = { az: 0, azT: 0, el: 0.95, zoom: 1, cx: 0, cz: 0, bx: 0, bz: 0, R: 10, depth: 10, width: 20, dist: 20, zMin: 3, zMax: 20, W: 20, Lt: 15 };
  const camRange = { el: [0.45, 1.35], zoom: [0.45, 2.2] };
  function placeCamera() {
    cam.az += (cam.azT - cam.az) * 0.14; // gira suave até o ângulo pedido (botão Virar)
    const upside = Math.cos(cam.az) < 0; // visto de frente, os textos do chão giram junto para continuarem legíveis
    for (const o of state.backWall || []) o.visible = !upside;
    for (const f of state.flat || []) f.rotation.z = upside ? Math.PI : 0;
    // distância que enquadra a sala inteira (largura e profundidade) para a proporção atual da tela
    const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), th = tv * camera.aspect;
    const fitH = (cam.depth * Math.sin(cam.el) + WALL_UP * Math.cos(cam.el)) / (2 * tv);
    const fitW = cam.width / (2 * th);
    const R = (Math.max(fitH, fitW) * 1.04 + cam.depth * 0.3) * cam.zoom;
    cam.dist = R;
    camera.position.set(cam.cx + Math.sin(cam.az) * Math.cos(cam.el) * R, Math.sin(cam.el) * R, cam.cz + Math.cos(cam.az) * Math.cos(cam.el) * R);
    camera.lookAt(cam.cx, 0.4, cam.cz + 0.2);
  }
  const clamp = (v, [a, b]) => Math.max(a, Math.min(b, v));

  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(wrap);

  // controles: arrastar gira, roda ou pinça dá zoom
  const ptrs = new Map();
  let pinch = 0, moved = 0, prevMid = null;
  // desloca o centro da câmera (a cena acompanha o dedo ou o mouse)
  function pan(dx, dy) {
    const k = 0.00086 * cam.dist;
    const rx = Math.cos(cam.az), rz = -Math.sin(cam.az), fx = -Math.sin(cam.az), fz = -Math.cos(cam.az);
    const vy = k / Math.max(0.35, Math.sin(cam.el));
    cam.cx = Math.max(1, Math.min(cam.W - 1, cam.cx - dx * k * rx + dy * vy * fx));
    cam.cz = Math.max(cam.zMin, Math.min(cam.zMax, cam.cz - dx * k * rz + dy * vy * fz));
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, right: e.button === 2 || e.shiftKey }); moved = 0; pinch = 0; prevMid = null; });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (pinch) cam.zoom = clamp(cam.zoom * (pinch / d), camRange.zoom);
      if (prevMid) pan(mid.x - prevMid.x, mid.y - prevMid.y); // dois dedos: pinça aproxima e arrastar desloca
      pinch = d; prevMid = mid; moved = 99; onDrag?.();
      return;
    }
    moved += Math.abs(dx) + Math.abs(dy);
    if (moved > 6) {
      onDrag?.();
      if (p.right) pan(dx, dy); // botão direito ou Shift: desloca; botão esquerdo: gira
      else {
        cam.az -= dx * 0.006; cam.azT = cam.az; // gira livre, 360°
        cam.el = clamp(cam.el + dy * 0.006, camRange.el);
      }
    }
  });
  const up = (e) => { ptrs.delete(e.pointerId); pinch = 0; prevMid = null; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.zoom = clamp(cam.zoom * (e.deltaY > 0 ? 1.1 : 0.9), camRange.zoom); }, { passive: false });
  canvas.addEventListener('dblclick', () => resetCamera());
  // tela vertical (celular): a sala é larga demais, então começa aproximada, olhando as mesas do topo
  function resetCamera() {
    const portrait = camera.aspect < 0.9;
    cam.az = 0; cam.azT = 0; cam.el = portrait ? 0.9 : 0.95;
    cam.zoom = portrait ? 0.58 : 1;
    cam.cx = portrait ? (1 + cam.Lt) / 2 + 0.5 : cam.bx; // vertical: começa nas mesas (o lounge fica à direita, é só deslocar)
    cam.cz = portrait ? cam.zMin + cam.depth * 0.42 : cam.bz;
  }

  // ---------- construção da sala (só quando a estrutura muda) ----------
  function disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material; // materiais compartilhados (cache dos bonecos) nunca são descartados aqui
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => { if (x.userData.shared) return; x.map?.dispose?.(); x.dispose?.(); });
    });
    g.clear();
  }

  function build(s) {
    disposeGroup(staticGroup);
    hitList.length = 0;
    state.pools = []; state.strips = []; state.door = null;
    state.desks.clear(); state.flat = []; state.plants = []; state.glass = []; state.arcade = null; state.steam = null; state.clock = null; state.tv = null; state.glassKey = '';
    const g = staticGroup;
    state.srv = null;
    const { W, H, L } = s;
    const Wt = W, Ht = H, Lt = L / T, wTiles = W - 2, zMin = WALL_H, zMax = H - 1;
    cam.bx = W / 2; cam.bz = (zMin + zMax) / 2; cam.zMin = zMin; cam.zMax = zMax; cam.W = W; cam.Lt = Lt; cam.R = Math.hypot(W, zMax - zMin) * 0.5; cam.depth = zMax - zMin; cam.width = W - 2;

    if (s.server) { // sala de servidores: racks no lugar de mesas, áreas e janelas
      state.srv = buildServerRoom({ box, add, mat, canvasTex, glossPlane, wallTexture, aniso, WALL_H, WALL_UP, mobile }, s, g, { hitList, flat: state.flat });
      state.backWall = state.srv.wallItems;
      const rs = Math.hypot(W, zMax - zMin) * 0.55;
      Object.assign(sun.shadow.camera, { left: -rs, right: rs, top: rs, bottom: -rs, near: 1, far: rs * 6 });
      sun.shadow.camera.updateProjectionMatrix();
      sun.position.set(cam.bx - rs * 0.7, rs * 1.7, cam.bz + rs * 0.9);
      sun.target.position.set(cam.bx, 0, cam.bz);
      const sdims = W + 'x' + H + 'srv';
      if (state.dims !== sdims) { state.dims = sdims; resetCamera(); }
      return;
    }

    // piso
    const floorW = Lt - 1, loungeW = W - 1 - Lt;
    const ft = floorTexture(s.floor, s.floorColors, aniso); ft.repeat.set(floorW / 4, (zMax - zMin) / 4);
    const floor = add(g, new THREE.PlaneGeometry(floorW, zMax - zMin), new THREE.MeshStandardMaterial({ map: ft, roughness: s.floor === 'piso' ? 0.35 : 0.85 }), 1 + floorW / 2, 0, (zMin + zMax) / 2, { cast: false });
    floor.rotation.x = -Math.PI / 2;
    const lt = floorTexture('carpete', ['#3c3552', '#433b5c', null], aniso); lt.repeat.set(loungeW / 4, (zMax - zMin) / 4);
    const lounge = add(g, new THREE.PlaneGeometry(loungeW, zMax - zMin), new THREE.MeshStandardMaterial({ map: lt, roughness: 1 }), Lt + loungeW / 2, 0.001, (zMin + zMax) / 2, { cast: false });
    lounge.rotation.x = -Math.PI / 2;

    // paredes: só a face de dentro é desenhada, então a parede da frente some sozinha quando a câmera gira
    const wt = wallTexture(s.wallColors[0], s.wallColors[1]);
    const wm = new THREE.MeshStandardMaterial({ map: wt, roughness: 0.95, side: THREE.FrontSide });
    const back = add(g, new THREE.PlaneGeometry(wTiles, WALL_UP), wm, W / 2, WALL_UP / 2, zMin, { cast: false });
    const leftW = add(g, new THREE.PlaneGeometry(zMax - zMin, WALL_UP), wm, 1, WALL_UP / 2, (zMin + zMax) / 2, { cast: false });
    leftW.rotation.y = Math.PI / 2;
    const rightW = add(g, new THREE.PlaneGeometry(zMax - zMin, WALL_UP), wm, W - 1, WALL_UP / 2, (zMin + zMax) / 2, { cast: false });
    rightW.rotation.y = -Math.PI / 2;
    // parede da frente (baixa), com um vão para a porta por onde os agentes saem para casa e voltam
    const door = s.door ?? { x: (W - 2) * T };
    const dx = door.x / T, dw = 0.75; // centro e meia largura do vão
    const frontMat = mat(s.wallColors[1], { side: THREE.FrontSide });
    for (const [x0, x1] of [[1, dx - dw], [dx + dw, W - 1]]) {
      const seg = add(g, new THREE.PlaneGeometry(x1 - x0, 0.9), frontMat, (x0 + x1) / 2, 0.45, zMax, { cast: false });
      seg.rotation.y = Math.PI;
    }
    {
      const dg = new THREE.Group(); dg.position.set(dx, 0, zMax); g.add(dg);
      const frame = '#2b2f3e';
      box(dg, 0.14, 2.2, 0.24, frame, -dw - 0.07, 1.1, 0); box(dg, 0.14, 2.2, 0.24, frame, dw + 0.07, 1.1, 0);
      box(dg, dw * 2 + 0.28, 0.16, 0.24, frame, 0, 2.18, 0);
      box(dg, 0.78, 0.22, 0.08, '#10281d', 0, 2.5, 0); // placa de saída (acesa dos dois lados)
      for (const sz of [1, -1]) {
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.11), new THREE.MeshBasicMaterial({ color: '#4cff9a', toneMapped: false }));
        sign.position.set(0, 2.5, 0.045 * sz); if (sz < 0) sign.rotation.y = Math.PI; dg.add(sign);
      }
      const pivot = new THREE.Group(); pivot.position.set(-dw, 0, 0); dg.add(pivot); // dobradiça à esquerda; abre para dentro da sala
      box(pivot, dw * 2 - 0.02, 2.08, 0.07, '#7a5a3a', dw, 1.04, 0);
      box(pivot, dw * 2 - 0.2, 1.7, 0.02, '#8a6742', dw, 1.08, 0.04); box(pivot, dw * 2 - 0.2, 1.7, 0.02, '#8a6742', dw, 1.08, -0.04); // almofadas
      for (const sz of [1, -1]) sph(pivot, 0.05, '#e8c36a', dw * 2 - 0.16, 1.0, 0.07 * sz, 10);
      state.door = { pivot };
    }
    // moldura no alto da parede
    box(g, wTiles, 0.08, 0.1, s.wallColors[1], W / 2, WALL_UP, zMin + 0.05);

    // janelas
    for (let x = 2; x + 3 < Lt; x += 5) {
      const gm = new THREE.MeshBasicMaterial({ color: '#fff' });
      state.glass.push(gm);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.07, 0.07), new THREE.MeshBasicMaterial({ color: '#3a3f52', toneMapped: false })); // luminária acima da janela
      strip.position.set(x + 1.5, 3.12, zMin + 0.1); g.add(strip); state.strips.push(strip);
      box(g, 3.2, 1.8, 0.12, '#1d2030', x + 1.5, 2.05, zMin + 0.05, { cast: false });
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 1.55), gm); pane.position.set(x + 0.77, 2.05, zMin + 0.12); g.add(pane);
      const pane2 = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 1.55), gm); pane2.position.set(x + 2.23, 2.05, zMin + 0.12); g.add(pane2);
      for (const px of [x + 0.77, x + 2.23]) { const gl = glossPlane(1.45, 1.55); gl.position.set(px, 2.05, zMin + 0.125); g.add(gl); }
    }

    // relógio e TV na parede do lounge
    const clock = new THREE.Group(); clock.position.set(Lt + 3.5, 2.3, zMin + 0.1); g.add(clock);
    cyl(clock, 0.36, 0.36, 0.06, '#e8eaf2', 0, 0, 0.0).rotation.x = Math.PI / 2;
    const mh = box(clock, 0.03, 0.3, 0.02, '#222', 0, 0.14, 0.05, { cast: false }); mh.geometry.translate(0, 0.14, 0); mh.position.y = 0;
    const hh = box(clock, 0.04, 0.2, 0.02, '#222', 0, 0.1, 0.06, { cast: false }); hh.geometry.translate(0, 0.1, 0); hh.position.y = 0;
    state.clock = { mh, hh, key: '' };
    const tvMat = new THREE.MeshBasicMaterial({ color: '#fff' });
    box(g, 2.5, 1.5, 0.1, '#0d0f17', Lt + 1.5, 2.25, zMin + 0.07, { cast: false });
    const tv = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.3), tvMat); tv.position.set(Lt + 1.5, 2.25, zMin + 0.13); g.add(tv);
    const tvGloss = glossPlane(2.3, 1.3); tvGloss.position.set(Lt + 1.5, 2.25, zMin + 0.135); g.add(tvGloss);
    state.tv = { mat: tvMat, key: '' };

    // áreas do lounge
    let lampIdx = 0;
    for (const b of s.blocks) {
      const y0 = b.y0 / T, y1 = b.y1 / T;
      if (b.type === 'copa') {
        box(g, 6.4, 0.9, 1, '#d8d2c4', Lt + 3.5, 0.45, y0 + 0.5);
        box(g, 6.5, 0.06, 1.1, '#efe9db', Lt + 3.5, 0.93, y0 + 0.5);
        const cm = box(g, 0.75, 1, 0.65, '#2d2d2d', Lt + 1.3, 1.46, y0 + 0.45);
        const led = box(g, 0.14, 0.1, 0.03, new THREE.MeshStandardMaterial({ color: '#702a26', emissive: '#e5534b', emissiveIntensity: 1 }), Lt + 1.3, 1.7, y0 + 0.8, { cast: false });
        state.coffeeLed = led;
        cyl(g, 0.1, 0.09, 0.16, '#f5f5f5', Lt + 2.5, 1.04, y0 + 0.5); cyl(g, 0.1, 0.09, 0.16, '#4f8cff', Lt + 3, 1.04, y0 + 0.5);
        box(g, 0.8, 0.9, 0.7, '#e8eaf2', Lt + 5.9, 0.45, y0 + 0.5);
        cyl(g, 0.3, 0.3, 0.8, new THREE.MeshStandardMaterial({ color: '#8fd3ff', roughness: 0.2, transparent: true, opacity: 0.8 }), Lt + 5.9, 1.3, y0 + 0.5);
        cyl(g, 0.75, 0.75, 0.07, '#7a5a3a', Lt + 3.5, 0.7, y0 + 3.7); cyl(g, 0.07, 0.07, 0.65, '#4a3320', Lt + 3.5, 0.35, y0 + 3.7); cyl(g, 0.4, 0.4, 0.04, '#4a3320', Lt + 3.5, 0.03, y0 + 3.7);
        box(g, 0.34, 0.02, 0.26, '#f5f5f5', Lt + 3.5, 0.75, y0 + 3.7);
        const pl = makePlant(); pl.position.set(Lt + 6.5, 0, y0 + 4.7); g.add(pl); state.plants.push(pl.userData.sway);
        warm[lampIdx].position.set(Lt + 3.5, 2.6, y0 + 2.5); lampIdx++;
        // vapor da cafeteira
        const steam = new THREE.Group(); steam.position.set(Lt + 1.3, 2.0, y0 + 0.5);
        for (let i = 0; i < 3; i++) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ color: '#fff', transparent: true, opacity: 0, depthWrite: false })); sp.scale.set(0.22, 0.22, 1); steam.add(sp); }
        g.add(steam); state.steam = steam;
      } else if (b.type === 'reuniao') {
        const bt = new THREE.Mesh(new THREE.PlaneGeometry(W - 1 - Lt, y1 - y0 - 0.1), new THREE.MeshBasicMaterial({ color: '#2a5f8a', transparent: true, opacity: 0.22 }));
        bt.rotation.x = -Math.PI / 2; bt.position.set(Lt + (W - 1 - Lt) / 2, 0.012, (y0 + y1) / 2 + 0.05); g.add(bt);
        box(g, 1.9, 1.05, 0.06, '#e8eaf2', Lt + 1.5, 1.1, y0 + 0.75);
        box(g, 0.5, 0.05, 0.02, '#4f8cff', Lt + 1.2, 1.3, y0 + 0.79, { cast: false }); box(g, 0.34, 0.05, 0.02, '#e5534b', Lt + 1.1, 1.15, y0 + 0.79, { cast: false });
        box(g, 0.06, 0.6, 0.06, '#555', Lt + 0.7, 0.3, y0 + 0.75); box(g, 0.06, 0.6, 0.06, '#555', Lt + 2.3, 0.3, y0 + 0.75);
        box(g, 4.4, 0.08, 1.4, '#8a5a3b', Lt + 3.5, 0.72, y0 + 3.2);
        box(g, 4.1, 0.05, 1.1, '#6b4429', Lt + 3.5, 0.66, y0 + 3.2);
        for (const x of [1.5, 5.5]) for (const z of [2.7, 3.7]) box(g, 0.1, 0.7, 0.1, '#4a2e1b', Lt + x, 0.35, y0 + z);
        box(g, 0.34, 0.02, 0.5, '#f5f5f5', Lt + 2.5, 0.77, y0 + 3.2); box(g, 0.5, 0.03, 0.34, '#d0d0d8', Lt + 4.6, 0.77, y0 + 3.3);
        warm[lampIdx].position.set(Lt + 3.5, 2.6, y0 + 3.2); lampIdx++;
      } else if (b.type === 'descanso') {
        const rug = box(g, 3.4, 0.02, 2, '#5a3e7a', Lt + 2.9, 0.012, y0 + 4.3, { cast: false });
        box(g, 3.1, 0.022, 1.7, '#6b4f8f', Lt + 2.9, 0.013, y0 + 4.3, { cast: false });
        const sofa = makeSofa(); sofa.position.set(Lt + 3.5, 0, y0 + 1.75); g.add(sofa);
        const puff = sph(g, 0.6, '#f2a93b', Lt + 1.6, 0.3, y0 + 4.9, 24); puff.scale.set(1, 0.6, 1);
        const arc = makeArcade(); arc.position.set(Lt + 5.9, 0, y0 + 3.7); g.add(arc); state.arcade = arc;
        warm[lampIdx % 3].position.set(Lt + 3.5, 2.6, y0 + 3); lampIdx++;
      }
    }
    // cadeiras de reunião e do sofá
    for (const sp of s.spots) {
      if (sp.act === 'reuniao') {
        const c = makeChair(); c.position.set(sp.x / T, 0, sp.y / T); c.rotation.y = Math.atan2(-FACE[sp.facing][0], -FACE[sp.facing][1]); g.add(c);
      }
    }

    // mesas
    const sunDir = new THREE.Vector3(-0.45, 1, 0.55).normalize();
    for (const d of s.desks) {
      const cx = d.x / T, cy = d.y / T;
      const dg = new THREE.Group(); g.add(dg);
      if (d.empty) {
        if (d.isNew) {
          const pts = [[0.5, 0.5], [4.5, 0.5], [4.5, 4.3], [0.5, 4.3], [0.5, 0.5]].map(([x, z]) => new THREE.Vector3(cx + x, 0.02, cy + z));
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: '#ffffff', dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.55 }));
          line.computeLineDistances(); dg.add(line);
          const pl = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.6), new THREE.MeshBasicMaterial({ map: textPlane('+ NOVA MESA', { w: 512, h: 96, px: 50, color: '#ffffffcc' }), transparent: true, depthWrite: false }));
          pl.rotation.x = -Math.PI / 2; pl.position.set(cx + 2.5, 0.03, cy + 2.4); dg.add(pl); state.flat.push(pl);
          const hit = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 3.8), new THREE.MeshBasicMaterial({ visible: false })); hit.position.set(cx + 2.5, 0.5, cy + 2.4); hit.userData = { kind: 'slot' }; dg.add(hit); hitList.push(hit);
        }
        continue;
      }
      const col = d.color || '#4f8cff';
      // tapete com a cor do projeto
      const rug = new THREE.Mesh(new THREE.PlaneGeometry(4, 4.1), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.3, depthWrite: false }));
      rug.rotation.x = -Math.PI / 2; rug.position.set(cx + 2.5, 0.014, cy + 2.55); dg.add(rug);
      // contorno de seleção / foco
      const ol = new THREE.Line(new THREE.BufferGeometry().setFromPoints([[0.5, 0.5], [4.5, 0.5], [4.5, 4.6], [0.5, 4.6], [0.5, 0.5]].map(([x, z]) => new THREE.Vector3(cx + x, 0.03, cy + z))), new THREE.LineBasicMaterial({ color: '#ffffff' }));
      ol.visible = false; dg.add(ol);
      // mesa
      box(dg, 3.2, 0.07, 1.05, '#8a5a3b', cx + 2.5, DESK_Y, cy + 1.4);
      box(dg, 3.2, 0.1, 0.06, '#a8714c', cx + 2.5, DESK_Y + 0.0, cy + 1.92);
      for (const x of [1.05, 3.95]) for (const z of [0.95, 1.85]) box(dg, 0.08, DESK_Y, 0.08, '#4a2e1b', cx + x, DESK_Y / 2, cy + z);
      box(dg, 0.8, 0.5, 0.9, '#6b4429', cx + 3.5, 0.4, cy + 1.4);
      // monitor
      const mon = new THREE.Group(); mon.position.set(cx + 2.5, DESK_Y, cy + 1.1); dg.add(mon);
      box(mon, 0.08, 0.22, 0.08, '#1c1c24', 0, 0.14, 0); box(mon, 0.5, 0.025, 0.28, '#1c1c24', 0, 0.02, 0);
      box(mon, 1.4, 0.86, 0.06, '#1c1c24', 0, 0.72, 0);
      const cv = document.createElement('canvas'); cv.width = 192; cv.height = 112;
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.76), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })); screen.position.set(0, 0.72, 0.035); mon.add(screen);
      const sgl = glossPlane(1.3, 0.76); sgl.position.set(0, 0.72, 0.038); mon.add(sgl);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), new THREE.MeshBasicMaterial({ color: '#3fbf7f', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.rotation.x = -Math.PI / 2; glow.position.set(cx + 2.5, DESK_Y + 0.045, cy + 1.45); dg.add(glow);
      // teclado, mouse, caneca, telefone
      box(dg, 0.95, 0.03, 0.3, '#d0d0d8', cx + 2.4, DESK_Y + 0.05, cy + 1.62);
      box(dg, 0.12, 0.03, 0.2, '#d0d0d8', cx + 3.05, DESK_Y + 0.05, cy + 1.62);
      cyl(dg, 0.1, 0.09, 0.15, col, cx + 3.6, DESK_Y + 0.11, cy + 1.3);
      const phone = new THREE.Group(); phone.position.set(cx + 1.35, DESK_Y + 0.05, cy + 1.4); phone.userData.bx = cx + 1.35; dg.add(phone);
      box(phone, 0.4, 0.07, 0.34, '#2b2f3e', 0, 0.03, 0);
      const hs = box(phone, 0.36, 0.05, 0.1, '#4a5070', 0, 0.09, 0);
      const pled = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), new THREE.MeshBasicMaterial({ color: '#e5534b' })); pled.position.set(0.15, 0.1, 0.12); pled.visible = false; phone.add(pled);
      // cadeira
      const chair = makeChair(); chair.position.set(d.seat.x / T, 0, d.seat.y / T - 0.6); dg.add(chair);
      // nome do projeto, escrito no tapete
      const label = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.55), new THREE.MeshBasicMaterial({ map: textPlane(d.name.toUpperCase().slice(0, 18), { w: 640, h: 104, px: 50, color: '#ffffff' }), transparent: true, depthWrite: false }));
      label.rotation.x = -Math.PI / 2; label.position.set(cx + 2.5, 0.035, cy + 4.5); label.renderOrder = 1; dg.add(label); state.flat.push(label);
      // clique
      const hit = new THREE.Mesh(new THREE.BoxGeometry(4, 1.6, 4), new THREE.MeshBasicMaterial({ visible: false })); hit.position.set(cx + 2.5, 0.8, cy + 2.5); hit.userData = { kind: 'project', id: d.id }; dg.add(hit); hitList.push(hit);
      // poça de luz do teto sobre a mesa (aparece com a luz acesa)
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(5.8, 5.2), new THREE.MeshBasicMaterial({ map: radialTex(), color: '#ffdca0', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      pool.rotation.x = -Math.PI / 2; pool.position.set(cx + 2.5, 0.04, cy + 2.4); dg.add(pool); state.pools.push(pool);
      state.desks.set(d.id, { cv, tex, screen, glow, phone, pled, outline: ol, key: '', col, ring: false });
    }

    // decoração do usuário
    for (const d of s.decor) {
      const o = new THREE.Group(); g.add(o);
      if (d.type === 'quadro') {
        box(o, 2, 1.2, 0.08, '#2b2f3e', d.x + 1, 2.1, zMin + 0.06, { cast: false });
        const p = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.0), new THREE.MeshBasicMaterial({ map: makeFrameTexture() })); p.position.set(d.x + 1, 2.1, zMin + 0.11); o.add(p);
      } else if (d.type === 'bandeira') {
        box(o, 0.6, 1.7, 0.04, '#e5534b', d.x + 0.5, 2.2, zMin + 0.06, { cast: false });
        box(o, 0.6, 0.25, 0.05, '#fff', d.x + 0.5, 2.5, zMin + 0.07, { cast: false });
      } else if (d.type === 'planta') {
        const pl = makePlant(); pl.position.set(d.x + 0.5, 0, d.y + 0.6); o.add(pl); state.plants.push(pl.userData.sway);
      } else if (d.type === 'tapete') {
        box(o, 1.95, 0.02, 1.95, '#7a3b4a', d.x + 1, 0.015, d.y + 1, { cast: false }); box(o, 1.5, 0.022, 1.5, '#a24d60', d.x + 1, 0.016, d.y + 1, { cast: false }); box(o, 0.9, 0.024, 0.9, '#7a3b4a', d.x + 1, 0.017, d.y + 1, { cast: false });
      } else if (d.type === 'estante') {
        const b = makeBookcase(); b.position.set(d.x + 1, 0, d.y + 0.5); o.add(b);
      } else if (d.type === 'abajur') {
        cyl(o, 0.18, 0.18, 0.04, '#333', d.x + 0.5, 0.02, d.y + 0.5); cyl(o, 0.025, 0.025, 1.3, '#555', d.x + 0.5, 0.67, d.y + 0.5);
        const sh = add(o, new THREE.CylinderGeometry(0.17, 0.3, 0.38, 20, 1, true), new THREE.MeshStandardMaterial({ color: '#f2d16b', emissive: '#ffcf70', emissiveIntensity: 0.9, side: THREE.DoubleSide }), d.x + 0.5, 1.45, d.y + 0.5, { cast: false });
        const gl = new THREE.Sprite(new THREE.SpriteMaterial({ color: '#ffd98a', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending })); gl.scale.set(1.6, 1.6, 1); gl.position.set(d.x + 0.5, 1.45, d.y + 0.5); o.add(gl);
        if (lampIdx < 3) { warm[lampIdx].position.set(d.x + 0.5, 1.5, d.y + 0.5); lampIdx++; }
      } else if (d.type === 'impressora') {
        box(o, 0.9, 0.55, 0.7, '#6b4429', d.x + 0.5, 0.275, d.y + 0.5);
        box(o, 0.8, 0.3, 0.55, '#d0d0d8', d.x + 0.5, 0.7, d.y + 0.5); box(o, 0.6, 0.03, 0.4, '#f5f5f5', d.x + 0.5, 0.87, d.y + 0.5);
        box(o, 0.08, 0.04, 0.03, '#3fbf7f', d.x + 0.8, 0.8, d.y + 0.79, { cast: false });
      }
    }

    // chão vazio abaixo das mesas: tapete, estante, plantas e uma mesinha, para a sala não parecer inacabada.
    // Só entra onde não há mesa nem decoração do usuário (a lista do usuário tem prioridade).
    const rowsUsed = Math.max(1, ...s.desks.map((d) => Math.floor((d.y / T - WALL_H) / 5) + 1));
    const z0 = WALL_H + rowsUsed * 5, freeD = zMax - z0;
    if (freeD >= 4) {
      const userAt = (x, z, r) => s.decor.some((d) => Math.abs(d.x + 1 - x) < r + 1 && Math.abs((d.type === 'quadro' || d.type === 'bandeira' ? zMin : d.y + 1) - z) < r + 1);
      const cxm = (1 + Lt) / 2, czm = z0 + freeD / 2;
      const rw = Math.min(Lt - 5, 12), rd = Math.min(freeD - 1.8, 5);
      // o tapete é plano (itens do usuário ficam por cima); mesinha e pufes só entram se o centro estiver livre
      if (!s.decor.some((d) => d.type === 'tapete' && Math.abs(d.x + 1 - cxm) < rw / 2 && Math.abs(d.y + 1 - czm) < rd / 2)) {
        box(g, rw, 0.02, rd, '#2f3f63', cxm, 0.014, czm, { cast: false });
        box(g, rw - 0.5, 0.022, rd - 0.5, '#3d5280', cxm, 0.015, czm, { cast: false });
        box(g, rw - 1.1, 0.024, rd - 1.1, '#33466f', cxm, 0.016, czm, { cast: false });
      }
      if (!userAt(cxm, czm, 2.2)) {
        cyl(g, 0.8, 0.8, 0.06, '#7a5a3a', cxm, 0.5, czm); cyl(g, 0.07, 0.07, 0.45, '#4a3320', cxm, 0.25, czm); cyl(g, 0.4, 0.4, 0.04, '#4a3320', cxm, 0.03, czm);
        for (const [dx, dz, c] of [[-1.5, 0.3, '#f2a93b'], [1.5, -0.2, '#3fbf7f']]) { const pf = sph(g, 0.45, c, cxm + dx, 0.24, czm + dz, 20); pf.scale.set(1, 0.6, 1); }
      }
      if (!userAt(1.5, z0 + 1.6, 1)) { const bc = makeBookcase(); bc.position.set(1.4, 0, z0 + 1.6); bc.rotation.y = Math.PI / 2; g.add(bc); }
      for (const [px, pz] of [[1.8, zMax - 0.9], [Lt - 0.9, zMax - 0.9], [Lt - 0.9, z0 + 0.7], [1.8, z0 + 4]]) {
        if (pz > z0 + 0.4 && pz < zMax - 0.3 && !userAt(px, pz, 0.6)) { const pl = makePlant(); pl.position.set(px, 0, pz); g.add(pl); state.plants.push(pl.userData.sway); }
      }
    }

    // sombra do sol cobrindo a sala toda
    const r = Math.hypot(W, zMax - zMin) * 0.55;
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: r * 6 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.position.set(cam.bx - r * 0.7, r * 1.7, cam.bz + r * 0.9);
    sun.target.position.set(cam.bx, 0, cam.bz);
    state.sunDir = sunDir;
    // tudo o que está colado na parede do fundo (moldura, janelas, quadros, TV): some quando a câmera passa para o outro lado
    const bb = new THREE.Box3(), bs = new THREE.Vector3(), bc = new THREE.Vector3();
    state.backWall = g.children.filter((o) => {
      if (!o.isMesh && !o.isGroup) return false;
      bb.setFromObject(o); bb.getSize(bs); bb.getCenter(bc);
      return bs.z < 0.6 && bc.z < zMin + 0.4 && bb.min.y > 0.3;
    });
    // só volta ao enquadramento inicial se a sala mudou de tamanho (decorar ou mover mesas não perde o ângulo)
    const dims = W + 'x' + H;
    if (state.dims !== dims) { state.dims = dims; resetCamera(); }
  }

  // ---------- atualização por quadro ----------
  function skyTex(c1, c2, night, seed) {
    return canvasTex(128, 128, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, c1); gr.addColorStop(1, c2);
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      const r = rnd(seed);
      if (night) { for (let i = 0; i < 14; i++) { g.fillStyle = `rgba(255,255,255,${0.4 + r() * 0.6})`; g.fillRect(r() * w, r() * h * 0.7, 2, 2); } }
      else { g.fillStyle = 'rgba(255,255,255,.85)'; for (const [x, y, s] of [[0.2, 0.3, 1], [0.65, 0.18, 0.8]]) { g.beginPath(); g.ellipse(w * x, h * y, 18 * s, 7 * s, 0, 0, 7); g.ellipse(w * x + 12 * s, h * y - 4, 12 * s, 8 * s, 0, 0, 7); g.fill(); } }
    });
  }

  function drawScreen(d, st, present, now, i) {
    const g = d.cv.getContext('2d'), w = d.cv.width, h = d.cv.height;
    const frame = st === 'trabalhando' && present ? Math.floor(now / 330) : st === 'bloqueado' && present ? Math.floor(now / 500) % 2 : 0;
    const key = `${st}|${present}|${frame}`;
    if (key === d.key) return;
    d.key = key;
    if (st === 'trabalhando' && present) {
      g.fillStyle = '#0c2418'; g.fillRect(0, 0, w, h);
      for (let l = 0; l < 7; l++) {
        const seed = (frame + l) * 9301 + i * 49297;
        const ind = ((seed >> 3) % 3) * 12, len = 30 + (seed % 90);
        g.fillStyle = ['#3fbf7f', '#8fd3ff', '#f2a93b'][(seed >> 5) % 3];
        g.fillRect(12 + ind, 12 + l * 14, Math.min(len, w - 30 - ind), 6);
      }
    } else if (st === 'bloqueado' && present) {
      g.fillStyle = frame ? '#7a1f1a' : '#4a1512'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff'; g.font = '700 70px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', w / 2, h / 2 + 4);
    } else if (st === 'concluido') { // a tela de pronto continua acesa mesmo com o agente longe da mesa
      g.fillStyle = '#1a3a7a'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff'; g.font = '700 70px Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('✓', w / 2, h / 2 + 4);
    } else {
      g.fillStyle = '#16171f'; g.fillRect(0, 0, w, h); g.fillStyle = '#2a2c3d'; g.fillRect(12, 12, 28, 8);
    }
    d.tex.needsUpdate = true;
  }

  const agentSprites = new Map(); // id -> { sprite, key }
  function nameSprite(a) {
    const key = a.name + '|' + (a.statusColor || '');
    let e = agentSprites.get(a.id);
    if (e && e.key === key) return e.sprite;
    if (e) { e.sprite.material.map.dispose(); e.sprite.material.dispose(); }
    const tex = canvasTex(320, 72, (g, w, h) => {
      g.fillStyle = 'rgba(15,17,26,.72)'; g.beginPath(); g.roundRect(0, 6, w, h - 12, 24); g.fill();
      g.font = '700 34px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
      const tw = g.measureText(a.name).width, x0 = (w - tw - 30) / 2;
      g.fillStyle = a.statusColor || '#9097b0'; g.beginPath(); g.arc(x0 + 9, h / 2, 9, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(a.name, x0 + 26, h / 2 + 2);
    });
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(1.15, 0.26, 1); sp.renderOrder = 9;
    agentSprites.set(a.id, { sprite: sp, key });
    return sp;
  }

  function render(s, now) {
    if (mobile && now - state.lastFrame < 33) return; // celular: 30 quadros por segundo bastam
    const dt = Math.min(0.1, (now - (state.lastNow || now)) / 1000);
    state.lastNow = now; state.lastFrame = now;

    const key = JSON.stringify([s.W, s.H, s.L, s.floor, s.wallColors, s.blocks, s.desks.map((d) => [d.id, d.name, d.color, d.x, d.y, !!d.empty, !!d.isNew]), s.decor, s.spots.length, s.server ? [s.server.msg, s.server.x0, s.server.pitch, s.server.racks.map((r) => r.host)] : 0]);
    if (key !== state.key) { state.key = key; resize(); build(s); }

    if (s.server) return renderServer(s, now, dt);

    // luz e céu conforme a hora
    const night = s.night, h = new Date().getHours();
    const dayK = night ? 0 : h >= 17 || h < 7 ? 0.65 : 1;
    // interruptor da luz: muda aos poucos. Acesa à noite, o escritório fica claro e quente; apagada, só as luzes da copa,
    // da reunião e do descanso (as `warm`) iluminam, e de dia ela só escurece um pouco.
    state.lk ??= s.lights === false ? 0 : 1;
    state.lk += ((s.lights === false ? 0 : 1) - state.lk) * Math.min(1, dt * 3);
    const lk = state.lk;
    sun.intensity = night ? 0.45 + 0.12 * lk : 2.3 * dayK; sun.color.set(night ? '#6f86e6' : dayK < 1 ? '#ffb27a' : '#fff3dd');
    hemi.intensity = night ? 0.5 + 0.85 * lk : 1.55 * (0.8 + 0.2 * lk);
    hemi.color.set(night ? '#4a5aa8' : '#cfe0ff'); if (night) hemi.color.lerp(WARM_WHITE, lk);
    const poolA = (night ? 0.2 : 0.05) * lk;
    for (const pl of state.pools) pl.material.opacity = poolA;
    for (const st of state.strips) st.material.color.copy(STRIP_OFF).lerp(STRIP_ON, lk);
    if (state.door) state.door.pivot.rotation.y = 1.5 * (s.doorK || 0);
    warm.forEach((l) => { l.intensity = night ? 9 : dayK < 1 ? 3 : 0; });
    const gk = s.sky.join() + night;
    if (gk !== state.glassKey) {
      state.glassKey = gk;
      state.glass.forEach((m, i) => { m.map?.dispose(); m.map = skyTex(s.sky[0], s.sky[1], night, 3 + i); m.needsUpdate = true; });
    }

    // relógio e TV
    const d0 = new Date(), ck = d0.getHours() + ':' + d0.getMinutes();
    if (state.clock.key !== ck) { state.clock.key = ck; state.clock.mh.rotation.z = -d0.getMinutes() * Math.PI / 30; state.clock.hh.rotation.z = -((d0.getHours() % 12) + d0.getMinutes() / 60) * Math.PI / 6; }
    const tk = s.counts.join();
    if (state.tv.key !== tk) {
      state.tv.key = tk;
      state.tv.mat.map?.dispose();
      state.tv.mat.map = canvasTex(512, 280, (g, w, hh) => {
        g.fillStyle = '#0f1828'; g.fillRect(0, 0, w, hh);
        g.fillStyle = '#ffffff14'; g.fillRect(w / 2 - 1, 16, 2, hh - 32); g.fillRect(16, hh / 2 - 1, w - 32, 2);
        s.counts.forEach((n, i) => {
          const cx = (i % 2) * (w / 2), cy = Math.floor(i / 2) * (hh / 2);
          g.fillStyle = s.statusColors[i]; g.beginPath(); g.arc(cx + 52, cy + 56, 18, 0, 7); g.fill();
          g.fillStyle = '#fff'; g.font = '700 96px Inter, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(String(n), cx + 84, cy + 62);
          g.fillStyle = '#c3d0ea'; g.font = '700 25px Inter, sans-serif'; g.fillText((s.statusLabels?.[i] || '').toUpperCase(), cx + 26, cy + 116);
        });
      });
      state.tv.mat.needsUpdate = true;
    }

    // mesas: tela, brilho, telefone, contorno
    s.desks.forEach((dk, i) => {
      const d = state.desks.get(dk.id);
      if (!d) return;
      drawScreen(d, dk.status, dk.seated, now, i);
      const on = (dk.seated && ['trabalhando', 'bloqueado'].includes(dk.status)) || dk.status === 'concluido';
      d.glow.material.opacity = on ? 0.22 : 0;
      d.glow.material.color.set(dk.status === 'trabalhando' ? '#3fbf7f' : dk.status === 'bloqueado' ? '#e5534b' : '#4f8cff');
      d.phone.position.x = d.phone.userData.bx + (dk.ringing ? Math.sin(now / 45) * 0.012 : 0);
      d.phone.rotation.y = dk.ringing ? Math.sin(now / 50) * 0.08 : 0;
      d.pled.visible = dk.ringing && now % 400 < 200;
      d.outline.visible = dk.selected || dk.hover;
      d.outline.material.opacity = dk.selected ? 1 : 0.6;
    });

    // plantas, cafeteira e fliperama
    for (const p of state.plants) { p.rotation.z = Math.sin(now / 1100 + p.id) * 0.035; p.rotation.x = Math.cos(now / 1300 + p.id) * 0.025; }
    if (state.coffeeLed) state.coffeeLed.material.emissiveIntensity = now % 1000 < 500 ? 1.2 : 0.15;
    if (state.steam) state.steam.children.forEach((sp, i) => { const t = (now / 1300 + i / 3) % 1; sp.position.set(Math.sin(t * 6 + i) * 0.05, t * 0.55, 0); sp.material.opacity = s.coffee ? 0.5 * (1 - t) : 0; });
    if (state.arcade) state.arcade.userData.screen.material.emissive.set(s.arcade ? ['#3fbf7f', '#f2a93b', '#4f8cff', '#e5534b'][Math.floor(now / 180) % 4] : '#000');

    // personagens
    const seen = new Set();
    for (const a of s.agents) {
      seen.add(a.id);
      let g = state.agents.get(a.id);
      if (!g || g.userData.sig !== a.sig || g.userData.style !== charStyle) {
        if (g) { agentsGroup.remove(g); freeAgent(g); }
        g = buildAgent(a); g.userData.sig = a.sig; agentsGroup.add(g); state.agents.set(a.id, g);
        g.userData.name = nameSprite(a); g.add(g.userData.name);
      }
      const ns = nameSprite(a); // troca a etiqueta se o nome ou a cor do status mudou
      if (ns !== g.userData.name) { g.remove(g.userData.name); g.add(ns); g.userData.name = ns; }
      pose(g, a, now, dt);
    }
    for (const [id, g] of state.agents) if (!seen.has(id)) { agentsGroup.remove(g); freeAgent(g); state.agents.delete(id); }

    placeCamera();
    renderer.render(scene, camera);
  }

  // sala de servidores: luz fria e baixa, só os racks se mexem (LEDs, ventoinhas, farol)
  function renderServer(s, now, dt) {
    sun.intensity = 1.7; sun.color.set('#c4d4ff');
    hemi.intensity = 1.5; hemi.color.set('#9fb2e8');
    warm.forEach((l) => { l.intensity = 0; });
    for (const [id, g] of state.agents) { agentsGroup.remove(g); freeAgent(g); state.agents.delete(id); }
    if (state.srv) updateServerRoom(state.srv, s, now, dt);
    placeCamera();
    renderer.render(scene, camera);
  }

  const SEAT_BY_ACT = { reuniao: SEAT_Y, sofa: 0.62, puff: 0.66 }; // altura do assento de cada lugar de sentar
  const SIT_ACTS = { reuniao: HIP_SIT, sofa: HIP_SIT, puff: 0.26 };
  function pose(g, a, now, dt) {
    const u = g.userData, rt = a.rt;
    const spotSit = rt.atSpot && SIT_ACTS[rt.atSpot.act] != null;
    const target = rt.seated ? 1 : spotSit ? 1 : 0;
    u.sitk += (target - u.sitk) * Math.min(1, dt * 9);
    u.moveK += ((rt.moving ? 1 : 0) - u.moveK) * Math.min(1, dt * 12);
    const sk = u.sitk;
    const hipSit = rt.seated ? HIP_SIT : spotSit ? SIT_ACTS[rt.atSpot.act] : HIP_SIT;
    let x = rt.x / T, z = rt.y / T;
    if (rt.seated) z -= 0.6 * sk;
    // sofá: o personagem novo senta mais à frente (as canelas ficam fora da base); pufe: no topo, um pouco à frente do centro
    else if (spotSit && rt.atSpot.act === 'sofa') z -= (u.seatFit ? 0.25 : 0.55) * sk;
    else if (spotSit && u.seatFit && rt.atSpot.act === 'puff') z += 0.25 * sk;
    g.position.set(x, 0, z);
    g.visible = rt.y / T <= cam.zMax + 0.04; // além da parede da frente (do lado de fora da porta): escondido
    u.rot = lerpAngle(u.rot, rotFor(rt.facing), Math.min(1, dt * 14));
    g.rotation.y = u.rot;
    const seatY = rt.seated ? SEAT_Y : spotSit ? SEAT_BY_ACT[rt.atSpot.act] : null;
    animateRig(u, a, rt, { now, dt, sk, hipSit, hipStand: HIP_STAND, seatY });
    // nome e emoji da atividade
    // etiqueta no chão, na frente do personagem (no mundo: 0,4 para o lado da câmera); assim não cobre monitor nem balão
    const th = u.rot, off = 0.34;
    u.name.position.set(-off * Math.sin(th), 0.1, off * Math.cos(th));
    const em = a.emoji;
    if (em !== u.emojiKey) {
      if (u.emoji) { g.remove(u.emoji); u.emoji.material.dispose(); u.emoji = null; }
      if (em) { u.emoji = emojiSprite(em); g.add(u.emoji); }
      u.emojiKey = em;
    }
    const headTop = HIP_STAND + 1.3 + (hipSit - HIP_STAND) * sk * 0.9;
    if (u.emoji) u.emoji.position.set(0.5, headTop + 0.25 + Math.sin(now / 400) * 0.03, 0);
  }

  // ---------- clique e posição na tela ----------
  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    v2.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v2, camera);
    const hits = ray.intersectObjects([...hitList, ...[...state.agents.values()].map((g) => g.userData.hit)], false);
    if (!hits.length) return null;
    const agent = hits.find((h) => h.object.userData.kind === 'agent');
    const o = (agent || hits[0]).object.userData;
    if (o.kind === 'rack') return { kind: 'rack', host: o.host ?? null };
    return o.kind === 'slot' ? { kind: 'slot' } : { kind: o.kind, id: o.id };
  }
  const v3 = new THREE.Vector3();
  function screenPos(xpx, ypx, hgt) {
    v3.set(xpx / T, hgt, ypx / T).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: (v3.x + 1) / 2 * r.width, y: (1 - v3.y) / 2 * r.height };
  }

  return {
    cam, render, pick, screenPos, resize, resetCamera,
    // alterna entre a vista de trás das mesas e a de frente (vendo o rosto de quem está sentado)
    flip: () => { cam.azT = (Math.round(cam.azT / Math.PI) + 1) * Math.PI; },
    // troca entre os personagens novos e os clássicos; devolve o estilo em uso
    setCharQuality, // para testes: redefine o nível de detalhe antes de criar os personagens
    setCharStyle: (st) => (charStyle = st === 'classico' ? 'classico' : 'novo'),
    // contadores para medir desempenho (chamadas de desenho, triângulos e geometrias na GPU)
    stats: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, geos: renderer.info.memory.geometries, texs: renderer.info.memory.textures }),
    zoomBy: (f) => { cam.zoom = clamp(cam.zoom * f, camRange.zoom); },
    dispose: () => renderer.dispose(),
  };
}

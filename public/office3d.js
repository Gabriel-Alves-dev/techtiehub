// Escritório em 3D (Three.js). Só desenha: a lógica (posições, status, caminhos) continua no app.js, que manda um
// "retrato" da cena a cada quadro. 1 unidade 3D = 1 tile; o ponto (x, y) do mundo 2D vira (x / 16, altura, y / 16).
import * as THREE from './vendor/three.module.min.js';

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
function buildAgent(a) {
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  const skin = mat(a.skin || '#f1c7a0'), shirt = mat(a.shirt || '#4f8cff'), hair = mat(a.hair || '#3b2416');
  const pants = mat('#2a2f45'), shoe = mat('#15171f');

  caps(body, 0.17, 0.24, shirt, 0, 0.29, 0); // tronco
  box(body, 0.3, 0.05, 0.18, '#0003', 0, 0.02, 0).visible = false;
  const neck = cyl(body, 0.07, 0.07, 0.08, skin, 0, 0.6, 0, 10);
  neck.castShadow = false;
  const collar = add(body, new THREE.TorusGeometry(0.085, 0.028, 8, 18), shirt, 0, 0.575, 0, { cast: false }); collar.rotation.x = Math.PI / 2;
  cyl(body, 0.174, 0.174, 0.035, '#1c1c24', 0, 0.1, 0, 20).castShadow = false; // cinto

  const head = new THREE.Group(); head.position.y = 0.83; body.add(head);
  const skull = sph(head, 0.21, skin, 0, 0, 0, 24); skull.scale.set(1, 1.04, 1);
  const cap = (r, y = 0, z = 0, rx = -0.32, mat_ = hair) => {
    const m = add(head, new THREE.SphereGeometry(r, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.56), mat_, 0, y, z);
    m.rotation.x = rx;
    return m;
  };
  const style = a.hairStyle || ['curto', 'longo', 'coque'][[...String(a.id)].reduce((s, c) => s + c.charCodeAt(0), 0) % 3];
  cap(0.225);
  if (style === 'longo') {
    caps(head, 0.17, 0.2, hair, 0, -0.14, -0.1);
    caps(head, 0.06, 0.18, hair, -0.2, -0.1, -0.02);
    caps(head, 0.06, 0.18, hair, 0.2, -0.1, -0.02);
  }
  if (style === 'coque') sph(head, 0.1, hair, 0, 0.24, -0.1);
  // rosto: olhos com branco, pupila e brilho (piscam), sobrancelhas e boca que mudam com o humor, bochechas
  const eyes = [];
  for (const x of [-0.078, 0.078]) {
    const eye = new THREE.Group(); eye.position.set(x, 0.02, 0.185); head.add(eye);
    const wh = sph(eye, 0.04, '#ffffff', 0, 0, 0, 14); wh.scale.set(1, 1.2, 0.5); wh.castShadow = false;
    const pu = sph(eye, 0.024, '#1a1a1a', 0, -0.002, 0.016, 12); pu.scale.set(1, 1.1, 0.6); pu.castShadow = false;
    const hl = sph(eye, 0.008, '#ffffff', 0.008, 0.01, 0.026, 6); hl.castShadow = false;
    eyes.push(eye);
  }
  const brows = [-1, 1].map((side) => box(head, 0.075, 0.016, 0.02, hair, side * 0.078, 0.095, 0.2, { cast: false }));
  const lip = '#a5553f';
  const mN = box(head, 0.07, 0.014, 0.02, lip, 0, -0.085, 0.2, { cast: false });
  const mS = add(head, new THREE.TorusGeometry(0.05, 0.012, 6, 14, Math.PI), mat(lip), 0, -0.05, 0.198, { cast: false }); mS.rotation.z = Math.PI; mS.visible = false;
  const mF = add(head, new THREE.TorusGeometry(0.04, 0.012, 6, 14, Math.PI), mat(lip), 0, -0.12, 0.198, { cast: false }); mF.visible = false;
  for (const x of [-0.125, 0.125]) { const ch = sph(head, 0.04, mat('#ff8f8f', { transparent: true, opacity: 0.32 }), x, -0.04, 0.165, 8); ch.scale.set(1, 0.6, 0.3); ch.castShadow = false; }
  for (const x of [-0.19, 0.19]) { const ear = sph(head, 0.04, skin, x, 0, 0, 8); ear.castShadow = false; }

  if (a.accessory === 'oculos') {
    for (const x of [-0.078, 0.078]) { const t = add(head, new THREE.TorusGeometry(0.058, 0.013, 8, 20), mat('#1a1a1a'), x, 0.03, 0.2, { cast: false }); t.rotation.y = 0; }
    box(head, 0.06, 0.012, 0.012, '#1a1a1a', 0, 0.04, 0.205, { cast: false });
  } else if (a.accessory === 'fone') {
    const arc = add(head, new THREE.TorusGeometry(0.235, 0.02, 8, 24, Math.PI), mat('#2d3142'), 0, 0.0, 0);
    for (const x of [-0.235, 0.235]) { const c = cyl(head, 0.075, 0.075, 0.07, '#e5534b', x, 0, 0, 16); c.rotation.z = Math.PI / 2; }
  } else if (a.accessory === 'bone') {
    cap(0.235, 0.015, 0, -0.18, mat('#e5534b'));
    const brim = box(head, 0.3, 0.025, 0.2, '#b33a33', 0, 0.09, 0.24); brim.rotation.x = 0.1;
  }

  // braços
  const mkArm = (side) => {
    const sh = new THREE.Group(); sh.position.set(side * 0.235, 0.52, 0); body.add(sh);
    caps(sh, 0.058, 0.14, shirt, 0, -0.11, 0);
    const el = new THREE.Group(); el.position.y = -0.22; sh.add(el);
    caps(el, 0.052, 0.12, shirt, 0, -0.1, 0);
    sph(el, 0.06, skin, 0, -0.22, 0, 10);
    return { sh, el };
  };
  const L = mkArm(-1), R = mkArm(1);
  // pernas
  const mkLeg = (side) => {
    const hp = new THREE.Group(); hp.position.set(side * 0.1, 0, 0); body.add(hp);
    caps(hp, 0.075, 0.12, pants, 0, -0.1, 0);
    const kn = new THREE.Group(); kn.position.y = -0.22; hp.add(kn);
    caps(kn, 0.068, 0.16, pants, 0, -0.14, 0);
    box(kn, 0.13, 0.07, 0.24, shoe, 0, -0.29, 0.04);
    return { hp, kn };
  };
  const LL = mkLeg(-1), RL = mkLeg(1);

  // área de clique
  const hit = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.7, 0.8), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 0.85; root.add(hit);
  hit.userData = { kind: 'agent', id: a.id };

  root.scale.setScalar(1.25);
  root.userData = { body, head, L, R, LL, RL, sitk: 0, moveK: 0, rot: 0, hit, eyes, brows, mN, mS, mF };
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
  const sun = new THREE.DirectionalLight('#fff3dd', 2.6);
  sun.castShadow = true;
  const sm = mobile ? 1024 : 2048;
  sun.shadow.mapSize.set(sm, sm);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const warm = [0, 1, 2].map(() => { const l = new THREE.PointLight('#ffb866', 0, 9, 1.6); scene.add(l); return l; });

  const staticGroup = new THREE.Group(); scene.add(staticGroup);
  const agentsGroup = new THREE.Group(); scene.add(agentsGroup);
  const hitList = []; // áreas de clique das mesas (as dos personagens ficam em cada personagem)
  const state = { key: '', room: null, desks: new Map(), agents: new Map(), plants: [], arcade: null, steam: null, lamp: null, clock: null, tv: null, glass: [], glassKey: '', lastNow: 0, lastFrame: 0 };

  // câmera orbital: azimute e elevação em torno do centro da sala
  const cam = { az: 0, el: 0.95, zoom: 1, cx: 0, cz: 0, bx: 0, bz: 0, R: 10, depth: 10, width: 20, dist: 20, zMin: 3, zMax: 20, W: 20, Lt: 15 };
  const camRange = { az: [-0.9, 0.9], el: [0.45, 1.35], zoom: [0.45, 2.2] };
  function placeCamera() {
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
        cam.az = clamp(cam.az - dx * 0.006, camRange.az);
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
    cam.az = 0; cam.el = portrait ? 0.9 : 0.95;
    cam.zoom = portrait ? 0.58 : 1;
    cam.cx = portrait ? (1 + cam.Lt) / 2 + 0.5 : cam.bx; // vertical: começa nas mesas (o lounge fica à direita, é só deslocar)
    cam.cz = portrait ? cam.zMin + cam.depth * 0.42 : cam.bz;
  }

  // ---------- construção da sala (só quando a estrutura muda) ----------
  function disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material; // materiais do cache e texturas de emoji são recriados na GPU se voltarem a ser usados
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => { x.map?.dispose?.(); x.dispose?.(); });
    });
    g.clear();
  }

  function build(s) {
    disposeGroup(staticGroup);
    hitList.length = 0;
    state.desks.clear(); state.plants = []; state.glass = []; state.arcade = null; state.steam = null; state.clock = null; state.tv = null; state.glassKey = '';
    const g = staticGroup;
    const { W, H, L } = s;
    const Wt = W, Ht = H, Lt = L / T, wTiles = W - 2, zMin = WALL_H, zMax = H - 1;
    cam.bx = W / 2; cam.bz = (zMin + zMax) / 2; cam.zMin = zMin; cam.zMax = zMax; cam.W = W; cam.Lt = Lt; cam.R = Math.hypot(W, zMax - zMin) * 0.5; cam.depth = zMax - zMin; cam.width = W - 2;

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
    const frontW = add(g, new THREE.PlaneGeometry(wTiles, 0.9), mat(s.wallColors[1], { side: THREE.FrontSide }), W / 2, 0.45, zMax, { cast: false });
    frontW.rotation.y = Math.PI;
    // moldura no alto da parede
    box(g, wTiles, 0.08, 0.1, s.wallColors[1], W / 2, WALL_UP, zMin + 0.05);

    // janelas
    for (let x = 2; x + 3 < Lt; x += 5) {
      const gm = new THREE.MeshBasicMaterial({ color: '#fff' });
      state.glass.push(gm);
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
          pl.rotation.x = -Math.PI / 2; pl.position.set(cx + 2.5, 0.03, cy + 2.4); dg.add(pl);
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
      label.rotation.x = -Math.PI / 2; label.position.set(cx + 2.5, 0.035, cy + 4.5); label.renderOrder = 1; dg.add(label);
      // clique
      const hit = new THREE.Mesh(new THREE.BoxGeometry(4, 1.6, 4), new THREE.MeshBasicMaterial({ visible: false })); hit.position.set(cx + 2.5, 0.8, cy + 2.5); hit.userData = { kind: 'project', id: d.id }; dg.add(hit); hitList.push(hit);
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
    } else if (st === 'concluido' && present) {
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

    const key = JSON.stringify([s.W, s.H, s.L, s.floor, s.wallColors, s.blocks, s.desks.map((d) => [d.id, d.name, d.color, d.x, d.y, !!d.empty, !!d.isNew]), s.decor, s.spots.length]);
    if (key !== state.key) { state.key = key; resize(); build(s); }

    // luz e céu conforme a hora
    const night = s.night, h = new Date().getHours();
    const dayK = night ? 0 : h >= 17 || h < 7 ? 0.65 : 1;
    sun.intensity = night ? 0.45 : 2.3 * dayK; sun.color.set(night ? '#6f86e6' : dayK < 1 ? '#ffb27a' : '#fff3dd');
    hemi.intensity = night ? 0.5 : 1.55; hemi.color.set(night ? '#4a5aa8' : '#cfe0ff');
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
      const on = dk.seated && ['trabalhando', 'bloqueado', 'concluido'].includes(dk.status);
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
      if (!g || g.userData.sig !== a.sig) {
        if (g) { agentsGroup.remove(g); disposeGroup(g); }
        g = buildAgent(a); g.userData.sig = a.sig; agentsGroup.add(g); state.agents.set(a.id, g);
        g.userData.name = nameSprite(a); g.add(g.userData.name);
      }
      const ns = nameSprite(a); // troca a etiqueta se o nome ou a cor do status mudou
      if (ns !== g.userData.name) { g.remove(g.userData.name); g.add(ns); g.userData.name = ns; }
      pose(g, a, now, dt);
    }
    for (const [id, g] of state.agents) if (!seen.has(id)) { agentsGroup.remove(g); disposeGroup(g); state.agents.delete(id); }

    placeCamera();
    renderer.render(scene, camera);
  }

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
    else if (spotSit && rt.atSpot.act === 'sofa') z -= 0.55 * sk;
    g.position.set(x, 0, z);
    u.rot = lerpAngle(u.rot, rotFor(rt.facing), Math.min(1, dt * 14));
    g.rotation.y = u.rot;
    u.body.position.y = HIP_STAND + (hipSit - HIP_STAND) * sk;

    const ph = rt.walk * 0.28, sw = Math.sin(ph) * 0.7 * u.moveK * (1 - sk);
    const typing = rt.seated && a.status === 'trabalhando';
    const cheer = rt.seated && a.status === 'concluido' && Math.floor(now / 450) % 2 === 0;
    const wave = rt.seated && a.status === 'bloqueado';
    // pernas: andando balançam; sentado a coxa vai à frente e a canela desce
    u.LL.hp.rotation.x = sw - 1.5 * sk; u.RL.hp.rotation.x = -sw - 1.5 * sk;
    u.LL.kn.rotation.x = 1.5 * sk + Math.max(0, -sw) * 0.5; u.RL.kn.rotation.x = 1.5 * sk + Math.max(0, sw) * 0.5;
    // braços
    const k = Math.floor(now / 140) % 2, tp = typing ? 1 : 0;
    u.L.sh.rotation.x = -sw * 0.8 - (cheer ? 3.0 : 0) - (typing ? 0.95 : sk * 0.7) - (wave ? 2.6 + Math.sin(now / 120) * 0.2 : 0);
    u.R.sh.rotation.x = sw * 0.8 - (cheer ? 3.0 : 0) - (typing ? 0.95 : sk * 0.7);
    u.L.el.rotation.x = -(typing ? 0.9 + (k ? 0.12 : 0) : sk * 0.5) - (wave ? 0.2 : 0);
    u.R.el.rotation.x = -(typing ? 0.9 + (k ? 0 : 0.12) : sk * 0.5);
    u.L.sh.rotation.z = cheer || wave ? 0.2 : 0; u.R.sh.rotation.z = cheer ? -0.2 : 0;
    // respiração e humor
    u.head.position.y = 0.83 + Math.sin(now / 520 + a.name.length) * 0.006;
    // expressão: concluído e ocioso sorriem, bloqueado fica preocupado (sobrancelhas inclinadas, boca para baixo), trabalhando se concentra
    const mood = a.status;
    u.mN.visible = mood === 'trabalhando'; u.mS.visible = mood === 'concluido' || mood === 'ocioso'; u.mF.visible = mood === 'bloqueado';
    const bz = mood === 'bloqueado' ? 0.4 : mood === 'trabalhando' ? -0.12 : 0;
    u.brows[0].rotation.z = bz; u.brows[1].rotation.z = -bz;
    const by = 0.095 + (mood === 'concluido' ? 0.012 : mood === 'bloqueado' ? 0.016 : 0);
    u.brows[0].position.y = by; u.brows[1].position.y = by;
    const blink = ((now + a.name.length * 733) % 4200) < 130;
    u.eyes[0].scale.y = u.eyes[1].scale.y = blink ? 0.08 : 1;
    // cabeça: olha para o teclado ao digitar, olha em volta quando está parado
    const look = !rt.moving && !typing ? Math.sin(now / 2100 + a.name.length * 1.7) * 0.25 : 0;
    const hk = Math.min(1, dt * 6);
    u.head.rotation.y += (look - u.head.rotation.y) * hk;
    u.head.rotation.x += ((typing ? 0.2 : mood === 'bloqueado' ? -0.08 : 0) - u.head.rotation.x) * hk;
    u.head.rotation.z += ((cheer ? 0.09 : 0) - u.head.rotation.z) * hk;
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
    const headTop = HIP_STAND + 1.15 + (hipSit - HIP_STAND) * sk * 0.9;
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
    zoomBy: (f) => { cam.zoom = clamp(cam.zoom * f, camRange.zoom); },
    dispose: () => renderer.dispose(),
  };
}

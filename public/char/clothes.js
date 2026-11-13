// Roupas modulares: cada conjunto diz o que veste o tronco, as mangas e as pernas, e acrescenta os detalhes
// (capuz, lapelas, gola, zíper, gravata). As mangas são peças dos braços, então acompanham o movimento deles.
// Detalhes finos (lapelas, vivos, gravata) são fitas com espessura que acompanham a curva do tronco; regiões de outra
// cor (a camisa no decote) são pintadas por vértice na própria malha, sem placas coladas por cima.
import * as THREE from '../vendor/three.module.min.js';
import { sectionAt, ribbon } from './geometry.js';
import { shade } from './config.js';

// perfil do tronco (y de baixo para cima; z positivo é a frente), em unidades do corpo
export const TORSO = [
  { y: -0.02, rx: 0.185, rz: 0.145 }, { y: 0.1, rx: 0.18, rz: 0.142 }, { y: 0.2, rx: 0.158, rz: 0.125 },
  { y: 0.32, rx: 0.172, rz: 0.132, cz: 0.004 }, { y: 0.45, rx: 0.195, rz: 0.14, cz: 0.01 }, { y: 0.53, rx: 0.208, rz: 0.13 },
  { y: 0.585, rx: 0.135, rz: 0.098 }, { y: 0.62, rx: 0.07, rz: 0.068 },
];

const WHITE = '#f1eee6';

// especificação de cada conjunto
export function outfitSpec(cfg) {
  const p = cfg.shirt, s = cfg.second;
  switch (cfg.outfit) {
    case 'blazer': return { scale: 1.03, hem: -0.01, color: p, sleeve: p, sleeveK: 1.02, cuff: WHITE, cuffH: 0.022, band: null, pants: true };
    case 'cardigan': return { scale: 1.05, hem: 0.02, color: p, sleeve: p, sleeveK: 1.04, cuff: WHITE, cuffH: 0.026, band: shade(p, -0.18), bandH: 0.02, skirt: true, pants: false };
    case 'bomber': return { scale: 1.12, hem: 0.07, color: p, sleeve: p, sleeveK: 1.16, cuff: s, cuffH: 0.04, band: s, bandH: 0.045, pants: true };
    case 'colete': return { scale: 1.0, hem: 0.06, color: WHITE, sleeve: WHITE, sleeveK: 1.0, cuff: shade(WHITE, -0.08), cuffH: 0.022, band: null, vest: true, pants: true };
    default: return { scale: 1.09, hem: 0.05, color: p, sleeve: p, sleeveK: 1.12, cuff: s, cuffH: 0.04, band: s, bandH: 0.035, pants: true }; // moletom
  }
}

// z da frente do tronco (escalado por k) no ponto (x, y): a roupa e as fitas acompanham a curva do corpo
export function surfZ(x, y, k) {
  const q = sectionAt(TORSO, y), r = Math.min(Math.abs(x) / (q.rx * k), 0.97);
  return ((q.cz || 0) + q.rz * Math.sqrt(1 - r * r)) * k;
}
const surfN = (k) => (p) => { const q = sectionAt(TORSO, p.y); return new THREE.Vector3(p.x / (q.rx * q.rx * k * k), 0.02, (p.z - (q.cz || 0) * k) / (q.rz * q.rz * k * k)); };
const strip = (B, fn, n, k, lift, color, w, t) => {
  const pts = Array.from({ length: n }, (_, i) => { const [x, y] = fn(i / (n - 1)); return [x, y, surfZ(x, y, k) + lift]; });
  return B.add(ribbon(pts, { w, t, normal: surfN(k) }), color);
};

const sstep = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const blend = (c1, c2, t) => (t <= 0.001 ? null : new THREE.Color(c1).lerp(new THREE.Color(c2), t));

// pintura do tronco: a camisa aparece no decote do blazer, no colete e na abertura do cardigan (bordas suaves)
export function torsoPaint(cfg, o) {
  const front = (z) => sstep(0.0, 0.035, z);
  switch (cfg.outfit) {
    case 'blazer': {
      const h = (y) => 0.014 + (0.075 * (y - 0.3)) / 0.285;
      return (x, y, z) => blend(o.color, WHITE, (1 - sstep(h(y) - 0.006, h(y) + 0.006, Math.abs(x))) * sstep(0.29, 0.31, y) * front(z));
    }
    case 'colete': {
      const h = (y) => 0.012 + (0.07 * (y - 0.33)) / 0.21;
      return (x, y, z) => blend(cfg.shirt, WHITE, (1 - sstep(h(y) - 0.006, h(y) + 0.006, Math.abs(x))) * sstep(0.325, 0.345, y) * front(z));
    }
    case 'cardigan':
      return (x, y, z) => blend(o.color, WHITE, (1 - sstep(0.052, 0.064, Math.abs(x))) * front(z));
    default: return null;
  }
}

// detalhes de cada conjunto no tronco. B = construtor do tronco; o = spec
export function decorate(B, cfg, o) {
  const p = cfg.shirt, s = cfg.second, k = o.scale;
  switch (cfg.outfit) {
    case 'blazer': {
      const edge = (y) => 0.014 + (0.075 * (y - 0.3)) / 0.285;
      const lw = (u) => 0.012 + 0.011 * Math.sin(Math.min(1, u * 1.25) * Math.PI * 0.9); // lapela: mais larga no alto
      for (const sg of [-1, 1]) strip(B, (u) => { const y = 0.585 - u * 0.285; return [sg * (edge(y) + lw(u) * 0.9), y]; }, 10, k, 0.004, s, lw, 0.0075);
      B.torus(0.088, 0.022, s, { y: 0.585, rx: Math.PI / 2 }, Math.PI * 2, 16); // gola
      for (const y of [0.27, 0.2]) B.sph(0.012, shade(p, -0.45), { y, z: surfZ(0, y, k) + 0.004 }, 8, 6); // botões
      break;
    }
    case 'cardigan': {
      for (const sg of [-1, 1]) strip(B, (u) => [sg * 0.064, 0.565 - u * (0.545 - o.hem)], 10, k, 0.003, shade(p, -0.22), 0.011, 0.0065); // vivo da abertura
      for (const y of [0.45, 0.35, 0.25]) B.sph(0.009, '#d9d3c2', { y, z: surfZ(0, y, k) + 0.003 }, 8, 6); // botões da blusa
      B.torus(0.09, 0.02, WHITE, { y: 0.585, rx: Math.PI / 2 }, Math.PI * 2, 16); // gola da blusa
      break;
    }
    case 'bomber': {
      B.torus(0.086, 0.03, s, { y: 0.592, rx: Math.PI / 2 }, Math.PI * 2, 16); // gola canelada
      strip(B, (u) => [0, 0.53 - u * 0.4], 8, k, 0.002, '#c9ccd4', 0.006, 0.004); // zíper
      B.box(0.03, 0.045, 0.02, '#9aa0ad', { y: 0.51, z: surfZ(0, 0.5, k) + 0.008 }, 0.008); // puxador
      break;
    }
    case 'colete': {
      const kv = 1.045, h = (y) => 0.012 + (0.07 * (y - 0.33)) / 0.21;
      for (const sg of [-1, 1]) {
        strip(B, (u) => { const y = 0.545 - u * 0.215; return [sg * (h(y) + 0.004), y]; }, 10, kv, 0.004, shade(cfg.shirt, -0.3), 0.006, 0.006); // vivo da abertura em V
        strip(B, (u) => [sg * (0.03 + u * 0.05), 0.598 - u * 0.03], 5, 1.0, 0.004, WHITE, 0.012, 0.009); // ponta da gola da camisa
      }
      B.torus(0.09, 0.02, WHITE, { y: 0.585, rx: Math.PI / 2 }, Math.PI * 2, 16); // gola
      B.sph(0.022, cfg.tie, { y: 0.552, z: surfZ(0, 0.552, kv) + 0.004, sy: 0.8, sz: 0.75 }, 10, 8); // nó
      const tw = (u) => (u < 0.12 ? 0.012 + u * 0.1 : u < 0.8 ? 0.024 + (u - 0.12) * 0.018 : Math.max(0.004, 0.036 * (1 - (u - 0.8) / 0.2)));
      strip(B, (u) => [0, 0.545 - u * 0.25], 12, kv, 0.007, cfg.tie, tw, 0.0065); // gravata com ponta
      for (const y of [0.27, 0.2]) B.sph(0.01, shade(p, -0.4), { y, z: surfZ(0, y, 1.045) + 0.003 }, 8, 6);
      break;
    }
    default: { // moletom
      B.add(new THREE.TorusGeometry(0.1, 0.045, 8, 16, Math.PI * 1.5), p, { y: 0.6, z: -0.05, rx: Math.PI / 2 - 0.5, rz: Math.PI * 0.75 }); // capuz
      B.box(0.22, 0.085, 0.04, shade(p, -0.14), { y: 0.2, z: surfZ(0, 0.2, k) + 0.002 }, 0.015); // bolso canguru
      for (const sg of [-1, 1]) B.caps(0.007, 0.1, WHITE, { x: sg * 0.036, y: 0.49, z: surfZ(0, 0.5, k) + 0.006 }, 6); // cordões
      break;
    }
  }
}

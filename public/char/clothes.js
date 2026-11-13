// Roupas modulares: cada conjunto diz o que veste o tronco, as mangas e as pernas, e acrescenta os detalhes
// (capuz, lapelas, gola, zíper, gravata). As mangas são peças dos braços, então acompanham o movimento deles.
import * as THREE from '../vendor/three.module.min.js';
import { plate, sectionAt } from './geometry.js';
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

// detalhes de cada conjunto no tronco. B = construtor do tronco; o = spec; fz(y) = z da frente da roupa nessa altura
export function decorate(B, cfg, o) {
  const p = cfg.shirt, s = cfg.second;
  const fz = (y) => { const q = sectionAt(TORSO, y); return (q.cz + q.rz) * o.scale; };
  switch (cfg.outfit) {
    case 'blazer': {
      B.add(plate([[-0.075, 0], [0.075, 0], [0, -0.23]], 0.03), WHITE, { y: 0.56, z: fz(0.45) - 0.01 }); // camisa em V
      for (const sg of [-1, 1]) B.box(0.04, 0.17, 0.03, s, { x: sg * 0.078, y: 0.46, z: fz(0.46) + 0.006, rz: -sg * 0.42 }, 0.01); // lapelas
      B.torus(0.088, 0.022, s, { y: 0.585, rx: Math.PI / 2 }, Math.PI * 2, 16); // gola
      for (const y of [0.3, 0.23]) B.sph(0.013, shade(p, -0.4), { y, z: fz(y) + 0.004 }, 8, 6); // botões
      break;
    }
    case 'cardigan': {
      B.add(plate([[-0.1, 0], [0.1, 0], [0.092, -0.3], [-0.092, -0.3]], 0.03), WHITE, { y: 0.55, z: fz(0.4) - 0.012 }); // blusa aparecendo
      for (const sg of [-1, 1]) B.box(0.016, 0.3, 0.024, shade(p, -0.2), { x: sg * 0.108, y: 0.4, z: fz(0.4) + 0.002 }, 0.006); // vivo do cardigan aberto
      for (const y of [0.47, 0.37, 0.27]) B.sph(0.012, '#d8d2c4', { y, z: fz(0.4) + 0.012 }, 8, 6);
      B.torus(0.09, 0.02, WHITE, { y: 0.585, rx: Math.PI / 2 }, Math.PI * 2, 16); // gola da blusa
      break;
    }
    case 'bomber': {
      B.torus(0.086, 0.03, s, { y: 0.592, rx: Math.PI / 2 }, Math.PI * 2, 16); // gola canelada
      B.box(0.013, 0.4, 0.014, '#c9ccd4', { y: 0.33, z: fz(0.33) + 0.002 }, 0.005); // zíper
      B.box(0.03, 0.045, 0.02, '#9aa0ad', { y: 0.51, z: fz(0.5) + 0.01 }, 0.008); // puxador
      break;
    }
    case 'colete': {
      for (const sg of [-1, 1]) B.box(0.075, 0.04, 0.018, WHITE, { x: sg * 0.048, y: 0.59, z: fz(0.58) + 0.006, rz: sg * 0.5, rx: -0.25 }, 0.008); // gola
      B.box(0.04, 0.036, 0.03, cfg.tie, { y: 0.545, z: fz(0.5) + 0.012 }, 0.01); // nó
      B.add(plate([[-0.02, 0], [0.02, 0], [0.034, -0.2], [0, -0.245], [-0.034, -0.2]], 0.014), cfg.tie, { y: 0.52, z: fz(0.4) + 0.014 }); // gravata
      for (const y of [0.3, 0.22]) B.sph(0.011, shade(p, -0.4), { x: 0.0, y, z: fz(y) * 1.045 }, 8, 6);
      break;
    }
    default: { // moletom
      B.add(new THREE.TorusGeometry(0.1, 0.045, 8, 16, Math.PI * 1.5), p, { y: 0.6, z: -0.05, rx: Math.PI / 2 - 0.5, rz: Math.PI * 0.75 }); // capuz
      B.box(0.22, 0.085, 0.04, shade(p, -0.14), { y: 0.2, z: fz(0.2) + 0.004 }, 0.015); // bolso canguru
      for (const sg of [-1, 1]) B.caps(0.007, 0.1, WHITE, { x: sg * 0.036, y: 0.49, z: fz(0.5) + 0.006 }, 6); // cordões
      break;
    }
  }
}

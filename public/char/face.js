// Cabeça e rosto: crânio, mandíbula, orelhas, nariz, bochechas, cabelo e acessórios (malha única), mais as peças que
// se mexem separadas: olhos (piscam), sobrancelhas e as três bocas (neutra, sorriso, preocupada).
import * as THREE from '../vendor/three.module.min.js';
import { Builder } from './geometry.js';
import { addHair } from './hair.js';
import { shade } from './config.js';

const LIP = '#b25a48';

// devolve { head, free }: head leva contorno (crânio, cabelo de base, boné); free não (nariz, bochechas, mechas, óculos, fone)
export function headGeo(cfg) {
  const B = new Builder(), F = new Builder();
  B.sph(0.21, cfg.skin, { sy: 1.02, sz: 0.98 }, 26, 18); // crânio
  B.sph(0.17, cfg.skin, { y: -0.07, z: 0.02, sx: 1.05, sy: 0.8, sz: 0.95 }, 20, 12); // mandíbula
  for (const sg of [-1, 1]) {
    B.sph(0.04, cfg.skin, { x: sg * 0.205, y: -0.015 }, 10, 8); // orelha
    F.sph(0.03, '#e9808a', { x: sg * 0.128, y: -0.062, z: 0.152, sx: 1, sy: 0.6, sz: 0.28, ry: sg * 0.55 }, 10, 6); // bochecha, só um tom rosado
  }
  F.sph(0.02, shade(cfg.skin, -0.06), { y: -0.046, z: 0.196, sx: 0.95, sy: 0.9, sz: 1 }, 10, 8); // nariz
  addHair(B, F, cfg);
  const dark = '#1a1a1a';
  if (cfg.accessory === 'oculos') {
    for (const sg of [-1, 1]) F.torus(0.06, 0.009, dark, { x: sg * 0.082, y: -0.002, z: 0.186, ry: sg * 0.4 }, Math.PI * 2, 22);
    F.box(0.04, 0.01, 0.01, dark, { y: 0.008, z: 0.2 }, 0.004);
    for (const sg of [-1, 1]) F.box(0.01, 0.01, 0.17, dark, { x: sg * 0.172, y: 0.006, z: 0.1 }, 0.004);
  } else if (cfg.accessory === 'fone') {
    F.torus(0.265, 0.02, '#2d3142', { y: 0.0 }, Math.PI, 24);
    for (const sg of [-1, 1]) F.cyl(0.075, 0.075, 0.07, '#e5534b', { x: sg * 0.262, y: -0.01, rz: Math.PI / 2 }, 16);
  } else if (cfg.accessory === 'bone') {
    B.add(new THREE.SphereGeometry(0.245, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.56), '#e5534b', { y: 0.02, rx: -0.18 });
    B.add(new THREE.CylinderGeometry(0.165, 0.165, 0.022, 22, 1, false, -Math.PI / 2, Math.PI), '#b33a33', { y: 0.1, z: 0.12, rx: 0.1, sz: 0.85 }); // aba curta, sobre a testa
    F.sph(0.022, '#ffffff', { y: 0.255, z: -0.03 }, 8, 6);
  }
  return { head: B.build(), free: F.build() };
}

// um olho (a malha é igual para todos e para os dois lados): branco, íris escura, pupila e um brilho discreto,
// achatados na curva do rosto, como no D2 (branco bem visível e pupila preta)
export function eyeGeo() {
  const B = new Builder();
  B.sph(0.042, '#ffffff', { sx: 0.92, sy: 1.18, sz: 0.3 }, 14, 10);
  B.sph(0.03, '#3d2b22', { y: -0.003, z: 0.005, sy: 1.12, sz: 0.3 }, 12, 8);
  B.sph(0.02, '#0b090e', { y: -0.003, z: 0.0095, sz: 0.3 }, 10, 8);
  B.sph(0.0075, '#ffffff', { x: 0.009, y: 0.014, z: 0.0135, sz: 0.4 }, 6, 4);
  return B.build();
}

export function browGeo(cfg) {
  return new Builder().caps(0.009, 0.06, shade(cfg.hair, -0.25), { rz: Math.PI / 2 }, 6).build();
}

// bocas com a posição já aplicada na malha (só alternam a visibilidade)
export function mouthGeos() {
  const arc = (r, y, flip) => new Builder().torus(r, 0.009, LIP, { y, z: 0.176, rz: flip ? Math.PI : 0 }, Math.PI, 14).build();
  return {
    mN: new Builder().caps(0.008, 0.045, LIP, { y: -0.097, z: 0.179, rz: Math.PI / 2 }, 6).build(),
    mS: arc(0.04, -0.062, true),
    mF: arc(0.032, -0.118, false),
  };
}

// Anatomia: tronco, braços e pernas por perfis em seções (ombros arredondados, cintura, coxa, panturrilha e tornozelo),
// vestidos pelo conjunto escolhido. Cada articulação do esqueleto de grupos recebe uma malha própria.
import { Builder, loft, clipSections, scaleSections, sectionAt } from './geometry.js';
import { TORSO, outfitSpec, decorate } from './clothes.js';
import { shade } from './config.js';

// o quadril fica um pouco por dentro do tronco para as duas superfícies não brigarem (z-fighting)
const HIP = [{ y: -0.05, rx: 0.14, rz: 0.105 }, { y: 0.02, rx: 0.166, rz: 0.126 }, { y: 0.12, rx: 0.16, rz: 0.125 }, { y: 0.17, rx: 0.145, rz: 0.115 }];
const SKIRT = [{ y: 0.06, rx: 0.165, rz: 0.125 }, { y: -0.02, rx: 0.21, rz: 0.165 }, { y: -0.14, rx: 0.285, rz: 0.228 }];

const tube = (pts, k = 1, bow = 0) => pts.map(([y, r, cz = 0]) => ({ y, rx: r * k, rz: r * k, cz: cz * bow }));
const UPPER = [[0.015, 0.05], [0, 0.062], [-0.08, 0.061], [-0.16, 0.054], [-0.225, 0.05]];
const FORE = [[0.01, 0.052], [-0.05, 0.05], [-0.12, 0.045], [-0.2, 0.041, 0.012]];

// tronco + pescoço + quadril + roupa de cima (e saia)
export function torsoGeo(cfg) {
  const o = outfitSpec(cfg), B = new Builder();
  B.cyl(0.062, 0.07, 0.1, cfg.skin, { y: 0.625 }, 12); // pescoço
  B.add(loft(HIP, { round: true, seg: 18 }), cfg.pants);
  if (o.vest) { // camisa por baixo e colete por cima (a camisa aparece nos ombros)
    B.add(loft(clipSections(TORSO, o.hem), { seg: 20 }), o.color);
    const vest = [...clipSections(TORSO, 0.09, 0.46), { y: 0.5, rx: 0.17, rz: 0.125, cz: 0.01 }, { y: 0.54, rx: 0.1, rz: 0.08 }];
    B.add(loft(scaleSections(vest, 1.045), { seg: 20 }), cfg.shirt);
  } else {
    B.add(loft(scaleSections(clipSections(TORSO, o.hem), o.scale), { seg: 20 }), o.color);
  }
  if (o.band) { // barra de ribana
    const a = sectionAt(TORSO, o.hem), b = sectionAt(TORSO, o.hem + o.bandH), k = o.scale + 0.012;
    B.add(loft([{ y: o.hem, rx: a.rx * k, rz: a.rz * k, cz: a.cz * k }, { y: o.hem + o.bandH, rx: b.rx * k, rz: b.rz * k, cz: b.cz * k }], { seg: 20 }), o.band);
  }
  if (o.skirt) {
    B.add(loft(SKIRT, { seg: 22 }), cfg.skirt);
    B.add(loft([{ y: -0.14, rx: 0.289, rz: 0.232 }, { y: -0.115, rx: 0.27, rz: 0.215 }], { seg: 22 }), shade(cfg.skirt, -0.25));
  }
  decorate(B, cfg, o);
  return B.build();
}

// braço: parte do ombro (ombro + braço) e parte do cotovelo (cotovelo + antebraço + punho + mão). side: -1 esquerdo, 1 direito
export function armGeos(cfg, side) {
  const o = outfitSpec(cfg), k = o.sleeveK;
  const up = new Builder(), lo = new Builder();
  up.sph(0.064 * k, o.sleeve, { y: 0 }, 14, 10); // ombro: raio igual ao do braço, sem virar manga bufante
  up.add(loft(tube(UPPER, k), { seg: 14, round: true }), o.sleeve);
  lo.sph(0.05 * k, o.sleeve, { y: 0 }, 12, 8); // cotovelo discreto
  lo.add(loft(tube(FORE, k, 1), { seg: 14 }), o.sleeve);
  const wy = -0.2; // punho
  lo.add(loft([{ y: wy - o.cuffH, rx: 0.046 * k, rz: 0.046 * k, cz: 0.012 }, { y: wy + 0.005, rx: 0.048 * k, rz: 0.048 * k, cz: 0.012 }], { seg: 14 }), o.cuff);
  lo.sph(0.062, cfg.skin, { y: -0.238, z: 0.012, sy: 0.92 }, 14, 10); // mão arredondada
  lo.sph(0.024, cfg.skin, { x: -side * 0.048, y: -0.225, z: 0.04 }, 8, 6); // polegar
  return { up: up.build(), lo: lo.build() };
}

// perna: coxa (no quadril) e canela com sapato (no joelho)
export function legGeos(cfg) {
  const o = outfitSpec(cfg), cl = o.skirt ? cfg.skin : cfg.pants;
  const th = new Builder(), sh = new Builder();
  th.add(loft(tube([[0.03, 0.078], [0, 0.088], [-0.1, 0.083], [-0.19, 0.07], [-0.235, 0.066]]), { seg: 14, round: true }), cl);
  sh.sph(0.067, cl, { y: 0 }, 12, 8);
  sh.add(loft([{ y: 0.01, rx: 0.066, rz: 0.066 }, { y: -0.07, rx: 0.066, rz: 0.071 }, { y: -0.17, rx: 0.052, rz: 0.054 }, { y: -0.25, rx: 0.043, rz: 0.044 }], { seg: 14 }), cl);
  sh.sph(0.1, cfg.shoe, { y: -0.285, z: 0.04, sx: 0.95, sy: 0.68, sz: 1.55 }, 14, 10);
  sh.box(0.17, 0.035, 0.3, cfg.shoe === '#f4f1ea' ? '#2a2f3e' : '#17131a', { y: -0.325, z: 0.045 }, 0.012);
  return { th: th.build(), sh: sh.build() };
}

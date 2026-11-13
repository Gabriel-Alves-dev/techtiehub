// Cabelo: calota de base, mechas de ponta arredondada que acompanham o couro cabeludo (com volume) e, no cabelo longo,
// uma massa lisa atrás da cabeça (como no protótipo D2) com mechas só para emoldurar o rosto. Com boné, só aparece o
// que fica abaixo dele.
import * as THREE from '../vendor/three.module.min.js';
import { strandGeo, loft, quality } from './geometry.js';
import { shade } from './config.js';

const R = 0.21; // raio do crânio (unidades da cabeça)
// ponto no couro cabeludo: az gira em volta (0 = frente, π = nuca), el vai de -π/2 (baixo) a π/2 (topo)
const sp = (az, el, off = 0) => [(R + off) * Math.sin(az) * Math.cos(el), (R * 1.02 + off) * Math.sin(el), (R * 0.98 + off) * Math.cos(az) * Math.cos(el)];
const lerp = (a, b, t) => a + (b - a) * t;
const rng = (seed) => { let s = seed || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); };

// linha do cabelo: até onde a mecha desce, conforme a direção (testa, laterais, nuca)
function hairline(az, nape) {
  const c = Math.cos(az);
  if (c > 0.35) return 0.5 + 0.08 * Math.abs(Math.sin(az) * 2); // franja
  if (c > -0.35) return 0.1; // laterais, acima da orelha
  return nape;
}

// B: peças com contorno (calota, massa, coque); F: peças sem contorno (mechas), para não riscar o cabelo de preto
export function addHair(B, F, cfg, rand = rng(7)) {
  const hat = cfg.accessory === 'bone';
  const col = () => shade(cfg.hair, (rand() - 0.5) * 0.1);
  const strand = (pts, o) => F.add(strandGeo(pts, { seg: 6, rings: 7, blunt: 0.28, ...o }), col());
  const style = cfg.hairStyle;

  if (!hat) {
    B.add(new THREE.SphereGeometry(R + 0.012, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.56), cfg.hair, { sy: 1.02, rx: -0.3 }); // calota
    // mechas da coroa até a linha do cabelo, com volume no meio do caminho e franja varrida para o lado
    const n = Math.round((style === 'curto' ? 30 : 24) * quality.k), nape = style === 'longo' ? -0.05 : -0.18;
    for (let i = 0; i < n; i++) {
      const az = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.15, end = hairline(az, nape) + (rand() - 0.5) * 0.08;
      const front = Math.cos(az) > 0.35, sweep = front ? 0.35 : 0.05;
      const pts = [0, 0.3, 0.62, 1].map((t, j) => sp(az + sweep * t, lerp(1.4, end, t), [0.006, 0.026, 0.03, 0.012][j]));
      strand(pts, { w: 0.05, d: 0.026, taper: 1.6 });
    }
  }
  // costeletas
  for (const sg of [-1, 1]) strand([sp(sg * 1.5, 0.35, 0.004), sp(sg * 1.5, 0.05, 0.022), sp(sg * 1.5, -0.2, 0.01)], { w: 0.032, d: 0.022 });

  if (style === 'curto') {
    if (!hat) for (let i = 0; i < 6; i++) { // topete
      const az = -0.7 + i * 0.32, p0 = sp(az, 1.25, 0.02), p1 = sp(az + 0.12, 1.45, 0.05);
      strand([p0, p1, [p1[0] * 1.2, p1[1] + 0.025, p1[2] * 1.2 - 0.01]], { w: 0.034, d: 0.022, rings: 5 });
    }
  } else if (style === 'longo') {
    // massa lisa atrás da cabeça, do alto até o ombro; com boné começa logo abaixo da aba
    const top = hat ? -0.04 : 0.1;
    const base = [
      { y: -0.34, rx: 0.12, rz: 0.07, cz: -0.125 }, { y: -0.26, rx: 0.16, rz: 0.1, cz: -0.125 }, { y: -0.14, rx: 0.2, rz: 0.125, cz: -0.115 },
      { y: -0.02, rx: 0.215, rz: 0.13, cz: -0.095 },
    ];
    B.add(loft([...base.filter((s) => s.y < top), { y: top, rx: 0.2, rz: 0.11, cz: -0.08 }], { seg: 18, round: true }), cfg.hair);
    for (const sg of [-1, 1]) for (const k of [0, 1]) { // mechas que emolduram o rosto
      const az = sg * (1.3 + k * 0.18), e = sp(az, -0.22, 0.04);
      strand([sp(az, hat ? 0.0 : 0.5, 0.012), sp(az, 0.1, 0.034), sp(az, -0.1, 0.04), [e[0], -0.25 - k * 0.02, e[2] * 0.8]], { w: 0.05, d: 0.03, rings: 8, taper: 1.3 });
    }
  } else { // coque
    if (hat) strand([sp(Math.PI, -0.05, 0.012), sp(Math.PI, -0.2, 0.04), sp(Math.PI, -0.3, 0.03)], { w: 0.05, d: 0.03 });
    else {
      B.sph(0.085, cfg.hair, { y: 0.255, z: -0.12, sy: 0.9 }, 14, 10);
      F.torus(0.07, 0.02, shade(cfg.hair, 0.18), { y: 0.255, z: -0.12, rx: Math.PI / 2 + 0.4 }, Math.PI * 2, 14);
      for (let i = 0; i < 6; i++) { // mechas que sobem da nuca até o coque
        const az = Math.PI + (i - 2.5) * 0.28;
        strand([sp(az, -0.1, 0.012), sp(az, 0.5, 0.03), [0, 0.2, -0.17], [0, 0.25, -0.12]], { w: 0.04, d: 0.024, rings: 6 });
      }
    }
  }
}

// Cabelo: calota de base, mechas de ponta arredondada que acompanham o couro cabeludo e, no cabelo longo, uma massa lisa
// atrás da cabeça (como no protótipo D2) com mechas só para emoldurar o rosto. O volume varia por região (topo cheio,
// laterais rentes, nuca curta), a linha do cabelo é irregular e a franja é repartida para um lado; cada agente tem a sua
// semente, então dois agentes com o mesmo penteado não ficam idênticos. Com boné, só aparece o que fica abaixo dele.
import * as THREE from '../vendor/three.module.min.js';
import { strandGeo, loft, quality } from './geometry.js';
import { shade, hash } from './config.js';

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
export function addHair(B, F, cfg, rand = rng(hash(cfg.hair + cfg.hairStyle + cfg.skin + cfg.shirt, 37) + 1)) {
  const hat = cfg.accessory === 'bone';
  const col = () => shade(cfg.hair, (rand() - 0.5) * 0.12);
  const strand = (pts, o) => F.add(strandGeo(pts, { seg: 6, rings: 7, blunt: 0.28, ...o }), col());
  const style = cfg.hairStyle;
  const side = rand() < 0.5 ? -1 : 1; // lado da repartição
  const short = style === 'curto';

  if (!hat) {
    B.add(new THREE.SphereGeometry(R + 0.012, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.46), cfg.hair, { sy: 1.02, rx: -0.5 }); // calota: a borda da frente fica acima das sobrancelhas
    const n = Math.round((short ? 26 : 22) * quality.k), nape = style === 'longo' ? -0.05 : short ? -0.1 : -0.18;
    for (let i = 0; i < n; i++) {
      const az = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.2, c = Math.cos(az), sd = Math.abs(Math.sin(az));
      if (c > 0.45) continue; // a franja é feita à parte, abaixo
      const end = hairline(az, nape) + (rand() - 0.5) * 0.18; // linha do cabelo irregular
      // volume por região: topo e coroa cheios, laterais rentes (tempora), nuca curta
      const vol = (short ? 0.034 : 0.03) * (1 - sd * 0.75) + 0.008;
      const top = lerp(1.22, 1.5, rand());
      const pts = [0, 0.3, 0.62, 1].map((t, j) => sp(az + side * 0.12 * t, lerp(top, end, t), [0.006, vol * 0.8, vol, 0.01][j]));
      strand(pts, { w: lerp(0.036, 0.06, rand()), d: 0.026, taper: 1.5 });
    }
    // franja repartida: poucas mechas largas varridas para o lado, de comprimentos e alturas diferentes
    const fr = short ? 6 : 5;
    for (let i = 0; i < fr; i++) {
      const t = i / (fr - 1), az = side * (0.15 - t * 0.9) + (rand() - 0.5) * 0.12, e = (short ? 0.66 : 0.6) + rand() * 0.12 + (1 - t) * 0.04; // termina acima das sobrancelhas
      const pts = [0, 0.35, 0.7, 1].map((u, j) => sp(az + side * (0.5 + t * 0.6) * u, lerp(1.35, e, u), [0.008, 0.032, 0.034, 0.02][j]));
      strand(pts, { w: lerp(0.05, 0.04, t), d: 0.028, rings: 6, taper: 1.3 });
    }
    // tufo de volume no lado da repartição: quebra a silhueta redonda
    F.add(new THREE.SphereGeometry(0.075, 12, 8), cfg.hair, { x: side * 0.06, y: 0.205, z: 0.06, sx: 1.25, sy: 0.62, sz: 1.05, rz: side * -0.35 });
  }
  // costeletas
  for (const sg of [-1, 1]) strand([sp(sg * 1.5, 0.35, 0.004), sp(sg * 1.5, 0.05, 0.02), sp(sg * 1.5, hat ? -0.3 : -0.12 - rand() * 0.1, 0.01)], { w: 0.03, d: 0.02 });

  if (short) {
    if (!hat) for (let i = 0; i < 5; i++) { // topete: mechas que sobem e caem para o lado, em alturas diferentes
      const az = -0.55 + i * 0.3 + (rand() - 0.5) * 0.1, p0 = sp(az, 1.2, 0.02), p1 = sp(az + side * 0.18, 1.42 + rand() * 0.1, 0.05 + rand() * 0.015);
      strand([p0, p1, [p1[0] * 1.15 + side * 0.02, p1[1] + 0.015 + rand() * 0.015, p1[2] * 1.15 - 0.005]], { w: lerp(0.032, 0.044, rand()), d: 0.022, rings: 5 });
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

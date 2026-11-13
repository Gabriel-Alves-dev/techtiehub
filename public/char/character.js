// Personagem completo: monta a hierarquia de grupos (corpo, cabeça, ombros, cotovelos, quadris, joelhos) com as malhas
// de body.js e face.js. Devolve o mesmo contrato do boneco clássico (userData com body, head, L, R, LL, RL, eyes, brows,
// mN, mS, mF, hit), então o office3d.js anima os dois do mesmo jeito.
import * as THREE from '../vendor/three.module.min.js';
import { normalizeConfig } from './config.js';
import { torsoGeo, armGeos, legGeos } from './body.js';
import { headGeo, eyeGeo, browGeo, mouthGeos } from './face.js';
import { outlineGeo, quality } from './geometry.js';
import { acquireGeos, releaseGeos, charMaterial, outlineMaterial } from './resources.js';

export const HEAD_S = 1.25, HEAD_Y = 0.92;
const limbOutlines = () => quality.k >= 0.8;
const LINE = 0.009; // espessura do contorno em unidades do corpo (constante, por deslocamento nas normais)

// todas as geometrias de um visual (compartilhadas por quem tem a mesma configuração)
// peças iguais para todos os agentes (olho e bocas): uma geometria só na GPU, não importa quantos personagens existam
const constKey = () => 'const|' + quality.k;
const makeConst = () => ({ eye: eyeGeo(), ...mouthGeos() });

// nível de detalhe (1 = completo; ~0.6 no celular). Vale para os personagens criados depois da chamada.
export const setCharQuality = (k) => { quality.k = Math.max(0.4, Math.min(1, k)); };

function makeGeos(cfg) {
  const hg = headGeo(cfg);
  const out = { torso: torsoGeo(cfg), head: hg.head, hair: hg.free, brow: browGeo(cfg) };
  const L = armGeos(cfg, -1), R = armGeos(cfg, 1), leg = legGeos(cfg);
  Object.assign(out, { upL: L.up, loL: L.lo, upR: R.up, loR: R.lo, th: leg.th, sh: leg.sh });
  // contorno nos membros só em detalhe alto: no celular ele dobra as chamadas de desenho e os triângulos dos braços e pernas
  for (const k of limbOutlines() ? ['torso', 'upL', 'loL', 'upR', 'loR', 'th', 'sh'] : ['torso']) out[k + 'O'] = outlineGeo(out[k], LINE);
  out.headO = outlineGeo(out.head, LINE / HEAD_S);
  return out;
}

export function buildCharacter(a) {
  const cfg = normalizeConfig(a);
  const G = { ...acquireGeos(cfg.key, () => makeGeos(cfg)), ...acquireGeos(constKey(), makeConst) };
  const mat = charMaterial(), line = outlineMaterial();

  const part = (parent, geo, outline, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(G[geo], mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    if (outline && G[geo + 'O']) { const o = new THREE.Mesh(G[geo + 'O'], line); o.userData.outline = true; m.add(o); }
    parent.add(m);
    return m;
  };
  const small = (parent, geo, x, y, z) => { // olhos, sobrancelhas e bocas: sem contorno nem sombra
    const m = new THREE.Mesh(G[geo], mat); m.position.set(x, y, z); parent.add(m);
    return m;
  };

  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  part(body, 'torso', true);

  const head = new THREE.Group(); head.position.y = HEAD_Y; head.scale.setScalar(HEAD_S); body.add(head);
  part(head, 'head', true);
  const hair = new THREE.Mesh(G.hair, mat); hair.castShadow = true; head.add(hair); // mechas, nariz, bochechas e acessórios finos: sem contorno
  const eyes = [-1, 1].map((sg) => {
    const g = new THREE.Group(); g.position.set(sg * 0.082, -0.005, 0.182); g.rotation.y = sg * 0.4; head.add(g);
    small(g, 'eye', 0, 0, 0);
    return g;
  });
  const browY = 0.095;
  const brows = [-1, 1].map((sg) => small(head, 'brow', sg * 0.085, browY, 0.166));
  const mN = small(head, 'mN', 0, 0, 0), mS = small(head, 'mS', 0, 0, 0), mF = small(head, 'mF', 0, 0, 0);
  mS.visible = false; mF.visible = false;

  const mkArm = (side) => {
    const sh = new THREE.Group(); sh.position.set(side * 0.235, 0.52, 0); body.add(sh);
    const s = side < 0 ? 'L' : 'R';
    part(sh, 'up' + s, true);
    const el = new THREE.Group(); el.position.y = -0.22; sh.add(el);
    part(el, 'lo' + s, true);
    return { sh, el };
  };
  const L = mkArm(-1), R = mkArm(1);
  const mkLeg = (side) => {
    const hp = new THREE.Group(); hp.position.set(side * 0.1, 0, 0); body.add(hp);
    part(hp, 'th', true);
    const kn = new THREE.Group(); kn.position.y = -0.22; hp.add(kn);
    part(kn, 'sh', true);
    return { hp, kn };
  };
  const LL = mkLeg(-1), RL = mkLeg(1);

  // área de clique
  const hit = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.9, 0.8), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 0.95; root.add(hit);
  hit.userData = { kind: 'agent', id: a.id };

  root.scale.setScalar(1.22);
  root.userData = { style: 'novo', cres: cfg.key, cconst: constKey(), body, head, headY: HEAD_Y, browY, L, R, LL, RL, sitk: 0, moveK: 0, rot: 0, hit, eyes, brows, mN, mS, mF };
  return root;
}

// devolve as geometrias do personagem (só descarta as que ninguém mais usa)
export function releaseCharacter(g) {
  if (g.userData.cres) { releaseGeos(g.userData.cres); releaseGeos(g.userData.cconst); }
  g.userData.cres = null;
}

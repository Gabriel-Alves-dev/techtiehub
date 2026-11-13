// Geometrias procedurais dos personagens: construtor que junta várias peças numa malha só (cor por vértice),
// perfis em seções (loft) para tronco, braços e pernas, tubos ao longo de curvas (mechas) e contorno por normais.
import * as THREE from '../vendor/three.module.min.js';

// nível de detalhe: 1 = completo; menor (celular) reduz segmentos das malhas e a quantidade de mechas
export const quality = { k: 1 };
export const qs = (n, min = 6) => Math.max(min, Math.round(n * quality.k));

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

// junta peças numa BufferGeometry com position, normal e color. t = { x, y, z, rx, ry, rz, sx, sy, sz }
export class Builder {
  constructor() { this.parts = []; }
  add(geo, color, t = {}) {
    const g = geo.clone();
    _p.set(t.x || 0, t.y || 0, t.z || 0);
    _q.setFromEuler(_e.set(t.rx || 0, t.ry || 0, t.rz || 0));
    _s.set(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
    g.applyMatrix4(_m.compose(_p, _q, _s));
    const c = new THREE.Color(color), n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    g.deleteAttribute('uv');
    if (!g.index) g.setIndex([...Array(n).keys()]);
    this.parts.push(g);
    geo.dispose();
    return this;
  }
  // atalhos
  sph(r, color, t, w = 14, h = 10) { return this.add(new THREE.SphereGeometry(r, qs(w), qs(h, 4)), color, t); }
  box(w, h, d, color, t, r = 0.012) { return this.add(roundedBox(w, h, d, r), color, t); }
  cyl(r1, r2, h, color, t, seg = 14) { return this.add(new THREE.CylinderGeometry(r1, r2, h, qs(seg)), color, t); }
  caps(r, len, color, t, seg = 8) { return this.add(new THREE.CapsuleGeometry(r, len, 4, seg), color, t); }
  torus(r, tube, color, t, arc = Math.PI * 2, seg = 14) { return this.add(new THREE.TorusGeometry(r, tube, qs(6, 4), qs(seg), arc), color, t); }
  build() {
    const pos = [], nor = [], col = [], idx = [];
    let off = 0;
    for (const g of this.parts) {
      for (const v of g.attributes.position.array) pos.push(v);
      for (const v of g.attributes.normal.array) nor.push(v);
      for (const v of g.attributes.color.array) col.push(v);
      for (const i of g.index.array) idx.push(i + off);
      off += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    out.setIndex(idx);
    out.computeBoundingSphere();
    return out;
  }
}

// caixa de quinas arredondadas
export function roundedBox(w, h, d, r) {
  const rr = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  const g = new THREE.BoxGeometry(w, h, d, 3, 3, 3), p = g.attributes.position, v = new THREE.Vector3();
  const ix = w / 2 - rr, iy = h / 2 - rr, iz = d / 2 - rr;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const cx = Math.max(-ix, Math.min(ix, v.x)), cy = Math.max(-iy, Math.min(iy, v.y)), cz = Math.max(-iz, Math.min(iz, v.z));
    const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz, l = Math.hypot(dx, dy, dz);
    if (l > 0) p.setXYZ(i, cx + (dx / l) * rr, cy + (dy / l) * rr, cz + (dz / l) * rr);
  }
  g.computeVertexNormals();
  return g;
}

// seção interpolada em uma altura y, para colar faixas e golas na peça
export function sectionAt(secs, y) {
  if (y <= secs[0].y) return { cx: 0, cz: 0, ...secs[0], y };
  for (let i = 1; i < secs.length; i++) {
    if (y <= secs[i].y) {
      const a = secs[i - 1], b = secs[i], k = (y - a.y) / (b.y - a.y || 1);
      const mix = (u, v) => (u || 0) + ((v || 0) - (u || 0)) * k;
      return { y, rx: mix(a.rx, b.rx), rz: mix(a.rz, b.rz), cx: mix(a.cx, b.cx), cz: mix(a.cz, b.cz) };
    }
  }
  return { cx: 0, cz: 0, ...secs[secs.length - 1] };
}

// recorta as seções abaixo de yMin e acima de yMax, com uma seção interpolada em cada corte
export function clipSections(secs, yMin, yMax = Infinity) {
  const out = [sectionAt(secs, yMin), ...secs.filter((s) => s.y > yMin && s.y < yMax)];
  if (yMax < secs[secs.length - 1].y) out.push(sectionAt(secs, yMax));
  return out;
}

export const scaleSections = (secs, k, kz = k) => secs.map((s) => ({ ...s, rx: s.rx * k, rz: s.rz * kz, cx: (s.cx || 0) * k, cz: (s.cz || 0) * kz }));

// superfície por seções elípticas (de baixo para cima). round: fecha as pontas arredondadas; senão, tampa reta.
// Seção: { y, rx, rz, cx?, cz? }; o ângulo 0 aponta para +z (frente do personagem).
export function loft(secs, { seg: segIn = 18, round = false } = {}) {
  const seg = qs(segIn, 8);
  let s = secs.map((q) => ({ cx: 0, cz: 0, ...q })).sort((p, q) => p.y - q.y); // sempre de baixo para cima (orienta as faces para fora)
  if (round) {
    const a = s[0], b = s[s.length - 1], ra = Math.max(a.rx, a.rz), rb = Math.max(b.rx, b.rz);
    s = [
      { ...a, y: a.y - ra * 0.55, rx: a.rx * 0.3, rz: a.rz * 0.3 }, { ...a, y: a.y - ra * 0.28, rx: a.rx * 0.8, rz: a.rz * 0.8 }, ...s,
      { ...b, y: b.y + rb * 0.28, rx: b.rx * 0.8, rz: b.rz * 0.8 }, { ...b, y: b.y + rb * 0.55, rx: b.rx * 0.3, rz: b.rz * 0.3 },
    ];
  }
  const pos = [], idx = [], n = s.length;
  for (const q of s) for (let i = 0; i < seg; i++) { const t = (i / seg) * Math.PI * 2; pos.push(q.cx + q.rx * Math.sin(t), q.y, q.cz + q.rz * Math.cos(t)); }
  for (let r = 0; r < n - 1; r++) for (let i = 0; i < seg; i++) {
    const a = r * seg + i, b = r * seg + ((i + 1) % seg), c = (r + 1) * seg + i, d = (r + 1) * seg + ((i + 1) % seg);
    idx.push(a, b, c, b, d, c);
  }
  const bot = pos.length / 3; pos.push(s[0].cx, s[0].y, s[0].cz);
  const top = bot + 1; pos.push(s[n - 1].cx, s[n - 1].y, s[n - 1].cz);
  for (let i = 0; i < seg; i++) {
    idx.push((i + 1) % seg, i, bot);
    idx.push((n - 1) * seg + i, (n - 1) * seg + ((i + 1) % seg), top);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// tubo ao longo de uma lista de pontos, com raiz larga e ponta afunilada (w e d: raios na raiz)
// blunt: largura da ponta em relação à raiz (0 = agulha; ~0.25 = ponta arredondada, como mecha de verdade)
export function strandGeo(points, { w = 0.03, d = 0.02, seg = 6, rings = 9, taper = 1.2, blunt = 0 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
  const pos = [], idx = [];
  const tan = new THREE.Vector3(), nrm = new THREE.Vector3(), bin = new THREE.Vector3(), pt = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), SIDE = new THREE.Vector3(1, 0, 0);
  for (let r = 0; r <= rings; r++) {
    const u = r / rings;
    curve.getPointAt(u, pt); curve.getTangentAt(u, tan);
    nrm.crossVectors(Math.abs(tan.dot(UP)) > 0.92 ? SIDE : UP, tan).normalize();
    bin.crossVectors(tan, nrm).normalize();
    let k = (blunt + (1 - blunt) * Math.pow(1 - u, 1 / taper)) * (0.6 + 0.4 * Math.min(1, u * 6 + 0.3));
    if (r === rings && blunt > 0) k *= 0.5; // fecha a ponta arredondada
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, cn = Math.cos(a) * w * k, cb = Math.sin(a) * d * k;
      pos.push(pt.x + nrm.x * cn + bin.x * cb, pt.y + nrm.y * cn + bin.y * cb, pt.z + nrm.z * cn + bin.z * cb);
    }
  }
  for (let r = 0; r < rings; r++) for (let i = 0; i < seg; i++) {
    const a = r * seg + i, b = r * seg + ((i + 1) % seg), c = (r + 1) * seg + i, e = (r + 1) * seg + ((i + 1) % seg);
    idx.push(a, c, b, b, c, e);
  }
  const root = pos.length / 3; curve.getPointAt(0, pt); pos.push(pt.x, pt.y, pt.z);
  for (let i = 0; i < seg; i++) idx.push(i, (i + 1) % seg, root);
  if (blunt > 0) { const tip = pos.length / 3; curve.getPointAt(1, pt); pos.push(pt.x, pt.y, pt.z); for (let i = 0; i < seg; i++) idx.push(rings * seg + i, tip, rings * seg + ((i + 1) % seg)); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// contorno: cópia da malha com cada vértice empurrado pela normal média (vértices na mesma posição são soldados).
// Dá espessura visual constante, ao contrário de escalar a malha inteira.
export function outlineGeo(geo, thick) {
  const p = geo.attributes.position, n = geo.attributes.normal, sum = new Map(), keys = [];
  for (let i = 0; i < p.count; i++) {
    const key = Math.round(p.getX(i) * 2000) + ',' + Math.round(p.getY(i) * 2000) + ',' + Math.round(p.getZ(i) * 2000);
    keys.push(key);
    const s = sum.get(key) || [0, 0, 0];
    s[0] += n.getX(i); s[1] += n.getY(i); s[2] += n.getZ(i);
    sum.set(key, s);
  }
  const out = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const s = sum.get(keys[i]), l = Math.hypot(s[0], s[1], s[2]) || 1;
    out[i * 3] = p.getX(i) + (s[0] / l) * thick; out[i * 3 + 1] = p.getY(i) + (s[1] / l) * thick; out[i * 3 + 2] = p.getZ(i) + (s[2] / l) * thick;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.setIndex(geo.index);
  return g;
}

// polígono extrudido fino e centrado em z (gravata, peitilho em V)
export function plate(points, depth) {
  const sh = new THREE.Shape(); points.forEach(([x, y], i) => (i ? sh.lineTo(x, y) : sh.moveTo(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return g;
}

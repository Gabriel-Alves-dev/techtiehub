// Recursos compartilhados dos personagens: geometrias com contagem de referências e o material único.
// Quem cria um personagem pega (acquire) e, ao removê-lo, devolve (release). Só quando ninguém mais usa o conjunto
// é que ele é descartado na GPU, então remover um agente nunca invalida o que outro ainda desenha.
import * as THREE from '../vendor/three.module.min.js';

const geoCache = new Map(); // chave -> { value, refs }

// pega o conjunto de geometrias de uma chave (cria na primeira vez)
export function acquireGeos(key, make) {
  let e = geoCache.get(key);
  if (!e) { e = { value: make(), refs: 0 }; geoCache.set(key, e); }
  e.refs++;
  return e.value;
}

export function releaseGeos(key) {
  const e = geoCache.get(key);
  if (!e || --e.refs > 0) return;
  geoCache.delete(key);
  for (const g of Object.values(e.value)) (Array.isArray(g) ? g : [g]).forEach((x) => x?.dispose?.());
}

export const cacheSize = () => geoCache.size;

// material único de tudo o que usa cor por vértice (pele, roupa, cabelo). Compartilhado e nunca descartado.
let bodyMat = null;
export function charMaterial() {
  if (bodyMat) return bodyMat;
  const grad = new THREE.DataTexture(new Uint8Array([120, 195, 255]), 3, 1, THREE.RedFormat);
  grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
  bodyMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: grad });
  return bodyMat;
}

// contorno: casca com as costas visíveis, deslocada pelas normais (espessura constante)
let lineMat = null;
export const outlineMaterial = () => (lineMat ??= new THREE.MeshBasicMaterial({ color: '#1b1424', side: THREE.BackSide }));

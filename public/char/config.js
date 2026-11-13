// Normaliza os dados que o app.js manda de cada agente numa configuração completa do personagem.
//
// Personalização explícita (todos os campos são opcionais e podem vir soltos no agente ou dentro de `look`):
//   outfit  'moletom' | 'blazer' | 'cardigan' | 'bomber' | 'colete'
//   shirt   cor principal da roupa        second  cor secundária (golas, punhos, lapelas, barras)
//   shoe    cor do calçado                pants / skirt / tie  cores da calça, da saia e da gravata
//   skin, hair, hairStyle ('curto' | 'longo' | 'coque'), accessory ('oculos' | 'bone' | 'fone')
// O que faltar é completado de forma estável a partir do id, então agentes sem configuração continuam iguais a cada
// carregamento. Valores inválidos (conjunto desconhecido, cor malformada) caem no mesmo padrão em vez de quebrar.
import * as THREE from '../vendor/three.module.min.js';
import { quality } from './geometry.js';

export const OUTFITS = ['moletom', 'blazer', 'cardigan', 'bomber', 'colete'];
const PANTS = ['#2f3550', '#3b3b44', '#4a3b2e', '#2c4a52'];
const SKIRTS = ['#3a3f5c', '#5a3a3a', '#2f4a45', '#4a4a52'];
const TIES = ['#c0392b', '#2f6fb5', '#7a3b8f', '#e0a43a'];
const HAIR_STYLES = ['curto', 'longo', 'coque'];
const ACCESSORIES = ['oculos', 'bone', 'fone'];

export const hash = (id, m) => [...String(id)].reduce((h, c) => (h * m + c.charCodeAt(0)) % 9973, 7);
const HEX = /^#[0-9a-f]{6}$/i;
const color = (v, fallback) => (typeof v === 'string' && HEX.test(v) ? v : fallback);

// clareia (k > 0) ou escurece (k < 0) uma cor
export function shade(hex, k) {
  const c = new THREE.Color(hex);
  return '#' + (k > 0 ? c.lerp(new THREE.Color('#ffffff'), k) : c.multiplyScalar(1 + k)).getHexString();
}

export function normalizeConfig(agent) {
  const a = { ...agent, ...(agent.look || {}) }; // `look` tem prioridade sobre os campos soltos
  const h = hash(a.id, 31);
  const outfit = OUTFITS.includes(a.outfit) ? a.outfit : OUTFITS[h % OUTFITS.length];
  const cfg = {
    outfit,
    skin: color(a.skin, '#f1c7a0'),
    shirt: color(a.shirt, '#4f8cff'), // cor principal da roupa
    hair: color(a.hair, '#3b2416'),
    hairStyle: HAIR_STYLES.includes(a.hairStyle) ? a.hairStyle : HAIR_STYLES[hash(a.id, 17) % 3],
    accessory: ACCESSORIES.includes(a.accessory) ? a.accessory : null,
    pants: color(a.pants, PANTS[hash(a.id, 7) % PANTS.length]),
    skirt: color(a.skirt, SKIRTS[hash(a.id, 11) % SKIRTS.length]),
    tie: color(a.tie, TIES[hash(a.id, 13) % TIES.length]),
  };
  cfg.second = color(a.second, shade(cfg.shirt, -0.22)); // cor secundária: golas, punhos, lapelas
  // calçado: sapato social com roupa formal, tênis branco com roupa casual
  cfg.shoe = color(a.shoe, outfit === 'blazer' || outfit === 'colete' || outfit === 'cardigan' ? '#2b2024' : '#f4f1ea');
  // a chave identifica o visual (e o nível de detalhe): quem tem a mesma chave compartilha as geometrias
  cfg.key = JSON.stringify([cfg.outfit, cfg.skin, cfg.shirt, cfg.second, cfg.hair, cfg.hairStyle, cfg.accessory, cfg.pants, cfg.skirt, cfg.tie, cfg.shoe, quality.k]);
  return cfg;
}

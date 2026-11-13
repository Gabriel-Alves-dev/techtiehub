// Animação do esqueleto de grupos dos personagens (vale para os novos e para os clássicos, que têm o mesmo contrato):
// andar, sentar, digitar, acenar, respirar, piscar, expressão e movimento da cabeça. Só mexe em rotações e posições.

// pose de digitar padrão (a do boneco clássico); o personagem novo traz a sua em u.typePose
const DEF_TYPE = { sh: 0.95, el: 0.9, lean: 0, spread: 0 };
// aceno de "bloqueado": o braço esquerdo sobe para o lado e para cima (-2,5 rad a partir de pendurado), fora da cabeça e do monitor,
// e só o antebraço balança; assim o gesto aparece na câmera isométrica, que vê o personagem de costas
const WAVE_Z = -2.5, WAVE_X = -0.3;

// u = g.userData do personagem; ctx = { now, dt, sk (0 a 1: quanto já sentou), hipSit, hipStand }
export function animateRig(u, a, rt, { now, dt, sk, hipSit, hipStand, seatY }) {
  const nl = a.name.length;
  // andar: o corpo quica a cada passo e se inclina para a frente; parado: balança de leve (respirando)
  const walkPh = rt.walk * 0.28;
  const typing = rt.seated && a.status === 'trabalhando';
  const tp = u.typePose || DEF_TYPE;
  u.typeK = (u.typeK || 0) + ((typing ? 1 : 0) - (u.typeK || 0)) * Math.min(1, dt * 8); // transição suave para a pose de digitar
  // standLift e sitDrop acertam a altura do quadril para a perna do modelo: sola no chão em pé e coxa sobre o assento sentado
  // seatFit: o quadril sentado vem da altura real do assento (cadeira, sofá, pufe), e não de um valor fixo
  const hs = hipStand + (u.standLift || 0), hz = u.seatFit && seatY != null ? seatY / u.bodyScale + u.thigh : hipSit - (u.sitDrop || 0);
  u.body.position.y = hs + (hz - hs) * sk + Math.abs(Math.sin(walkPh)) * 0.045 * u.moveK * (1 - sk);
  u.body.rotation.x = 0.1 * u.moveK * (1 - sk) + tp.lean * u.typeK; // ao digitar, o tronco se inclina para o teclado
  u.body.rotation.z = Math.sin(walkPh) * 0.04 * u.moveK * (1 - sk) + Math.sin(now / 1500 + nl) * 0.012 * (1 - u.moveK);

  const sw = Math.sin(walkPh) * 0.7 * u.moveK * (1 - sk);
  const cheer = false; // concluído não levanta os braços: fica sentado em repouso, com a tela de "pronto" acesa
  const wave = rt.seated && a.status === 'bloqueado';
  const wk = u.waveK = (u.waveK || 0) + ((wave ? 1 : 0) - (u.waveK || 0)) * Math.min(1, dt * 8); // entra e sai do aceno suavemente
  // pernas: andando balançam; sentado a coxa vai à frente e a canela desce
  u.LL.hp.rotation.x = sw - 1.5 * sk; u.RL.hp.rotation.x = -sw - 1.5 * sk;
  u.LL.kn.rotation.x = 1.5 * sk + Math.max(0, -sw) * 0.5; u.RL.kn.rotation.x = 1.5 * sk + Math.max(0, sw) * 0.5;
  // braços
  const k = Math.floor(now / 140) % 2;
  const rest = (u.restElbow || 0) * (1 - sk); // em repouso o cotovelo fica levemente dobrado e o braço um pouco afastado do corpo
  u.L.sh.rotation.x = (-sw * 0.8 - (cheer ? 3.0 : 0) - (typing ? tp.sh : sk * 0.7)) * (1 - wk) + WAVE_X * wk;
  u.R.sh.rotation.x = sw * 0.8 - (cheer ? 3.0 : 0) - (typing ? tp.sh : sk * 0.7);
  u.L.el.rotation.x = (-(typing ? tp.el + (k ? 0.12 : 0) : sk * 0.5) - rest) * (1 - wk) - 0.5 * wk;
  u.L.el.rotation.z = Math.sin(now / 140) * 0.5 * wk;
  u.R.el.rotation.x = -(typing ? tp.el + (k ? 0 : 0.12) : sk * 0.5) - rest;
  const spr = (u.restSpread || 0) * (1 - sk) + tp.spread * u.typeK;
  u.L.sh.rotation.z = (cheer ? 0.2 : -spr) * (1 - wk) + WAVE_Z * wk; u.R.sh.rotation.z = cheer ? -0.2 : spr;
  // respiração e humor
  u.head.position.y = u.headY + Math.sin(now / 520 + nl) * 0.007 + Math.abs(Math.sin(walkPh)) * 0.012 * u.moveK;
  // expressão: concluído e ocioso sorriem, bloqueado fica preocupado (sobrancelhas inclinadas, boca para baixo), trabalhando se concentra
  const mood = a.status;
  u.mN.visible = mood === 'trabalhando'; u.mS.visible = mood === 'concluido' || mood === 'ocioso'; u.mF.visible = mood === 'bloqueado';
  const bz = mood === 'bloqueado' ? 0.4 : mood === 'trabalhando' ? -0.12 : 0;
  u.brows[0].rotation.z = bz; u.brows[1].rotation.z = -bz;
  const by = (u.browY ?? 0.095) + (mood === 'concluido' ? 0.012 : mood === 'bloqueado' ? 0.016 : 0);
  u.brows[0].position.y = by; u.brows[1].position.y = by;
  const blink = ((now + nl * 733) % 4200) < 130;
  u.eyes[0].scale.y = u.eyes[1].scale.y = blink ? 0.08 : 1;
  // cabeça: olha para o teclado ao digitar, olha em volta quando está parado
  const look = !rt.moving && !typing ? Math.sin(now / 2100 + nl * 1.7) * 0.25 : 0;
  const hk = Math.min(1, dt * 6);
  u.head.rotation.y += (look - u.head.rotation.y) * hk;
  u.head.rotation.x += ((typing ? 0.2 : mood === 'bloqueado' ? -0.08 : 0) - u.head.rotation.x) * hk;
  u.head.rotation.z += ((cheer ? 0.09 : 0) - u.head.rotation.z) * hk;
}

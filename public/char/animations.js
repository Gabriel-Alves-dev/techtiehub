// Animação do esqueleto de grupos dos personagens (vale para os novos e para os clássicos, que têm o mesmo contrato):
// andar, sentar, digitar, acenar, respirar, piscar, expressão e movimento da cabeça. Só mexe em rotações e posições.

// u = g.userData do personagem; ctx = { now, dt, sk (0 a 1: quanto já sentou), hipSit, hipStand }
export function animateRig(u, a, rt, { now, dt, sk, hipSit, hipStand }) {
  const nl = a.name.length;
  // andar: o corpo quica a cada passo e se inclina para a frente; parado: balança de leve (respirando)
  const walkPh = rt.walk * 0.28;
  u.body.position.y = hipStand + (hipSit - hipStand) * sk + Math.abs(Math.sin(walkPh)) * 0.045 * u.moveK * (1 - sk);
  u.body.rotation.x = 0.1 * u.moveK * (1 - sk);
  u.body.rotation.z = Math.sin(walkPh) * 0.04 * u.moveK * (1 - sk) + Math.sin(now / 1500 + nl) * 0.012 * (1 - u.moveK);

  const sw = Math.sin(walkPh) * 0.7 * u.moveK * (1 - sk);
  const typing = rt.seated && a.status === 'trabalhando';
  const cheer = false; // concluído não levanta os braços: fica sentado em repouso, com a tela de "pronto" acesa
  const wave = rt.seated && a.status === 'bloqueado';
  // pernas: andando balançam; sentado a coxa vai à frente e a canela desce
  u.LL.hp.rotation.x = sw - 1.5 * sk; u.RL.hp.rotation.x = -sw - 1.5 * sk;
  u.LL.kn.rotation.x = 1.5 * sk + Math.max(0, -sw) * 0.5; u.RL.kn.rotation.x = 1.5 * sk + Math.max(0, sw) * 0.5;
  // braços
  const k = Math.floor(now / 140) % 2;
  u.L.sh.rotation.x = -sw * 0.8 - (cheer ? 3.0 : 0) - (typing ? 0.95 : sk * 0.7) - (wave ? 2.6 + Math.sin(now / 120) * 0.2 : 0);
  u.R.sh.rotation.x = sw * 0.8 - (cheer ? 3.0 : 0) - (typing ? 0.95 : sk * 0.7);
  u.L.el.rotation.x = -(typing ? 0.9 + (k ? 0.12 : 0) : sk * 0.5) - (wave ? 0.2 : 0);
  u.R.el.rotation.x = -(typing ? 0.9 + (k ? 0 : 0.12) : sk * 0.5);
  u.L.sh.rotation.z = cheer || wave ? 0.2 : 0; u.R.sh.rotation.z = cheer ? -0.2 : 0;
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

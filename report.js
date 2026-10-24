#!/usr/bin/env node
// Atualiza um agente no Techtie Hub.
// Uso: node report.js <agente> <status> [mensagem] [--projeto <nome>]
// status: trabalhando | ocioso | bloqueado | concluido
const args = process.argv.slice(2);
const pIdx = args.indexOf('--projeto');
const project = pIdx >= 0 ? args.splice(pIdx, 2)[1] : undefined;
const [agent, status, ...msg] = args;

if (!agent || !status) {
  console.error('Uso: node report.js <agente> <status> [mensagem] [--projeto <nome>]');
  process.exit(1);
}

const port = process.env.HUB_PORT || 4321;
fetch(`http://localhost:${port}/api/report`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agent, status, message: msg.join(' '), project }),
})
  .then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    console.log(`${data.name}: ${data.status}${data.message ? ' — ' + data.message : ''}`);
  })
  .catch((e) => {
    console.error('Falha ao reportar:', e.message);
    process.exit(1);
  });

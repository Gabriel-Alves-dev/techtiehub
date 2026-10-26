#!/usr/bin/env node
// Atualiza um agente no Techtie Hub.
// Uso: node report.js <agente> <status> [mensagem] [--projeto <nome>]
// status: trabalhando | ocioso | bloqueado | concluido
// Usa o hub e o token deste PC (~/.techtie-hub/conector.json, criado ao parear o conector).
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const pIdx = args.indexOf('--projeto');
const project = pIdx >= 0 ? args.splice(pIdx, 2)[1] : undefined;
const [agent, status, ...msg] = args;

if (!agent || !status) {
  console.error('Uso: node report.js <agente> <status> [mensagem] [--projeto <nome>]');
  process.exit(1);
}

let config = {};
try {
  config = JSON.parse(fs.readFileSync(process.env.HUB_CONNECTOR_FILE || path.join(os.homedir(), '.techtie-hub', 'conector.json'), 'utf8'));
} catch {}
const hub = (process.env.HUB_URL || config.hub || 'http://localhost:4321').replace(/\/$/, '');

fetch(`${hub}/api/report`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token || ''}` },
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

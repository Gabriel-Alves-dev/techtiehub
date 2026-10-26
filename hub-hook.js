#!/usr/bin/env node
// Hook do Claude Code -> Techtie Hub.
// O Claude Code manda o evento em JSON no stdin; repassamos um resumo para o hub
// configurado neste PC (~/.techtie-hub/conector.json), dizendo de qual PC ele veio.
// Nunca falha nem atrasa o Claude: se o hub estiver desligado, sai em silêncio.
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = path.join(os.homedir(), '.techtie-hub');
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  try {
    const config = readJson(process.env.HUB_CONNECTOR_FILE || path.join(home, 'conector.json'));
    const env = readJson(process.env.HUB_ENV_FILE || path.join(home, 'ambiente.json'));
    const hub = (process.env.HUB_URL || config.hub || `http://localhost:${process.env.HUB_PORT || 4321}`).replace(/\/$/, '');
    const ev = JSON.parse(raw);
    const input = ev.tool_input || {};
    const body = {
      event: ev.hook_event_name,
      cwd: ev.cwd,
      env: env.id,
      session_id: ev.session_id,
      tool_name: ev.tool_name,
      // só o necessário para descrever a ação (sem o conteúdo de arquivos)
      tool_input: {
        file_path: input.file_path || input.notebook_path,
        command: typeof input.command === 'string' ? input.command.slice(0, 120) : undefined,
        description: input.description,
      },
      prompt: typeof ev.prompt === 'string' ? ev.prompt.slice(0, 200) : undefined,
      message: ev.message,
    };
    await fetch(`${hub}/api/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key || ''}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    });
  } catch {}
  process.exit(0);
});

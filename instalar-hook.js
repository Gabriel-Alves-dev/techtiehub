#!/usr/bin/env node
// Instala (ou remove, com --remover) o hook do Techtie Hub no Claude Code do usuário
// (~/.claude/settings.json). Faz backup do arquivo antes de alterar.
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];
const file = path.join(os.homedir(), '.claude', 'settings.json');
const hookPath = path.join(__dirname, 'hub-hook.js').replace(/\\/g, '/');
const command = `node "${hookPath}"`;
const remove = process.argv.includes('--remover');

let settings = {};
if (fs.existsSync(file)) {
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.copyFileSync(file, file + '.bak-techtie');
}

const isOurs = (h) => h.command === command || /hub-hook\.js/.test(h.command || '');
settings.hooks ||= {};
for (const ev of EVENTS) {
  // tira versões antigas do hook (ex.: pasta do hub mudou de lugar) antes de adicionar
  const list = (settings.hooks[ev] || [])
    .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((m) => m.hooks.length);
  if (!remove) {
    const hooks = [{ type: 'command', command, timeout: 5 }];
    list.push(ev === 'PreToolUse' ? { matcher: '*', hooks } : { hooks });
  }
  if (list.length) settings.hooks[ev] = list;
  else delete settings.hooks[ev];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
console.log(remove ? `Hook removido de ${file}` : `Hook instalado em ${file}\nComando: ${command}`);

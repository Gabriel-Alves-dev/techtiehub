// Operações que só fazem sentido no PC do usuário (rodam no conector, nunca no hub):
// conferir pastas, abrir o seletor de pastas do Windows, abrir Explorer/VS Code.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const git = require('./git');

function isDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Pasta digitada/escolhida → caminho absoluto + remote do git (para o hub conferir o repositório).
async function folderInfo(folder) {
  const clean = String(folder || '').trim().replace(/^"(.*)"$/, '$1');
  if (!clean) return { exists: false };
  const abs = path.resolve(clean);
  if (!isDir(abs)) return { exists: false, folder: abs };
  return { exists: true, folder: abs, remote: await git.remote(abs) };
}

function openFolder(folder, app) {
  if (!isDir(folder)) throw new Error('a pasta não existe neste PC');
  const opts = { cwd: folder, detached: true, stdio: 'ignore', windowsHide: true };
  if (app === 'vscode') spawn('cmd.exe', ['/c', 'code', '.'], opts).unref();
  else spawn('explorer.exe', ['.'], { ...opts, windowsHide: false }).unref();
  return { ok: true };
}

function pickFolder() {
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Escolha a pasta do projeto'",
    "if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }",
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8', windowsHide: true }, (err, out) =>
      err ? reject(new Error('não consegui abrir o seletor de pastas: ' + err.message)) : resolve({ folder: out.trim() || null }));
  });
}

module.exports = { isDir, folderInfo, openFolder, pickFolder };

#!/usr/bin/env node
// Primeira execução do conector baixado do hub ("Iniciar Techtie.bat" chama antes de ligar):
//  1. pareia este PC com a conta, usando o código que veio no pacote (conector-config.json);
//  2. confere o login do Claude neste PC e, se faltar, abre o login no navegador;
//  3. pergunta (uma vez) se deve iniciar com o Windows e atualizar o escritório pelo VS Code.
// Nas execuções seguintes não pergunta nada e só confere o login do Claude.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');
const { pair, readJson, writeJson, CONFIG_FILE } = require('./conector');

const PACK_FILE = path.join(__dirname, 'conector-config.json'); // vem no zip: { hub, code }
const say = (...a) => console.log(...a);

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === '' || answer.startsWith('s');
}

// claude.exe que vem junto com o Claude Agent SDK (é o próprio Claude Code)
function claudeBin() {
  try {
    const dir = path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`));
    const bin = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

function claudeLoggedIn(bin) {
  const r = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', windowsHide: true });
  try {
    return JSON.parse(r.stdout).loggedIn === true;
  } catch {
    return false;
  }
}

async function pairIfNeeded() {
  const pack = readJson(PACK_FILE);
  const saved = readJson(CONFIG_FILE);
  if (!pack?.hub) return; // instalado pelo repositório: o pareamento é pela linha de comando
  if (saved?.token && saved.hub === pack.hub && !pack.code) return; // já pareado
  if (!pack.code) {
    if (saved?.token) return;
    throw new Error('Este pacote já foi usado. Baixe o conector de novo no hub (PC → Conectar um PC).');
  }
  say('Pareando este PC com a sua conta no hub…');
  try {
    const token = await pair(pack.hub, pack.code);
    writeJson(CONFIG_FILE, { hub: pack.hub, token });
  } catch (e) {
    if (saved?.token && saved.hub === pack.hub) return; // código vencido, mas o PC já estava pareado
    throw new Error(`${e.message}\nBaixe o conector de novo no hub (PC → Conectar um PC); o código do pacote vale 24 horas.`);
  }
  writeJson(PACK_FILE, { hub: pack.hub }); // o código é de uso único: não fica guardado
  say('✓ PC pareado.');
}

async function loginIfNeeded() {
  const bin = claudeBin();
  if (!bin) return say('(Não encontrei o Claude Code do pacote; confira se a instalação terminou sem erros.)');
  if (claudeLoggedIn(bin)) return;
  say('\nEste PC ainda não está logado no Claude. Vou abrir o login no navegador:');
  say('entre com a SUA conta do Claude (é ela que os agentes usam neste PC).\n');
  spawnSync(bin, ['auth', 'login'], { stdio: 'inherit' });
  if (!claudeLoggedIn(bin)) throw new Error('O login do Claude não foi concluído. Rode o "Iniciar Techtie.bat" de novo para tentar outra vez.');
  say('✓ Claude logado.');
}

async function firstRunQuestions() {
  const flag = path.join(__dirname, '.preparado');
  if (fs.existsSync(flag) || process.platform !== 'win32') return;
  const bat = path.join(__dirname, 'Iniciar Techtie.bat');
  if (fs.existsSync(bat) && await ask('\nIniciar o conector junto com o Windows? [S/n] ')) {
    const startup = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Techtie Hub.lnk');
    const ps = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${startup.replace(/'/g, "''")}'); ` +
      `$s.TargetPath = '${bat.replace(/'/g, "''")}'; $s.WorkingDirectory = '${__dirname.replace(/'/g, "''")}'; $s.WindowStyle = 7; $s.Save()`;
    spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
    say('✓ Vai iniciar com o Windows (minimizado).');
  }
  if (await ask('Atualizar o escritório também quando você usar o Claude Code no VS Code? [S/n] ')) {
    spawnSync(process.execPath, [path.join(__dirname, 'instalar-hook.js')], { stdio: 'inherit' });
  }
  fs.writeFileSync(flag, new Date().toISOString());
}

(async () => {
  await pairIfNeeded();
  await loginIfNeeded();
  await firstRunQuestions();
})().catch((e) => {
  console.error('\n' + e.message);
  process.exit(1);
});

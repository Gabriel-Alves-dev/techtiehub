// Consultas ao git das pastas dos projetos. Nunca lança erro: sem git ou fora de
// um repositório, as funções devolvem null.
const { execFile } = require('child_process');

function git(dir, args) {
  return new Promise((resolve) => {
    if (!dir) return resolve(null);
    execFile('git', ['-C', dir, ...args], { windowsHide: true, timeout: 5000 }, (err, out) =>
      resolve(err ? null : String(out).trim()));
  });
}

const head = (dir) => git(dir, ['rev-parse', 'HEAD']);
const remote = (dir) => git(dir, ['config', '--get', 'remote.origin.url']);

// Mesmo repositório escrito de jeitos diferentes (https/ssh, com/sem .git, com usuário).
function sameRepo(a, b) {
  const norm = (u) => u.trim().toLowerCase()
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^(ssh|https?):\/\/([^@/]*@)?/, 'https://')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  return norm(a) === norm(b);
}

// Compara o commit em que o agente parou com o da pasta atual.
// state: ok (igual ou sem referência) | ahead (pasta tem commits novos) |
//        missing (commit não existe aqui: falta git pull) | diverged (histórias diferentes)
async function status(dir, last) {
  const current = await head(dir);
  if (!current) return { git: false };
  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = !!(await git(dir, ['status', '--porcelain']));
  let state = 'ok';
  if (last && last !== current) {
    if ((await git(dir, ['cat-file', '-e', last + '^{commit}'])) === null) state = 'missing';
    else state = (await git(dir, ['merge-base', '--is-ancestor', last, current])) !== null ? 'ahead' : 'diverged';
  }
  return { git: true, head: current, branch, dirty, last: last || null, state };
}

module.exports = { git, head, remote, sameRepo, status };

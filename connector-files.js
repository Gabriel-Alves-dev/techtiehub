// Arquivos que rodam no PC (conector). Usado pelo hub para montar o pacote baixável e
// para a atualização automática, e pelo conector para calcular a própria versão.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILES = ['conector.js', 'connector-files.js', 'runner.js', 'git.js', 'local-ops.js', 'remote-store.js',
  'describe.js', 'mcp-local.js', 'preparar.js', 'hub-hook.js', 'instalar-hook.js', 'report.js'];

// Versão = impressão digital do conteúdo (CRLF/LF não conta: o git do Windows troca as quebras).
function versionOf(dir) {
  const h = crypto.createHash('sha256');
  for (const f of FILES) {
    try {
      h.update(f + '\0' + fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
    } catch {
      h.update(f + '\0(ausente)');
    }
  }
  return h.digest('hex').slice(0, 12);
}

module.exports = { FILES, versionOf };

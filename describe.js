// Texto curto para uma chamada de ferramenta do Claude ("Editando app.js").
// Usado pelo hub (eventos dos hooks) e pelo conector (agentes rodando no PC).
const path = require('path');

function describeTool(name, input = {}) {
  const file = input.file_path ? path.basename(input.file_path) : '';
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editando ${file}`;
    case 'Write':
      return `Escrevendo ${file}`;
    case 'Read':
      return `Lendo ${file}`;
    case 'Bash':
    case 'PowerShell':
      return `Rodando: ${input.description || input.command || ''}`;
    case 'Grep':
    case 'Glob':
      return 'Procurando no código';
    case 'WebFetch':
    case 'WebSearch':
      return 'Pesquisando na web';
    case 'Agent':
    case 'Task':
      return `Delegando: ${input.description || 'subagente'}`;
    default:
      return `Usando ${name}`;
  }
}

module.exports = { describeTool };

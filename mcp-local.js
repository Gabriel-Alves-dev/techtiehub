// Servidores MCP no PC (lado do conector):
//  - scan: encontra os MCPs que o Claude Code deste PC já conhece, para importar no hub;
//  - test: liga um MCP e lista as ferramentas, sem mandar nenhuma mensagem ao Claude
//    (não gasta uso do plano).
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();

// folders: pastas das mesas neste PC (para achar MCPs "de projeto")
function scan(folders = []) {
  const found = [];
  const add = (source, servers) => {
    for (const [name, config] of Object.entries(servers || {})) {
      if (config && typeof config === 'object' && (config.url || config.command)) found.push({ name, source, config });
    }
  };
  const claude = readJson(path.join(os.homedir(), '.claude.json'));
  if (claude) {
    add('Claude Code deste PC (todos os projetos)', claude.mcpServers);
    for (const folder of folders) {
      const key = Object.keys(claude.projects || {}).find((k) => norm(k) === norm(folder));
      if (key) add(`Claude Code, projeto ${path.basename(folder)}`, claude.projects[key].mcpServers);
    }
  }
  for (const folder of folders) add(`.mcp.json de ${path.basename(folder)}`, readJson(path.join(folder, '.mcp.json'))?.mcpServers);
  return found;
}

async function test(name, config) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let release;
  const hold = new Promise((r) => (release = r));
  // entrada em "streaming" que nunca manda mensagem: o Claude Code sobe e conecta os MCPs,
  // mas nada vai para o modelo
  const q = query({
    prompt: (async function* () { await hold; })(),
    options: { cwd: os.tmpdir(), mcpServers: { [name]: config }, settingSources: [], persistSession: false },
  });
  const drain = (async () => { try { for await (const _ of q) {} } catch {} })();
  try {
    let status = null;
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      status = (await q.mcpServerStatus()).find((s) => s.name === name);
      if (status && status.status !== 'pending') break;
      await sleep(500);
    }
    return {
      status: status?.status || 'failed',
      error: status?.error || (status ? null : 'o servidor não respondeu em 30 s'),
      tools: (status?.tools || []).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 200) })),
    };
  } finally {
    release();
    q.close?.();
    await Promise.race([drain, sleep(3000)]);
  }
}

module.exports = { scan, test };

// Criptografia dos segredos guardados no hub (tokens e URLs dos servidores MCP).
// AES-256-GCM. A chave vem de HUB_SECRET_KEY (recomendado: fica fora do volume de dados, então
// um backup vazado não revela os tokens) ou, sem ela, de um arquivo gerado em data/secret.key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function loadKey(dataDir) {
  if (process.env.HUB_SECRET_KEY) return crypto.createHash('sha256').update(process.env.HUB_SECRET_KEY).digest();
  const file = path.join(dataDir, 'secret.key');
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  } catch {
    const key = crypto.randomBytes(32);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    return key;
  }
}

class Secrets {
  constructor(dataDir) {
    this.key = loadKey(dataDir);
    this.fromEnv = !!process.env.HUB_SECRET_KEY;
  }

  encrypt(text) {
    if (text == null || text === '') return text;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
  }

  // Chave trocada (ex.: HUB_SECRET_KEY definida depois): o segredo não abre — devolve '' e
  // a tela mostra o campo vazio para digitar de novo, em vez de derrubar o hub.
  decrypt(value) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
    try {
      const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch {
      return '';
    }
  }
}

// Para mostrar na tela sem revelar: "••••a1b2" / "https://empresa.bitrix24.com.br/••••"
function mask(text) {
  if (!text) return '';
  const s = String(text);
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).origin + '/••••';
    } catch {}
  }
  return '••••' + (s.length > 8 ? s.slice(-4) : '');
}

const isMask = (v) => typeof v === 'string' && v.includes('••••');

module.exports = { Secrets, mask, isMask };

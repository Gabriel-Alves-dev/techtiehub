// Monitor de servidores (VPS): recebe um resumo que o próprio monitor envia ao hub.
//
// O hub nunca consulta a VPS: ela faz um POST de saída em /api/monitor/report com um segredo
// próprio desta integração. Em data/monitor.json fica só o hash do segredo; os resumos ficam em
// memória (depois de um reinício, cada rack volta no próximo envio). Veja docs/MONITOR-VPS.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_HOSTS = 20;
const MAX_NAMES = 20;
const NAME_RE = /[^A-Za-z0-9._-]/g;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const num = (v, min, max) => (Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : null);

// Lista de nomes (com os itens ruins) ou só uma contagem, conforme o monitor deixa enviar nomes ou não.
function group(v, extra = {}) {
  const out = { count: 0, names: [], ...extra };
  if (Number.isFinite(v)) out.count = Math.max(0, Math.min(9999, Math.round(v)));
  else if (Array.isArray(v)) {
    out.names = v.slice(0, MAX_NAMES).map((n) => String(n).replace(NAME_RE, '').slice(0, 64)).filter(Boolean);
    out.count = Math.max(v.length, out.names.length);
  }
  return out;
}

class Monitor {
  constructor(dir) {
    this.file = path.join(dir, 'monitor.json');
    try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.db = {}; }
    this.hosts = new Map(); // host -> { report, at }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.db, null, 2));
  }

  configured() {
    return !!this.db.secretHash;
  }

  // Gera (ou troca) o segredo. O valor só existe nesta resposta: o hub guarda apenas o hash.
  newSecret() {
    const secret = 'mon_' + crypto.randomBytes(32).toString('base64url');
    this.db = { secretHash: sha(secret), createdAt: Date.now() };
    this.save();
    return secret;
  }

  revoke() {
    this.db = {};
    this.hosts.clear();
    this.save();
  }

  check(secret) {
    if (!this.db.secretHash || !secret) return false;
    const a = Buffer.from(sha(secret), 'hex'), b = Buffer.from(this.db.secretHash, 'hex');
    return crypto.timingSafeEqual(a, b);
  }

  // Valida o corpo contra o contrato e guarda só o que ele prevê (o resto é descartado).
  ingest(body) {
    const host = String(body?.host || '').replace(NAME_RE, '').slice(0, 64);
    if (!host) throw new Error('host é obrigatório');
    if (!this.hosts.has(host) && this.hosts.size >= MAX_HOSTS) throw new Error('hosts demais');
    const r = {
      host,
      interval: num(body.interval, 30, 3600) ?? 60,
      cpu: num(body.cpu, 0, 999), mem: num(body.mem, 0, 100), disk: num(body.disk, 0, 100),
      uptime: num(body.uptime, 0, 1e10),
      pm2: { total: num(body.pm2?.total, 0, 9999) ?? 0, errored: group(body.pm2?.errored), highRestarts: group(body.pm2?.highRestarts) },
      docker: { total: num(body.docker?.total, 0, 9999) ?? 0, unhealthy: group(body.docker?.unhealthy) },
      systemd: { total: num(body.systemd?.total, 0, 9999), failed: group(body.systemd?.failed) },
      ports: { exposed: num(body.ports?.exposed, 0, 65535) },
    };
    this.hosts.set(host, { report: r, at: Date.now() });
    return r;
  }

  // Situação: sem sinal (3 intervalos sem enviar), crítico, atenção ou ok.
  static status(entry, now = Date.now()) {
    const r = entry.report;
    if (now - entry.at > r.interval * 3 * 1000) return 'sem-sinal';
    const bad = r.pm2.errored.count + r.docker.unhealthy.count + r.systemd.failed.count;
    if (bad || (r.cpu ?? 0) >= 90 || (r.mem ?? 0) >= 90 || (r.disk ?? 0) >= 90) return 'critico';
    if (r.pm2.highRestarts.count || (r.cpu ?? 0) >= 75 || (r.mem ?? 0) >= 80 || (r.disk ?? 0) >= 80) return 'atencao';
    return 'ok';
  }

  view() {
    const now = Date.now();
    return [...this.hosts.values()]
      .map((e) => ({ ...e.report, at: e.at, status: Monitor.status(e, now) }))
      .sort((a, b) => a.host.localeCompare(b.host));
  }
}

module.exports = { Monitor };

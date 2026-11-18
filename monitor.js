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

// ---------- envio v2: detalhamento por serviço ----------
const SRCS = ['pm2', 'docker', 'swarm', 'systemd'];
const STATUSES = ['online', 'stopped', 'errored', 'launching', 'running', 'exited', 'restarting', 'active', 'inactive', 'failed'];
const MAX_SERVICES = 60;
const clean = (v, n) => String(v ?? '').replace(NAME_RE, '').slice(0, n);

// Um item da lista `services`. O vocabulário de status é fechado (o resto vira "other"); números fora da faixa são
// descartados e cpu_core_pct NÃO é cortado em 100 (é % de um núcleo, então 138 é normal).
function service(s) {
  if (!s || typeof s !== 'object' || !SRCS.includes(s.src)) return null;
  const name = clean(s.name, 64);
  if (!name) return null;
  return {
    src: s.src, name, project: clean(s.project, 64) || null,
    status: STATUSES.includes(s.status) ? s.status : 'other',
    health: clean(s.health, 16).toLowerCase() || null,
    instances: num(s.instances, 0, 9999),
    replicas: /^\d{1,4}\/\d{1,4}$/.test(String(s.replicas)) ? String(s.replicas) : null,
    cpu_core_pct: num(s.cpu_core_pct, 0, 1e5), mem_mb: num(s.mem_mb, 0, 1e7), restarts: num(s.restarts, 0, 1e9),
  };
}
// item com problema: processo/serviço em erro ou falha, ou container reportando unhealthy
const isBad = (x) => x.status === 'errored' || x.status === 'failed' || x.health === 'unhealthy';
const names = (list) => list.map((x) => x.name);

// Converte o v2 para o formato que o resto do hub já usa (o v1 e as telas atuais continuam iguais). O Swarm entra junto
// com o Docker nos totais do rack; a tabela por serviço mostra a origem de cada item.
function fromV2(body, host) {
  const sys = body.sys && typeof body.sys === 'object' ? body.sys : {};
  const list = (Array.isArray(body.services) ? body.services : []).map(service).filter(Boolean);
  const services = list.slice(0, MAX_SERVICES);
  const pm2 = services.filter((x) => x.src === 'pm2'), dk = services.filter((x) => x.src === 'docker' || x.src === 'swarm'), sd = services.filter((x) => x.src === 'systemd');
  return {
    v: 2, host,
    interval: num(body.interval, 30, 3600) ?? 60,
    cpu: num(sys.load_pct, 0, 99999), mem: num(sys.mem_used_pct, 0, 100), disk: num(sys.disk_used_pct, 0, 100),
    uptime: num(sys.uptime_s, 0, 1e10),
    cpus: num(sys.cpus, 1, 4096), memTotalMb: num(sys.mem_total_mb, 0, 1e8), swap: num(sys.swap_used_pct, 0, 100),
    pm2: { total: pm2.length, errored: group(names(pm2.filter(isBad))), highRestarts: group(names(pm2.filter((x) => x.status === 'restarting'))) },
    docker: { total: dk.length, unhealthy: group(names(dk.filter(isBad))) },
    // o v2 só manda as unidades systemd em falha ou marcadas como próprias: o total é o das listadas, não o do sistema
    systemd: { total: sd.length, failed: group(names(sd.filter(isBad))) },
    ports: { exposed: num(body.ports?.exposed, 0, 65535), listening: num(body.ports?.listening, 0, 65535) },
    services, truncated: body.truncated === true || list.length > MAX_SERVICES,
  };
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
    if (body.v === 2) {
      const r2 = fromV2(body, host);
      this.hosts.set(host, { report: r2, at: Date.now() });
      return r2;
    }
    const r = {
      v: 1, host,
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
    // a carga (load ÷ vCPUs) sobe com o steal do hypervisor mesmo com a VM quase ociosa: sozinha ela só chega a ATENÇÃO.
    // CRÍTICO por CPU virá de cpu_busy_pct e steal_pct, quando o monitor passar a enviá-los
    if (bad || (r.mem ?? 0) >= 90 || (r.disk ?? 0) >= 90) return 'critico';
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

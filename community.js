// Chat da comunidade: sala geral + conversas individuais entre contas do hub.
//
// Fica no nível do hub (não do escritório): é o único dado compartilhado entre contas, então
// guarda só mensagens e quem leu até quando — nada do escritório de ninguém passa por aqui.
// Arquivo: data/community.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_VOICE = 6; // em malha, cada pessoa envia o áudio a todas as outras
const VOICE_GRACE_MS = 10000; // sem conexão por tanto tempo = sai da sala de voz
const MAX_TEXT = 2000;
const MAX_KEPT = 500; // por conversa; as mais antigas saem
const PAGE = 60;

class Community {
  constructor(dir, auth) {
    this.auth = auth;
    this.file = path.join(dir, 'community.json');
    try {
      this.db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.db = {};
    }
    // generals: { teamId: [msg] }   dms: { 'idMenor|idMaior': [msg] }   reads: { userId: { general|outroId: t } }
    this.db.generals ??= {};
    // versão sem equipes: a sala geral única passa para a equipe da dona
    const owner = auth.db.users.find((u) => u.isOwner);
    if (this.db.general && owner) { this.db.generals[owner.teamId] = this.db.general; delete this.db.general; this.save(); }
    this.db.dms ??= {};
    this.db.reads ??= {};
    this.streams = new Map(); // userId -> Set(res) das abas abertas
    this.voice = new Map(); // teamId -> Map(userId -> nome): quem está na sala de voz (só em memória)
    this.voiceTimers = new Map(); // userId -> timer que tira da voz quem ficou sem conexão
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.db));
  }

  dmKey = (a, b) => [a, b].sort().join('|');

  // colegas de equipe (o chat só existe dentro da equipe)
  people(user) {
    return this.auth.teamMembers(user).filter((u) => u.id !== user.id).map((u) => ({ id: u.id, name: u.name }));
  }

  sameTeam(user, otherId) {
    const other = this.auth.findUser(otherId);
    return !!other && other.id !== user.id && other.teamId === user.teamId;
  }

  general(user) {
    return (this.db.generals[user.teamId] ??= []);
  }

  // ---------- Tempo real ----------
  attach(userId, req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': ok\n\n');
    if (!this.streams.has(userId)) this.streams.set(userId, new Set());
    this.streams.get(userId).add(res);
    clearTimeout(this.voiceTimers.get(userId)); // recarregou a página: continua na voz
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      const set = this.streams.get(userId);
      set?.delete(res);
      if (!set?.size) this.voiceTimers.set(userId, setTimeout(() => this.dropFromVoice(userId), VOICE_GRACE_MS));
    });
  }

  // ---------- Sala de voz da equipe ----------
  // O áudio vai direto entre as pessoas (WebRTC); o hub só repassa a sinalização (oferta, resposta e
  // candidatos ICE) pelo SSE. Em malha, então a sala tem limite de gente.
  voiceMembers(user) {
    return [...(this.voice.get(user.teamId) || [])].map(([id, name]) => ({ id, name }));
  }

  voiceBroadcast(user) {
    this.push(this.auth.teamMembers(user).map((u) => u.id), 'voice', { members: this.voiceMembers(user) });
  }

  voiceJoin(user) {
    const room = this.voice.get(user.teamId) ?? new Map();
    if (!room.has(user.id) && room.size >= MAX_VOICE) throw new Error(`a sala de voz está cheia (${MAX_VOICE} pessoas)`);
    room.set(user.id, user.name);
    this.voice.set(user.teamId, room);
    this.voiceBroadcast(user);
    return this.voiceMembers(user);
  }

  voiceLeave(user) {
    const room = this.voice.get(user.teamId);
    if (!room?.delete(user.id)) return;
    if (!room.size) this.voice.delete(user.teamId);
    this.voiceBroadcast(user);
  }

  dropFromVoice(userId) {
    this.voiceTimers.delete(userId);
    const user = this.auth.findUser(userId);
    if (user && !this.streams.get(userId)?.size) this.voiceLeave(user);
  }

  // repassa a sinalização para outra pessoa da mesma sala de voz
  voiceSignal(user, to, data) {
    const room = this.voice.get(user.teamId);
    if (!room?.has(user.id) || !room.has(to) || to === user.id) throw new Error('essa pessoa não está na sala de voz');
    if (!data || typeof data !== 'object') throw new Error('sinalização inválida');
    this.push([to], 'voice-signal', { from: user.id, data });
  }

  push(userIds, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const id of userIds) for (const res of this.streams.get(id) || []) res.write(payload);
  }

  // ---------- Mensagens ----------
  makeMsg(user, text) {
    text = String(text || '').trim().slice(0, MAX_TEXT);
    if (!text) throw new Error('mensagem vazia');
    return { id: crypto.randomBytes(6).toString('base64url'), t: Date.now(), from: user.id, name: user.name, text };
  }

  sendGeneral(user, text) {
    const msg = this.makeMsg(user, text);
    const list = this.general(user);
    list.push(msg);
    if (list.length > MAX_KEPT) list.splice(0, list.length - MAX_KEPT);
    this.markRead(user.id, 'general');
    this.save();
    this.push(this.auth.teamMembers(user).map((u) => u.id), 'msg', { chat: 'general', msg });
    return msg;
  }

  sendDirect(user, toId, text) {
    if (!this.sameTeam(user, toId)) throw new Error('pessoa não encontrada');
    const msg = this.makeMsg(user, text);
    const key = this.dmKey(user.id, toId);
    const list = (this.db.dms[key] ??= []);
    list.push(msg);
    if (list.length > MAX_KEPT) list.splice(0, list.length - MAX_KEPT);
    this.markRead(user.id, toId);
    this.save();
    this.push([user.id, toId], 'msg', { chat: 'dm', from: user.id, to: toId, msg });
    return msg;
  }

  history(user, chat, before) {
    const list = chat === 'general' ? this.general(user) : this.db.dms[this.dmKey(user.id, chat)] || [];
    const upto = before ? list.filter((m) => m.t < before) : list;
    return upto.slice(-PAGE);
  }

  markRead(userId, chat) {
    (this.db.reads[userId] ??= {})[chat] = Date.now();
  }

  // Não lidas por conversa. Quem nunca abriu a sala geral só vê o que veio depois de criar a conta.
  unread(user) {
    const reads = this.db.reads[user.id] || {};
    const count = (list, since) => list.filter((m) => m.from !== user.id && m.t > since).length;
    const out = { general: count(this.general(user), reads.general ?? user.createdAt), dm: {} };
    for (const [key, list] of Object.entries(this.db.dms)) {
      const [a, b] = key.split('|');
      if (a !== user.id && b !== user.id) continue;
      const peer = a === user.id ? b : a;
      if (!this.sameTeam(user, peer)) continue;
      const n = count(list, reads[peer] ?? 0);
      if (n) out.dm[peer] = n;
    }
    return out;
  }

  summary(user) {
    return { people: this.people(user), unread: this.unread(user) };
  }
}

module.exports = { Community };

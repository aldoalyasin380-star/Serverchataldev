const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});
const SECRET = process.env.APP_SECRET || 'ganti-secret-ini-di-env';

const app = express();
app.use(express.json({ limit: '300kb' }));

const tokenOf = u => crypto.createHmac('sha256', SECRET).update(u).digest('hex').slice(0, 24);
const clean = u => String(u || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_.]/g, '').slice(0, 20);
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const dmId = (a, b) => 'dm:' + [a, b].sort().join(':');
const EMOJI = ['❤️', '😂', '👍', '😮', '🔥'];
const h = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(e => {
    console.error(e);
    res.status(500).json({ error: 'Server lagi error, coba lagi' });
  });

function auth(req, res, next) {
  const u = clean(req.get('x-user'));
  if (!u || req.get('x-token') !== tokenOf(u)) return res.status(401).json({ error: 'Belum login' });
  req.u = u;
  next();
}

// cek akses ke sebuah chat, balikin daftar member
async function access(u, chat) {
  chat = String(chat || '');
  if (chat === 'global') return { ok: true, members: null };
  if (chat.startsWith('dm:')) {
    const p = chat.slice(3).split(':');
    if (p.length !== 2 || !p.includes(u) || p[0] === p[1]) return { ok: false };
    const other = p.find(x => x !== u);
    if (!(await redis.exists('user:' + other))) return { ok: false };
    return { ok: true, members: p };
  }
  if (chat.startsWith('grp:')) {
    const g = await redis.get('group:' + chat.slice(4));
    if (!g || !g.members.includes(u)) return { ok: false };
    return { ok: true, members: g.members };
  }
  return { ok: false };
}
const bump = (chat, members) =>
  chat === 'global' ? redis.incr('ver:global') : Promise.all(members.map(m => redis.incr('ver:' + m)));

async function missions(u, me) {
  const [msgs, reacts, contacts, days] = await Promise.all([
    redis.get('msgs:' + u), redis.get('reacts:' + u), redis.scard('contacts:' + u), redis.scard('days:' + u),
  ]);
  return [
    { t: 'Kirim 30 pesan', n: +msgs || 0, max: 30 },
    { t: 'Kasih react ke 5 pesan', n: +reacts || 0, max: 5 },
    { t: 'Tambah 5 kontak', n: contacts, max: 5 },
    { t: 'Aktif di 3 hari berbeda', n: days, max: 3 },
    { t: 'Lengkapi profil (nama, bio, foto)', n: me.name && me.bio && me.av ? 1 : 0, max: 1 },
  ].map(m => ({ ...m, n: Math.min(m.n, m.max) }));
}

// ---------- akun ----------
app.post('/api/register', h(async (req, res) => {
  const username = clean(req.body.username);
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (username.length < 3) return res.status(400).json({ error: 'Username minimal 3 karakter (huruf, angka, _ .)' });
  if (!name) return res.status(400).json({ error: 'Nama wajib diisi' });
  const ok = await redis.setnx('user:' + username, { username, name, bio: '', av: 0, verified: false, created: Date.now() });
  if (!ok) return res.status(409).json({ error: 'Username sudah dipakai' });
  await redis.sadd('users', username);
  res.json({ username, token: tokenOf(username) });
}));

app.post('/api/login', h(async (req, res) => {
  const username = clean(req.body.username);
  if (!username || req.body.token !== tokenOf(username)) return res.status(401).json({ error: 'Username atau kode pemulihan salah' });
  if (!(await redis.exists('user:' + username))) return res.status(401).json({ error: 'Akun tidak ditemukan' });
  res.json({ username, token: tokenOf(username) });
}));

app.get('/api/me', auth, h(async (req, res) => {
  const me = await redis.get('user:' + req.u);
  if (!me) return res.status(401).json({ error: 'Akun tidak ada' });
  await redis.sadd('days:' + req.u, today());
  res.json({ ...me, missions: await missions(req.u, me) });
}));

app.post('/api/me', auth, h(async (req, res) => {
  const me = await redis.get('user:' + req.u);
  const name = String(req.body.name ?? me.name).trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Nama tidak boleh kosong' });
  me.name = name;
  me.bio = String(req.body.bio ?? me.bio).slice(0, 120);
  const a = req.body.avatar;
  if (a === '') { await redis.del('av:' + req.u); me.av = 0; }
  else if (typeof a === 'string') {
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(a) || a.length > 150000) return res.status(400).json({ error: 'Foto tidak valid / kegedean' });
    await redis.set('av:' + req.u, a);
    me.av = Date.now();
  }
  await redis.set('user:' + req.u, me);
  res.json({ ok: 1 });
}));

app.post('/api/verify', auth, h(async (req, res) => {
  const me = await redis.get('user:' + req.u);
  const ms = await missions(req.u, me);
  if (!ms.every(m => m.n >= m.max)) return res.status(400).json({ error: 'Misi belum selesai semua' });
  me.verified = true;
  await redis.set('user:' + req.u, me);
  res.json({ ok: 1 });
}));

app.get('/api/avatar/:u', h(async (req, res) => {
  const a = await redis.get('av:' + clean(req.params.u));
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(a || '');
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]).set('Cache-Control', 'public,max-age=300').send(Buffer.from(m[2], 'base64'));
}));

app.post('/api/profiles', auth, h(async (req, res) => {
  const list = [...new Set((req.body.users || []).map(clean).filter(Boolean))].slice(0, 60);
  const out = {};
  if (list.length) {
    const rows = await redis.mget(...list.map(u => 'user:' + u));
    list.forEach((u, i) => { const r = rows[i]; if (r) out[u] = { name: r.name, v: !!r.verified, a: r.av || 0, bio: r.bio }; });
  }
  res.json(out);
}));

app.get('/api/users', auth, h(async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().replace(/^@/, '').trim();
  if (q.length < 2) return res.json([]);
  const all = await redis.smembers('users');
  let found;
  if (all.length > 1500) found = all.filter(u => u.includes(q)).map(u => ({ username: u, name: u }));
  else {
    const rows = await redis.mget(...all.map(u => 'user:' + u));
    found = rows.filter(r => r && (r.username.includes(q) || r.name.toLowerCase().includes(q)))
      .map(r => ({ username: r.username, name: r.name, v: !!r.verified, a: r.av || 0 }));
  }
  res.json(found.filter(x => x.username !== req.u).slice(0, 20));
}));

// ---------- chat ----------
app.get('/api/sync', auth, h(async (req, res) => {
  const [a, b] = await redis.mget('ver:' + req.u, 'ver:global');
  res.json({ v: (a || 0) + '.' + (b || 0) });
}));

app.get('/api/chats', auth, h(async (req, res) => {
  const u = req.u;
  const ids = ['global', ...(await redis.smembers('uchats:' + u))];
  const gids = ids.filter(i => i.startsWith('grp:'));
  const groups = gids.length ? await redis.mget(...gids.map(g => 'group:' + g.slice(4))) : [];
  const gm = {};
  gids.forEach((g, i) => (gm[g] = groups[i]));
  const p = redis.pipeline();
  ids.forEach(i => { p.llen('c:' + i); p.lindex('c:' + i, -1); });
  const r = await p.exec();
  const out = ids.map((id, i) => {
    const count = r[i * 2], last = r[i * 2 + 1];
    if (id === 'global') return { id, type: 'global', title: 'Global Group', count, last };
    if (id.startsWith('dm:')) {
      const other = id.slice(3).split(':').find(x => x !== u);
      return { id, type: 'dm', title: other, other, count, last };
    }
    const g = gm[id];
    if (!g) return null;
    return { id, type: 'group', title: g.name, code: g.id, members: g.members.length, count, last };
  }).filter(Boolean);
  res.json(out);
}));

app.get('/api/messages', auth, h(async (req, res) => {
  const chat = String(req.query.chat || '');
  if (!(await access(req.u, chat)).ok) return res.status(403).json({ error: 'Tidak boleh akses chat ini' });
  const len = await redis.llen('c:' + chat);
  const start = Math.max(0, len - 100);
  res.json({ start, msgs: len ? await redis.lrange('c:' + chat, start, -1) : [] });
}));

app.post('/api/send', auth, h(async (req, res) => {
  const chat = String(req.body.chat || '');
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Pesan kosong' });
  const acc = await access(req.u, chat);
  if (!acc.ok) return res.status(403).json({ error: 'Tidak boleh kirim ke chat ini' });
  await redis.rpush('c:' + chat, { u: req.u, t: text, ts: Date.now(), r: {} });
  await Promise.all([
    redis.incr('msgs:' + req.u),
    bump(chat, acc.members),
    ...(chat.startsWith('dm:') ? acc.members.map(m => redis.sadd('uchats:' + m, chat)) : []),
  ]);
  res.json({ ok: 1 });
}));

app.post('/api/react', auth, h(async (req, res) => {
  const { chat, emoji } = req.body;
  const idx = parseInt(req.body.idx, 10);
  const u = req.u;
  const acc = await access(u, chat);
  if (!acc.ok || !EMOJI.includes(emoji) || !(idx >= 0)) return res.status(400).json({ error: 'Gagal' });
  const m = await redis.lindex('c:' + chat, idx);
  if (!m) return res.status(404).json({ error: 'Pesan tidak ada' });
  m.r = m.r || {};
  const arr = m.r[emoji] || [];
  const i = arr.indexOf(u);
  if (i >= 0) arr.splice(i, 1);
  else { arr.push(u); await redis.incr('reacts:' + u); }
  if (arr.length) m.r[emoji] = arr; else delete m.r[emoji];
  await redis.lset('c:' + chat, idx, m);
  await bump(chat, acc.members);
  res.json({ ok: 1 });
}));

app.post('/api/dm', auth, h(async (req, res) => {
  const other = clean(req.body.username);
  if (!other || other === req.u) return res.status(400).json({ error: 'Username tidak valid' });
  if (!(await redis.exists('user:' + other))) return res.status(404).json({ error: 'Username tidak ditemukan' });
  const id = dmId(req.u, other);
  await redis.sadd('contacts:' + req.u, other);
  if (!req.body.save) await redis.sadd('uchats:' + req.u, id);
  res.json({ id });
}));

app.post('/api/groups', auth, h(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Nama grup wajib diisi' });
  const id = crypto.randomBytes(4).toString('hex');
  await redis.set('group:' + id, { id, name, owner: req.u, members: [req.u] });
  await redis.sadd('uchats:' + req.u, 'grp:' + id);
  res.json({ id: 'grp:' + id });
}));

app.post('/api/groups/join', auth, h(async (req, res) => {
  const code = String(req.body.code || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  const g = code && (await redis.get('group:' + code));
  if (!g) return res.status(404).json({ error: 'Kode grup tidak ditemukan' });
  if (!g.members.includes(req.u)) {
    if (g.members.length >= 200) return res.status(400).json({ error: 'Grup penuh' });
    g.members.push(req.u);
    await redis.set('group:' + code, g);
    await bump('grp:' + code, g.members);
  }
  await redis.sadd('uchats:' + req.u, 'grp:' + code);
  res.json({ id: 'grp:' + code });
}));

if (require.main === module) {
  app.use(express.static(path.join(__dirname, '../public')));
  app.listen(3000, () => console.log('jalan di http://localhost:3000'));
}
module.exports = app;

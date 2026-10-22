const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const app = express();
app.use(express.json({ limit: '1mb' }));

const clean = u => String(u || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_.]/g, '').slice(0, 20);
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const dmId = (a, b) => 'dm:' + [a, b].sort().join(':');
const EMOJI = ['❤️', '😂', '👍', '😮', '🔥'];

// sisa akun bot lama (dibersihin otomatis dari database)
const LEGACY_BOT = 'albot';

const SYSTEM_CONFIG = {
  mainGroupId: "global",
  mainGroupName: "Global Group",
  mainGroupAvatar: "https://files.catbox.moe/5k43y6.jpg",
  devBadgeColor: {
    rainbow: true,
    red: false,
    orange: false,
    yellow: false,
    blue: false
  }
};

function getDevBadgeColor() {
  const c = SYSTEM_CONFIG.devBadgeColor;
  if (c.rainbow) return 'rainbow';
  if (c.red) return 'red';
  if (c.orange) return 'orange';
  if (c.yellow) return 'yellow';
  return 'blue';
}

const h = fn => (req, res) =>
  Promise.resolve(fn(req, res)).catch(e => {
    console.error(e);
    res.status(500).json({ error: 'Server lagi error, coba lagi' });
  });

function auth(req, res, next) {
  const u = clean(req.get('x-user'));
  if (!u) return res.status(401).json({ error: 'Belum login' });
  req.u = u;
  next();
}

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
    return { ok: true, members: g.members, group: g };
  }
  return { ok: false };
}

const bump = (chat, members) =>
  chat === 'global' ? redis.incr('ver:global') : Promise.all((members || []).map(m => redis.incr('ver:' + m)));

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

// Bersihin sisa akun bot lama dari database (jalan sekali tiap server start)
(async () => {
  try {
    await redis.srem('users', LEGACY_BOT);
    await redis.del('user:' + LEGACY_BOT, 'online:' + LEGACY_BOT, 'av:' + LEGACY_BOT);
  } catch (e) { console.error('purge bot gagal', e.message); }
})();

// ---------- Auth / Profile ----------
app.post('/api/register', h(async (req, res) => {
  const username = clean(req.body.username);
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (username.length < 3) return res.status(400).json({ error: 'Username minimal 3 karakter' });

  const existingUser = await redis.get('user:' + username);
  if (existingUser) return res.json({ username: existingUser.username });

  if (!name) return res.status(400).json({ error: 'Nama wajib diisi untuk pendaftaran akun baru' });

  const isAldev = username === 'aldev';
  const userData = { username, name, bio: '', av: 0, verified: isAldev ? true : false, created: Date.now() };

  await redis.set('user:' + username, userData);
  await redis.sadd('users', username);
  await redis.sadd('uchats:' + username, 'global');

  res.json({ username });
}));

app.get('/api/me', auth, h(async (req, res) => {
  let me = await redis.get('user:' + req.u);
  if (!me) return res.status(401).json({ error: 'Akun tidak ditemukan' });
  if (req.u === 'aldev' && !me.verified) { me.verified = true; await redis.set('user:' + req.u, me); }
  
  await redis.set('online:' + req.u, Date.now(), { ex: 30 });
  await redis.sadd('days:' + req.u, today());

  res.json({ ...me, missions: await missions(req.u, me), devBadgeColor: req.u === 'aldev' ? getDevBadgeColor() : null });
}));

app.post('/api/me', auth, h(async (req, res) => {
  const me = await redis.get('user:' + req.u);
  if (!me) return res.status(404).json({ error: 'Akun tidak ditemukan' });
  const name = String(req.body.name ?? me.name).trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Nama tidak boleh kosong' });
  me.name = name;
  me.bio = String(req.body.bio ?? me.bio).slice(0, 120);
  if (req.u === 'aldev') me.verified = true;
  const a = req.body.avatar;
  if (a === '') { await redis.del('av:' + req.u); me.av = 0; }
  else if (typeof a === 'string') {
    if (!a.startsWith('http') && (!/^data:image\/(jpeg|png|webp);base64,/.test(a) || a.length > 300000)) return res.status(400).json({ error: 'Foto kegedean' });
    await redis.set('av:' + req.u, a);
    me.av = Date.now();
  }
  await redis.set('user:' + req.u, me);
  res.json({ ok: 1 });
}));

app.post('/api/verify', auth, h(async (req, res) => {
  const me = await redis.get('user:' + req.u);
  const ms = await missions(req.u, me);
  if (!ms.every(m => m.n >= m.max)) return res.status(400).json({ error: 'Misi belum selesai' });
  me.verified = true;
  await redis.set('user:' + req.u, me);
  res.json({ ok: 1 });
}));

app.get('/api/avatar/:u', h(async (req, res) => {
  const u = clean(req.params.u);
  const a = await redis.get('av:' + u);
  if (typeof a === 'string' && a.startsWith('http')) return res.redirect(a);
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(a || '');
  if (!m) return res.status(404).end();
  res.set('Content-Type', m[1]).set('Cache-Control', 'public,max-age=300').send(Buffer.from(m[2], 'base64'));
}));

app.post('/api/profiles', auth, h(async (req, res) => {
  const list = [...new Set((req.body.users || []).map(clean).filter(Boolean))].slice(0, 100);
  const out = {};
  const devBadge = getDevBadgeColor();
  if (list.length) {
    const rows = await redis.mget(...list.map(u => 'user:' + u));
    const onlineKeys = await redis.mget(...list.map(u => 'online:' + u));
    list.forEach((u, i) => { 
      const r = rows[i]; 
      if (r) {
        out[u] = { 
          name: r.name, 
          v: !!r.verified || u === 'aldev', 
          badgeColor: u === 'aldev' ? devBadge : 'blue',
          a: r.av || 0, 
          bio: r.bio,
          online: !!onlineKeys[i]
        }; 
      }
    });
  }
  res.json(out);
}));

app.get('/api/group-members', auth, h(async (req, res) => {
  const chat = String(req.query.chat || '');
  let usernames = [];
  let groupData = null;

  if (chat === 'global') {
    usernames = (await redis.smembers('users')).filter(x => x !== LEGACY_BOT);
  } else if (chat.startsWith('grp:')) {
    groupData = await redis.get('group:' + chat.slice(4));
    if (groupData) usernames = groupData.members;
  } else if (chat.startsWith('dm:')) {
    usernames = chat.slice(3).split(':');
  }

  const devBadge = getDevBadgeColor();
  const rows = usernames.length ? await redis.mget(...usernames.map(u => 'user:' + u)) : [];
  const onlineKeys = usernames.length ? await redis.mget(...usernames.map(u => 'online:' + u)) : [];

  let onlineCount = 0;
  const list = usernames.map((u, i) => {
    const r = rows[i] || { name: u, username: u };
    const isOnline = !!onlineKeys[i];
    if (isOnline) onlineCount++;
    const isOwner = groupData ? groupData.owner === u : u === 'aldev';
    const isAdmin = groupData ? (groupData.admins || [groupData.owner]).includes(u) : true;

    return {
      username: u,
      name: r.name || u,
      v: !!r.verified || u === 'aldev',
      badgeColor: u === 'aldev' ? devBadge : 'blue',
      a: r.av || 0,
      online: isOnline,
      role: isOwner ? 'owner' : isAdmin ? 'admin' : 'member'
    };
  });

  res.json({ total: usernames.length, onlineCount, members: list });
}));

app.get('/api/users', auth, h(async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().replace(/^@/, '').trim();
  if (q.length < 2) return res.json([]);
  const all = await redis.smembers('users');
  const rows = await redis.mget(...all.map(u => 'user:' + u));
  const devBadge = getDevBadgeColor();
  const found = rows.filter(r => r && (r.username.includes(q) || r.name.toLowerCase().includes(q)))
    .map(r => ({ 
      username: r.username, 
      name: r.name, 
      v: !!r.verified || r.username === 'aldev', 
      badgeColor: r.username === 'aldev' ? devBadge : 'blue',
      a: r.av || 0
    }));
  res.json(found.filter(x => x.username !== req.u).slice(0, 20));
}));

const canTypeIn = (u, chat) =>
  chat === 'global' || chat.startsWith('grp:') || (chat.startsWith('dm:') && chat.slice(3).split(':').includes(u));

app.get('/api/sync', auth, h(async (req, res) => {
  const chat = String(req.query.chat || '');
  const [vers, typing] = await Promise.all([
    redis.mget('ver:' + req.u, 'ver:global'),
    chat && canTypeIn(req.u, chat) ? redis.zrange('typing:' + chat, Date.now() - 5000, '+inf', { byScore: true }) : Promise.resolve([]),
    req.query.hb ? redis.set('online:' + req.u, Date.now(), { ex: 30 }) : Promise.resolve(),
  ]);
  res.json({
    v: (vers[0] || 0) + '.' + (vers[1] || 0),
    chat,
    typing: (typing || []).map(String).filter(x => x !== req.u),
  });
}));

app.post('/api/typing', auth, h(async (req, res) => {
  const chat = String(req.body.chat || '');
  if (!chat || !canTypeIn(req.u, chat)) return res.json({ ok: 0 });
  const p = redis.pipeline();
  p.zadd('typing:' + chat, { score: Date.now(), member: req.u });
  p.expire('typing:' + chat, 20);
  await p.exec();
  res.json({ ok: 1 });
}));

app.get('/api/chats', auth, h(async (req, res) => {
  const u = req.u;
  const rawIds = await redis.smembers('uchats:' + u);
  // buang chat pribadi dengan bot lama
  const deadDm = rawIds.filter(i => i.startsWith('dm:') && i.slice(3).split(':').includes(LEGACY_BOT));
  if (deadDm.length) await Promise.all([redis.srem('uchats:' + u, ...deadDm), redis.del(...deadDm.map(i => 'c:' + i))]);
  const uniqueIds = [...new Set(['global', ...rawIds.filter(i => !deadDm.includes(i))])];
  const gids = uniqueIds.filter(i => i.startsWith('grp:'));
  const groups = gids.length ? await redis.mget(...gids.map(g => 'group:' + g.slice(4))) : [];
  // buang sisa bot lama dari anggota grup
  await Promise.all(groups.filter(g => g && g.members.includes(LEGACY_BOT)).map(g => {
    g.members = g.members.filter(x => x !== LEGACY_BOT);
    g.admins = (g.admins || []).filter(x => x !== LEGACY_BOT);
    return redis.set('group:' + g.id, g);
  }));
  const gm = {};
  gids.forEach((g, i) => (gm[g] = groups[i]));
  const p = redis.pipeline();
  uniqueIds.forEach(i => { p.llen('c:' + i); p.lindex('c:' + i, -1); });
  const r = await p.exec();
  const out = uniqueIds.map((id, i) => {
    const count = r[i * 2], last = r[i * 2 + 1];
    if (id === 'global') return { id, type: 'global', title: SYSTEM_CONFIG.mainGroupName, avatar: SYSTEM_CONFIG.mainGroupAvatar, count, last, verified: true };
    if (id.startsWith('dm:')) {
      const other = id.slice(3).split(':').find(x => x !== u);
      return { id, type: 'dm', title: other, other, count, last };
    }
    const g = gm[id];
    if (!g) return null;
    return { id, type: 'group', title: g.name, avatar: g.avatar || null, code: g.id, members: g.members.length, count, last };
  }).filter(Boolean);
  // preview terakhir jangan pesan bot lama
  await Promise.all(out.map(async c => {
    if (c.last && c.last.u === LEGACY_BOT) {
      const tail = await redis.lrange('c:' + c.id, -20, -1);
      c.last = [...tail].reverse().find(m => m && m.u !== LEGACY_BOT) || null;
    }
  }));
  res.json(out);
}));

app.get('/api/messages', auth, h(async (req, res) => {
  const chat = String(req.query.chat || '');
  if (!(await access(req.u, chat)).ok) return res.status(403).json({ error: 'Akses ditolak' });

  const [ttlRaw, total] = await Promise.all([redis.get('setting:ttl:' + req.u + ':' + chat), redis.llen('c:' + chat)]);
  const ttl = parseInt(ttlRaw || 0, 10);
  const now = Date.now();
  const start = Math.max(0, total - 200);
  const raw = total ? await redis.lrange('c:' + chat, start, -1) : [];
  const msgs = [];
  raw.forEach((m, k) => {
    if (!m || m.u === LEGACY_BOT) return;
    if (ttl > 0 && (now - m.ts) >= ttl * 1000) return;
    msgs.push({ ...m, i: start + k });
  });
  res.json({ start, total, msgs });
}));

// ---------- Kirim Pesan ----------
app.post('/api/send', auth, h(async (req, res) => {
  const chat = String(req.body.chat || '');
  const text = String(req.body.text || '').trim().slice(0, 2000);
  const audio = req.body.audio || null;
  if (!text && !audio) return res.status(400).json({ error: 'Pesan kosong' });

  const acc = await access(req.u, chat);
  if (!acc.ok) return res.status(403).json({ error: 'Tidak boleh kirim pesan' });

  const msgObj = { u: req.u, t: text, audio: audio, ts: Date.now(), r: {} };

  // balas pesan: isi kutipan diambil dari database biar nggak bisa dipalsuin
  if (req.body.reply != null) {
    const ri = parseInt(req.body.reply, 10);
    if (ri >= 0) {
      const o = await redis.lindex('c:' + chat, ri);
      if (o && !o.deleted) msgObj.re = { u: o.u, i: ri, t: String(o.audio ? '🎙️ Pesan suara' : o.t || '').slice(0, 80) };
    }
  }

  await redis.rpush('c:' + chat, msgObj);
  await Promise.all([
    redis.incr('msgs:' + req.u),
    bump(chat, acc.members || []),
    redis.zrem('typing:' + chat, req.u),
    ...(chat.startsWith('dm:') ? acc.members.map(m => redis.sadd('uchats:' + m, chat)) : []),
  ]);
  res.json({ ok: 1 });
}));

app.post('/api/delete-message', auth, h(async (req, res) => {
  const { chat, idx } = req.body;
  const u = req.u;
  const acc = await access(u, chat);
  if (!acc.ok || !(idx >= 0)) return res.status(400).json({ error: 'Gagal menghapus' });

  const m = await redis.lindex('c:' + chat, idx);
  if (!m) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  
  if (m.u !== u && u !== 'aldev') {
    return res.status(403).json({ error: 'Kamu hanya bisa menghapus pesan milikmu sendiri' });
  }

  m.t = '🚮 Pesan ini telah dihapus';
  delete m.audio;
  m.deleted = true;
  
  await redis.lset('c:' + chat, idx, m);
  await bump(chat, acc.members || []);
  res.json({ ok: 1 });
}));

app.post('/api/edit-message', auth, h(async (req, res) => {
  const { chat } = req.body;
  const idx = parseInt(req.body.idx, 10);
  const text = String(req.body.text || '').trim().slice(0, 2000);
  const acc = await access(req.u, chat);
  if (!acc.ok || !(idx >= 0) || !text) return res.status(400).json({ error: 'Gagal mengedit' });
  const m = await redis.lindex('c:' + chat, idx);
  if (!m || m.deleted) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  if (m.u !== req.u) return res.status(403).json({ error: 'Kamu hanya bisa mengedit pesan milikmu sendiri' });
  if (m.audio) return res.status(400).json({ error: 'Voice note tidak bisa diedit' });
  m.t = text;
  m.edited = true;
  await redis.lset('c:' + chat, idx, m);
  await bump(chat, acc.members || []);
  res.json({ ok: 1 });
}));

app.post('/api/react', auth, h(async (req, res) => {
  const { chat, emoji } = req.body;
  const idx = parseInt(req.body.idx, 10);
  const u = req.u;
  const acc = await access(u, chat);
  if (!acc.ok || !EMOJI.includes(emoji) || !(idx >= 0)) return res.status(400).json({ error: 'Gagal' });
  const m = await redis.lindex('c:' + chat, idx);
  if (!m || m.deleted) return res.status(404).json({ error: 'Pesan tidak ada atau terhapus' });
  m.r = m.r || {};
  const arr = m.r[emoji] || [];
  const i = arr.indexOf(u);
  if (i >= 0) arr.splice(i, 1);
  else { arr.push(u); await redis.incr('reacts:' + u); }
  if (arr.length) m.r[emoji] = arr; else delete m.r[emoji];
  await redis.lset('c:' + chat, idx, m);
  await bump(chat, acc.members || []);
  res.json({ ok: 1 });
}));

app.post('/api/settings/ttl', auth, h(async (req, res) => {
  const { chat, ttl } = req.body;
  await redis.set('setting:ttl:' + req.u + ':' + chat, ttl || 0);
  res.json({ ok: 1 });
}));

app.get('/api/settings/ttl', auth, h(async (req, res) => {
  const chat = req.query.chat || '';
  const ttl = await redis.get('setting:ttl:' + req.u + ':' + chat) || 0;
  res.json({ ttl: parseInt(ttl, 10) });
}));

// ---------- Management Grup, Admin, & Kick/Add ----------
app.post('/api/groups', auth, h(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Nama grup wajib diisi' });
  const id = crypto.randomBytes(4).toString('hex');
  const groupObj = { id, name, avatar: null, owner: req.u, admins: [req.u], members: [req.u] };
  await redis.set('group:' + id, groupObj);
  await redis.sadd('uchats:' + req.u, 'grp:' + id);
  res.json({ id: 'grp:' + id });
}));

app.post('/api/groups/update', auth, h(async (req, res) => {
  const { code, name, avatar, action, targetUser } = req.body;
  if (code === SYSTEM_CONFIG.mainGroupId || code === 'global') {
    return res.status(403).json({ error: 'Grup utama dikunci dan tidak bisa diubah/dihapus!' });
  }
  const g = await redis.get('group:' + code);
  if (!g) return res.status(404).json({ error: 'Grup tidak ditemukan' });
  
  const isOwner = g.owner === req.u || req.u === 'aldev';
  const isAdmin = (g.admins || [g.owner]).includes(req.u) || isOwner;

  if (!isAdmin) return res.status(403).json({ error: 'Hanya Admin atau Owner grup yang memiliki akses!' });

  if (action === 'delete') {
    if (!isOwner) return res.status(403).json({ error: 'Hanya Owner yang bisa menghapus grup!' });
    await Promise.all([
      redis.del('group:' + code),
      redis.del('c:grp:' + code),
      redis.del('typing:grp:' + code),
      ...g.members.map(m => redis.srem('uchats:' + m, 'grp:' + code)),
    ]);
    await Promise.all(g.members.map(m => redis.incr('ver:' + m)));
    return res.json({ ok: 1 });
  }

  if (action === 'kick' && targetUser) {
    if (targetUser === g.owner) return res.status(400).json({ error: 'Owner grup tidak dapat dikeluarkkan!' });
    g.members = g.members.filter(m => m !== targetUser);
    g.admins = (g.admins || []).filter(a => a !== targetUser);
    await redis.set('group:' + code, g);
    await redis.srem('uchats:' + targetUser, 'grp:' + code);
    await bump('grp:' + code, g.members);
    return res.json({ ok: 1 });
  }

  if (action === 'promote' && targetUser) {
    if (!isOwner) return res.status(403).json({ error: 'Hanya Owner yang bisa menaikkan Admin!' });
    g.admins = g.admins || [];
    if (!g.admins.includes(targetUser)) g.admins.push(targetUser);
    await redis.set('group:' + code, g);
    await bump('grp:' + code, g.members);
    return res.json({ ok: 1 });
  }

  if (name) g.name = String(name).trim().slice(0, 30);
  if (avatar !== undefined) g.avatar = avatar;

  await redis.set('group:' + code, g);
  await bump('grp:' + code, g.members);
  res.json({ ok: 1 });
}));

app.post('/api/groups/join', auth, h(async (req, res) => {
  const code = String(req.body.code || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
  const g = code && (await redis.get('group:' + code));
  if (!g) return res.status(404).json({ error: 'Kode grup tidak ditemukan / tidak valid' });
  if (!g.members.includes(req.u)) {
    if (g.members.length >= 200) return res.status(400).json({ error: 'Grup penuh' });
    g.members.push(req.u);
    await redis.set('group:' + code, g);
    await bump('grp:' + code, g.members);
  }
  await redis.sadd('uchats:' + req.u, 'grp:' + code);
  res.json({ id: 'grp:' + code });
}));

app.post('/api/groups/leave', auth, h(async (req, res) => {
  const code = String(req.body.code || '').replace(/[^a-f0-9]/g, '');
  const g = code && (await redis.get('group:' + code));
  if (!g) return res.status(404).json({ error: 'Grup tidak ditemukan' });
  if (!g.members.includes(req.u)) return res.status(400).json({ error: 'Kamu bukan anggota grup ini' });
  g.members = g.members.filter(m => m !== req.u);
  g.admins = (g.admins || []).filter(a => a !== req.u);
  await redis.srem('uchats:' + req.u, 'grp:' + code);
  if (!g.members.length) {
    await Promise.all([redis.del('group:' + code), redis.del('c:grp:' + code)]);
  } else {
    if (g.owner === req.u) {
      g.owner = g.admins[0] || g.members[0];
      if (!g.admins.includes(g.owner)) g.admins.push(g.owner);
    }
    await redis.set('group:' + code, g);
    await bump('grp:' + code, g.members);
  }
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

if (require.main === module) {
  app.use(express.static(path.join(__dirname, '../public')));
  app.listen(3000, () => console.log('jalan di http://localhost:3000'));
}
module.exports = app;

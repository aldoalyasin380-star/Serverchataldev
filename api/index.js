// ---------- Pendaftaran / Masuk Otomatis (Auto-Login jika akun sudah ada) ----------
app.post('/api/register', h(async (req, res) => {
  const username = clean(req.body.username);
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (username.length < 3) return res.status(400).json({ error: 'Username minimal 3 karakter' });

  // Cek apakah akun sudah pernah dibuat
  const existingUser = await redis.get('user:' + username);

  if (existingUser) {
    // Kalau akun sudah ada, langsung izinkan masuk (Auto-login)
    return res.json({ username: existingUser.username, message: 'Berhasil masuk!' });
  }

  // Kalau akun belum ada, harus isi nama dulu
  if (!name) return res.status(400).json({ error: 'Nama wajib diisi untuk pendaftaran baru' });

  const isAldev = username === 'aldev';
  const userData = {
    username,
    name,
    bio: '',
    av: 0,
    verified: isAldev ? true : false, // Auto centang biru kalau @aldev
    created: Date.now()
  };

  await redis.set('user:' + username, userData);
  await redis.sadd('users', username);
  res.json({ username, message: 'Pendaftaran berhasil!' });
}));

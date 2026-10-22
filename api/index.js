// Tambahan / Update di serverchat/api/index.js
const express = require('express');
const app = express();
app.use(express.json());

// CONFIG UTAMA (Grup Utama dikunci lewat sini)
const SYSTEM_CONFIG = {
  mainGroupId: "group_utama_official",
  mainGroupLocked: true, // Tidak bisa diubah/dihapus via UI umum
  defaultGroupName: "Channel / Grup Utama Aldev",
  defaultAutoDeleteTimer: 0 // 0 = Mati secara default
};

// Mock Database / Memory Storage (Sesuaikan dengan DB lu jika pakai MongoDB/JSON file)
let chatMessages = [];
let groupSettings = {
  [SYSTEM_CONFIG.mainGroupId]: {
    name: SYSTEM_CONFIG.defaultGroupName,
    isVerified: true,
    autoDeleteTimer: SYSTEM_CONFIG.defaultAutoDeleteTimer, // dalam detik, 0 = off
    locked: true
  }
};

let userProfiles = {
  "aldev": {
    username: "aldev",
    name: "Aldo Dev",
    isVerified: true, // Centang biru developer
    role: "Developer"
  }
};

// Endpoint Kirim Pesan dengan dukungan Cek Timer Auto-Delete & VN
app.post('/api/send', (req, res) => {
  const { sender, text, type = 'text', roomId, audioData } = req.body;
  
  const profile = userProfiles[sender] || { isVerified: false };
  const room = groupSettings[roomId] || { autoDeleteTimer: 0 };

  const newMessage = {
    id: Date.now().toString(),
    sender,
    isVerifiedDeveloper: profile.isVerified || sender === 'aldev',
    text,
    type, // 'text', 'vn', 'image'
    audioData: type === 'vn' ? audioData : null,
    timestamp: Date.now(),
    expiresAt: room.autoDeleteTimer > 0 ? Date.now() + (room.autoDeleteTimer * 1000) : null
  };

  chatMessages.push(newMessage);
  res.json({ success: true, message: newMessage });
});

// Endpoint Update Pengaturan Grup (Proteksi Grup Utama)
app.post('/api/group/update', (req, res) => {
  const { roomId, newName, action, requester } = req.body;
  
  if (groupSettings[roomId]?.locked && SYSTEM_CONFIG.mainGroupLocked) {
    if (action === 'delete') {
      return res.status(403).json({ success: false, error: "Grup utama tidak dapat dihapus!" });
    }
    if (newName && requester !== 'aldev') {
      return res.status(403).json({ success: false, error: "Nama grup utama dikunci oleh config developer!" });
    }
  }

  // Eksekusi update jika lolos validasi
  if (action === 'delete') {
    delete groupSettings[roomId];
    chatMessages = chatMessages.filter(m => m.roomId !== roomId);
    return res.json({ success: true, message: "Grup berhasil dihapus." });
  }

  if (newName && groupSettings[roomId]) {
    groupSettings[roomId].name = newName;
  }

  res.json({ success: true, group: groupSettings[roomId] });
});

// Background Worker / Cleaner untuk Auto-Delete Chat
setInterval(() => {
  const now = Date.now();
  chatMessages = chatMessages.filter(msg => {
    if (!msg.expiresAt) return true;
    return now < msg.expiresAt;
  });
}, 1000);

module.exports = app;

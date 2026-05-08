require('dotenv').config();
const express = require('express');
const multer = require('multer');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const META_LOCAL = path.join(__dirname, 'metadata.json');

const useCloud = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY);
let cloudinary, CloudinaryStorage;

if (useCloud) {
  cloudinary = require('cloudinary').v2;
  CloudinaryStorage = require('multer-storage-cloudinary').CloudinaryStorage;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

app.use(express.static('public'));
app.use(express.json());

// ── Metadata helpers (store in local file + Cloudinary raw backup) ──
const META_PUBLIC_ID = 'yugan_metadata';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function loadMeta() {
  if (fs.existsSync(META_LOCAL)) {
    try { return JSON.parse(fs.readFileSync(META_LOCAL, 'utf8')); } catch {}
  }
  if (useCloud) {
    try {
      const url = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/${META_PUBLIC_ID}`;
      const body = await httpsGet(url + '?_=' + Date.now());
      const data = JSON.parse(body);
      fs.writeFileSync(META_LOCAL, JSON.stringify(data));
      return data;
    } catch {}
  }
  return { folders: [], photos: {} };
}

async function saveMeta(data) {
  fs.writeFileSync(META_LOCAL, JSON.stringify(data));
  if (useCloud) {
    const b64 = Buffer.from(JSON.stringify(data)).toString('base64');
    await cloudinary.uploader.upload(
      `data:application/json;base64,${b64}`,
      { public_id: META_PUBLIC_ID, resource_type: 'raw', overwrite: true }
    );
  }
}

// ── Multer setup ──
function makeUpload(folder) {
  if (useCloud) {
    const storage = new CloudinaryStorage({
      cloudinary,
      params: { folder: `yugan/${folder}`, allowed_formats: ['jpg','jpeg','png','gif','webp','bmp'] },
    });
    return multer({ storage });
  }
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, folder);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
  });
  return multer({ storage });
}

// ── GET all folders ──
app.get('/api/folders', async (req, res) => {
  if (useCloud) {
    const meta = await loadMeta();
    return res.json(meta.folders || []);
  }
  if (!fs.existsSync(UPLOADS_DIR)) return res.json([]);
  res.json(fs.readdirSync(UPLOADS_DIR).filter(f =>
    fs.statSync(path.join(UPLOADS_DIR, f)).isDirectory()
  ));
});

// ── POST create folder ──
app.post('/api/folders', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (useCloud) {
    const meta = await loadMeta();
    if (!meta.folders.includes(name)) meta.folders.push(name);
    if (!meta.photos[name]) meta.photos[name] = [];
    await saveMeta(meta);
    return res.json({ success: true });
  }
  fs.mkdirSync(path.join(UPLOADS_DIR, name), { recursive: true });
  res.json({ success: true });
});

// ── DELETE folder ──
app.delete('/api/folders/:folder', async (req, res) => {
  const { folder } = req.params;
  if (useCloud) {
    const meta = await loadMeta();
    const photos = meta.photos[folder] || [];
    for (const p of photos) {
      try { await cloudinary.uploader.destroy(p.public_id); } catch {}
    }
    meta.folders = meta.folders.filter(f => f !== folder);
    delete meta.photos[folder];
    await saveMeta(meta);
    return res.json({ success: true });
  }
  fs.rmSync(path.join(UPLOADS_DIR, folder), { recursive: true, force: true });
  res.json({ success: true });
});

// ── GET photos in folder ──
app.get('/api/folders/:folder/photos', async (req, res) => {
  const { folder } = req.params;
  if (useCloud) {
    const meta = await loadMeta();
    return res.json(meta.photos[folder] || []);
  }
  const dir = path.join(UPLOADS_DIR, folder);
  if (!fs.existsSync(dir)) return res.json([]);
  const exts = ['.jpg','.jpeg','.png','.gif','.webp','.bmp'];
  res.json(fs.readdirSync(dir).filter(f => exts.includes(path.extname(f).toLowerCase())));
});

// ── POST upload photos ──
app.post('/api/folders/:folder/photos', async (req, res) => {
  const { folder } = req.params;
  const upload = makeUpload(folder);
  upload.array('photos')(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (useCloud) {
      try {
        const meta = await loadMeta();
        if (!meta.folders.includes(folder)) meta.folders.push(folder);
        if (!meta.photos[folder]) meta.photos[folder] = [];
        for (const file of req.files) {
          const url = file.secure_url || file.path || (file.cloudinary && file.cloudinary.secure_url);
          const pid = file.public_id || file.filename;
          if (!url) return res.status(500).json({ error: 'No URL from Cloudinary. File keys: ' + Object.keys(file).join(',') });
          meta.photos[folder].push({ url, public_id: pid });
        }
        await saveMeta(meta);
        return res.json({ uploaded: req.files.length });
      } catch (e) {
        return res.status(500).json({ error: 'Meta save failed: ' + e.message });
      }
    }
    res.json({ uploaded: req.files.length });
  });
});

// ── DELETE a photo ──
app.delete('/api/folders/:folder/photos', async (req, res) => {
  const { folder } = req.params;
  const { public_id, filename } = req.query;
  if (useCloud && public_id) {
    try { await cloudinary.uploader.destroy(decodeURIComponent(public_id)); } catch {}
    const meta = await loadMeta();
    meta.photos[folder] = (meta.photos[folder] || []).filter(p => p.public_id !== decodeURIComponent(public_id));
    await saveMeta(meta);
    return res.json({ success: true });
  }
  const file = path.join(UPLOADS_DIR, folder, filename);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ success: true });
});

// ── GET QR code ──
app.get('/api/qrcode', async (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.headers.host}`;
  const qr = await qrcode.toDataURL(baseUrl, { width: 300, margin: 2 });
  res.json({ qr, url: baseUrl });
});

// ── Status ──
app.get('/api/status', (req, res) => {
  res.json({ useCloud, cloudName: process.env.CLOUDINARY_CLOUD_NAME || 'not set', metaExists: fs.existsSync(META_LOCAL) });
});

// ── Debug: dump raw metadata ──
app.get('/api/debug/meta', (req, res) => {
  if (fs.existsSync(META_LOCAL)) {
    try { return res.json(JSON.parse(fs.readFileSync(META_LOCAL, 'utf8'))); } catch (e) { return res.json({ error: e.message }); }
  }
  res.json({ error: 'No metadata file found' });
});

app.listen(PORT, () => console.log(`Yugan running at http://localhost:${PORT}`));

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

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

// ── Multer ──
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

// ── Status check ──
app.get('/api/status', (req, res) => {
  res.json({
    useCloud,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || 'not set',
    hasKey: !!process.env.CLOUDINARY_API_KEY,
  });
});

// ── Debug: ping Cloudinary ──
app.get('/api/debug/ping', (req, res) => {
  res.json({ ok: true, useCloud, time: new Date().toISOString() });
});

app.get('/api/debug/cloudinary', (req, res) => {
  if (!useCloud) return res.json({ error: 'Cloud not enabled' });
  cloudinary.api.ping()
    .then(r => res.json({ ping: r, ok: true }))
    .catch(e => res.json({ raw: String(e), http_code: e && e.http_code, msg: e && e.message, detail: e && e.error }));
});

app.get('/api/debug/resources', (req, res) => {
  if (!useCloud) return res.json({ error: 'Cloud not enabled' });
  cloudinary.api.resources({ type: 'upload', max_results: 10 })
    .then(r => res.json({ count: r.resources ? r.resources.length : 0, resources: r.resources || [] }))
    .catch(e => res.json({ raw: String(e), http_code: e && e.http_code, msg: e && e.message, detail: e && e.error }));
});

// ── GET all folders ──
app.get('/api/folders', async (req, res) => {
  if (useCloud) {
    try {
      // List all resources under yugan/ and extract unique folder names
      const result = await cloudinary.api.resources({
        type: 'upload',
        prefix: 'yugan/',
        max_results: 500,
      });
      const folders = [...new Set(
        result.resources
          .map(r => r.public_id.split('/')[1])
          .filter(Boolean)
      )];
      return res.json(folders);
    } catch (e) {
      console.error('Cloudinary folders error:', e.message);
      return res.json([]);
    }
  }
  if (!fs.existsSync(UPLOADS_DIR)) return res.json([]);
  const folders = fs.readdirSync(UPLOADS_DIR).filter(f =>
    fs.statSync(path.join(UPLOADS_DIR, f)).isDirectory()
  );
  res.json(folders);
});

// ── POST create folder ──
app.post('/api/folders', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (useCloud) {
    try { await cloudinary.api.create_folder(`yugan/${name}`); } catch {}
    return res.json({ success: true });
  }
  fs.mkdirSync(path.join(UPLOADS_DIR, name), { recursive: true });
  res.json({ success: true });
});

// ── DELETE folder ──
app.delete('/api/folders/:folder', async (req, res) => {
  const { folder } = req.params;
  if (useCloud) {
    try { await cloudinary.api.delete_resources_by_prefix(`yugan/${folder}`); } catch {}
    try { await cloudinary.api.delete_folder(`yugan/${folder}`); } catch {}
    return res.json({ success: true });
  }
  fs.rmSync(path.join(UPLOADS_DIR, folder), { recursive: true, force: true });
  res.json({ success: true });
});

// ── GET photos in folder ──
app.get('/api/folders/:folder/photos', async (req, res) => {
  const { folder } = req.params;
  if (useCloud) {
    try {
      const result = await cloudinary.api.resources({
        type: 'upload',
        prefix: `yugan/${folder}/`,
        max_results: 500,
      });
      return res.json(result.resources.map(r => ({
        url: r.secure_url,
        public_id: r.public_id,
      })));
    } catch {
      return res.json([]);
    }
  }
  const dir = path.join(UPLOADS_DIR, folder);
  if (!fs.existsSync(dir)) return res.json([]);
  const exts = ['.jpg','.jpeg','.png','.gif','.webp','.bmp'];
  res.json(fs.readdirSync(dir).filter(f => exts.includes(path.extname(f).toLowerCase())));
});

// ── POST upload photos ──
app.post('/api/folders/:folder/photos', (req, res) => {
  const upload = makeUpload(req.params.folder);
  upload.array('photos')(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ uploaded: req.files.length });
  });
});

// ── DELETE a photo ──
app.delete('/api/folders/:folder/photos', async (req, res) => {
  const { folder } = req.params;
  const { public_id, filename } = req.query;
  if (useCloud && public_id) {
    try { await cloudinary.uploader.destroy(public_id); } catch {}
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

app.listen(PORT, () => console.log(`Yugan running at http://localhost:${PORT}`));

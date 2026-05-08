require('dotenv').config();
const express = require('express');
const multer = require('multer');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

// ── Cloud storage (Cloudinary) if env vars present, else local ──
let cloudinary, CloudinaryStorage;
const useCloud = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY);

if (useCloud) {
  cloudinary = require('cloudinary').v2;
  CloudinaryStorage = require('multer-storage-cloudinary').CloudinaryStorage;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// ── Multer setup ──
function makeUpload(folderParam) {
  if (useCloud) {
    const storage = new CloudinaryStorage({
      cloudinary,
      params: (req) => ({
        folder: `yugan/${req.params[folderParam]}`,
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
        public_id: `${Date.now()}`,
      }),
    });
    return multer({ storage });
  }
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, req.params[folderParam]);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
  });
  return multer({ storage });
}

app.use(express.static('public'));
app.use(express.json());

// ── Folder metadata store (works for both local and cloud) ──
const META_FILE = path.join(__dirname, 'folders-meta.json');
function readMeta() {
  if (!fs.existsSync(META_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; }
}
function writeMeta(data) { fs.writeFileSync(META_FILE, JSON.stringify(data, null, 2)); }

// ── Routes ──

// GET all folders
app.get('/api/folders', async (req, res) => {
  if (useCloud) {
    const meta = readMeta();
    return res.json(Object.keys(meta));
  }
  if (!fs.existsSync(UPLOADS_DIR)) return res.json([]);
  const folders = fs.readdirSync(UPLOADS_DIR).filter(f =>
    fs.statSync(path.join(UPLOADS_DIR, f)).isDirectory()
  );
  res.json(folders);
});

// POST create folder
app.post('/api/folders', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (useCloud) {
    const meta = readMeta();
    meta[name] = meta[name] || [];
    writeMeta(meta);
  } else {
    fs.mkdirSync(path.join(UPLOADS_DIR, name), { recursive: true });
  }
  res.json({ success: true });
});

// DELETE folder
app.delete('/api/folders/:folder', async (req, res) => {
  const { folder } = req.params;
  if (useCloud) {
    try { await cloudinary.api.delete_resources_by_prefix(`yugan/${folder}`); } catch {}
    const meta = readMeta();
    delete meta[folder];
    writeMeta(meta);
  } else {
    fs.rmSync(path.join(UPLOADS_DIR, folder), { recursive: true, force: true });
  }
  res.json({ success: true });
});

// GET photos in folder
app.get('/api/folders/:folder/photos', async (req, res) => {
  const { folder } = req.params;
  if (useCloud) {
    const meta = readMeta();
    return res.json(meta[folder] || []);
  }
  const dir = path.join(UPLOADS_DIR, folder);
  if (!fs.existsSync(dir)) return res.json([]);
  const exts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const photos = fs.readdirSync(dir).filter(f =>
    exts.includes(path.extname(f).toLowerCase())
  );
  res.json(photos);
});

// POST upload photos
app.post('/api/folders/:folder/photos', (req, res, next) => {
  const upload = makeUpload('folder');
  upload.array('photos')(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (useCloud) {
      const meta = readMeta();
      if (!meta[req.params.folder]) meta[req.params.folder] = [];
      for (const file of req.files) {
        meta[req.params.folder].push({ url: file.path, public_id: file.filename });
      }
      writeMeta(meta);
      return res.json({ uploaded: req.files.length });
    }
    res.json({ uploaded: req.files.length });
  });
});

// DELETE a photo
app.delete('/api/folders/:folder/photos/:photo', async (req, res) => {
  const { folder, photo } = req.params;
  if (useCloud) {
    const meta = readMeta();
    const idx = (meta[folder] || []).findIndex(p => p.public_id === photo);
    if (idx !== -1) {
      try { await cloudinary.uploader.destroy(photo); } catch {}
      meta[folder].splice(idx, 1);
      writeMeta(meta);
    }
  } else {
    const file = path.join(UPLOADS_DIR, folder, photo);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  res.json({ success: true });
});

// GET QR code
app.get('/api/qrcode', async (req, res) => {
  const baseUrl = process.env.BASE_URL ||
    `${req.protocol}://${req.headers.host}`;
  const qr = await qrcode.toDataURL(baseUrl, { width: 300, margin: 2 });
  res.json({ qr, url: baseUrl });
});

app.listen(PORT, () => {
  console.log(`\n Yugan Photo Gallery running at http://localhost:${PORT}\n`);
});

import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomSeedString } from './lib/prng.js';
import { extractPaletteFromThumb } from './lib/procedural.js';
import {
  generateGlitchBackground,
  glitchUploadedImage,
  prepareUploadedImage,
} from './lib/glitchEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let imageState = null;

app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const quality = Number(req.body.quality) || 85;
    const prepared = await prepareUploadedImage(req.file.buffer, quality);
    prepared.palette = extractPaletteFromThumb(prepared.origThumb);
    imageState = prepared;

    res.json({
      width: imageState.width,
      height: imageState.height,
      palette: imageState.palette,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/original', (req, res) => {
  if (!imageState) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(imageState.origJpeg);
});

app.post('/api/glitch', async (req, res) => {
  try {
    const mode = req.body.mode === 'background' ? 'background' : 'image';
    const seed =
      typeof req.body.seed === 'string' && req.body.seed.trim()
        ? req.body.seed.trim().slice(0, 64)
        : randomSeedString();

    const intensity = Math.max(1, Math.min(30, Number(req.body.intensity) || 6));
    const maxDrift = Math.max(15, Math.min(150, Number(req.body.maxDrift) || 75));
    const quality = Math.max(30, Math.min(96, Number(req.body.quality) || 85));

    let result;

    if (mode === 'image') {
      if (!imageState) {
        return res.status(400).json({ error: 'Upload an image first' });
      }
      if (quality !== imageState.quality) {
        const refreshed = await prepareUploadedImage(imageState.rawSource, quality);
        refreshed.palette = imageState.palette;
        imageState = refreshed;
      }
      result = await glitchUploadedImage(imageState, {
        seed,
        intensity,
        maxDrift,
        includeDqt: Boolean(req.body.includeDqt),
      });
    } else {
      result = await generateGlitchBackground({
        engine: req.body.engine || 'procedural-jpeg',
        seed,
        pattern: req.body.pattern || 'auto',
        width: req.body.width || 1024,
        height: req.body.height || 1024,
        intensity,
        maxDrift,
        quality,
        imagePalette: imageState?.palette || null,
        matchImagePalette: Boolean(req.body.matchImagePalette),
      });
    }

    const safeSeedHeader = seed.replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Glitch-Seed', safeSeedHeader);
    res.setHeader('X-Glitch-Diff', result.diff.toFixed(1));
    res.setHeader('X-Glitch-Attempts', String(result.attempts));
    res.setHeader('X-Glitch-Engine', result.engine);
    res.setHeader('X-Glitch-Fallback', String(result.fallback));
    res.send(result.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JPEG Glitcher running at http://localhost:${PORT}`);
});
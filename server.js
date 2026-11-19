import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory state for the active working image
let state = {
  rawSource: null,
  quality: 85,
  baseJpeg: null,
  safeIndices: [],
  origThumb: null,
  origBottomGray: 0,
  width: 0,
  height: 0,
};

/**
 * Finds byte offsets inside the entropy-coded JPEG scan data that are safe
 * to overwrite without breaking JPEG marker framing or byte-stuffed 0xFF 0x00 pairs.
 */
function extractSafeIndices(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('Invalid JPEG header');
  }

  let offset = 2;
  let scanStart = -1;

  while (offset < buf.length - 1) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < buf.length && buf[offset] === 0xff) offset++;
    if (offset >= buf.length) break;

    const marker = buf[offset++];

    // Standalone markers (no length field)
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }

    if (offset + 1 >= buf.length) break;
    const length = buf.readUInt16BE(offset);

    if (marker === 0xda) {
      // Start of Scan (SOS): entropy-coded data begins right after this header
      scanStart = offset + length;
      break;
    }

    offset += length;
  }

  if (scanStart === -1 || scanStart >= buf.length - 2) {
    throw new Error('Could not find JPEG scan data');
  }

  const safe = [];
  let i = scanStart;
  while (i < buf.length - 1) {
    if (buf[i] === 0xff) {
      const next = buf[i + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        // Skip byte-stuffed 0xFF and restart markers
        i += 2;
        continue;
      }
      if (next === 0xff) {
        i += 1;
        continue;
      }
      // Hit EOI (0xD9) or another structural marker
      break;
    }
    safe.push(i);
    i++;
  }

  // Keep a small untouched margin at the start/end of scan
  const margin = Math.min(16, Math.floor(safe.length * 0.01));
  return safe.slice(margin, Math.max(margin, safe.length - margin));
}

/**
 * Estimates what fraction of the bottom 25% of a 32x32 RGB thumbnail is flat mid-gray
 * (libjpeg's default fill when a corrupted scan truncates early).
 */
function bottomGrayRatio(thumb) {
  const start = 24 * 32 * 3;
  const totalPixels = 8 * 32;
  let grayPixels = 0;

  for (let i = start; i < thumb.length; i += 3) {
    if (
      Math.abs(thumb[i] - 128) <= 3 &&
      Math.abs(thumb[i + 1] - 128) <= 3 &&
      Math.abs(thumb[i + 2] - 128) <= 3
    ) {
      grayPixels++;
    }
  }
  return grayPixels / totalPixels;
}

async function decodeThumb(jpegBuffer) {
  return sharp(jpegBuffer, { failOn: 'none' })
    .resize(32, 32, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
}

async function prepareBaseline(quality) {
  const q = Math.max(20, Math.min(98, Number(quality) || 85));

  const { data, info } = await sharp(state.rawSource)
    .rotate()
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({
      quality: q,
      progressive: false, // Baseline JPEG produces crisp horizontal color bands
      chromaSubsampling: '4:2:0',
      mozjpeg: false,
    })
    .toBuffer({ resolveWithObject: true });

  const safeIndices = extractSafeIndices(data);
  const origThumb = await decodeThumb(data);

  state.quality = q;
  state.baseJpeg = data;
  state.safeIndices = safeIndices;
  state.origThumb = origThumb;
  state.origBottomGray = bottomGrayRatio(origThumb);
  state.width = info.width;
  state.height = info.height;
}

function mutateOnce(baseBuf, safeIndices, mutations) {
  const out = Buffer.from(baseBuf);
  const count = Math.min(mutations, safeIndices.length);

  for (let m = 0; m < count; m++) {
    const pos = safeIndices[Math.floor(Math.random() * safeIndices.length)];
    const oldVal = out[pos];
    // Pick any byte 0x00..0xFE (never write 0xFF so we never inject a fake marker)
    let newVal = Math.floor(Math.random() * 255);
    if (newVal === oldVal) newVal = (newVal + 1) % 255;
    out[pos] = newVal;
  }
  return out;
}

app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    state.rawSource = req.file.buffer;
    const quality = Number(req.body.quality) || 85;
    await prepareBaseline(quality);

    res.json({
      width: state.width,
      height: state.height,
      bytes: state.baseJpeg.length,
      safeBytes: state.safeIndices.length,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/original', (req, res) => {
  if (!state.baseJpeg) return res.status(404).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(state.baseJpeg);
});

app.post('/api/glitch', async (req, res) => {
  if (!state.baseJpeg || state.safeIndices.length === 0) {
    return res.status(400).json({ error: 'Upload an image first' });
  }

  const mutations = Math.max(1, Math.min(40, Number(req.body.mutations) || 6));
  const maxDrift = Math.max(10, Math.min(160, Number(req.body.maxDrift) || 70));
  const quality = Math.max(20, Math.min(98, Number(req.body.quality) || 85));

  try {
    if (quality !== state.quality) {
      await prepareBaseline(quality);
    }

    const maxAttempts = 18;
    let best = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const candidate = mutateOnce(state.baseJpeg, state.safeIndices, mutations);

      let thumb;
      try {
        thumb = await decodeThumb(candidate);
      } catch {
        continue; // Undecodable — skip
      }

      if (thumb.length !== state.origThumb.length) continue;

      // Reject images where the decoder gave up and filled the bottom with gray
      const addedGray = bottomGrayRatio(thumb) - state.origBottomGray;
      const truncated = addedGray > 0.35;

      // Mean Absolute Difference against original (0..255)
      let diffSum = 0;
      for (let i = 0; i < thumb.length; i++) {
        diffSum += Math.abs(thumb[i] - state.origThumb[i]);
      }
      const mad = diffSum / thumb.length;

      // Keep best decoded candidate as fallback so rapid clicking always yields a result
      const score = Math.abs(mad - maxDrift * 0.55) + (truncated ? 100 : 0);
      if (!best || score < best.score) {
        best = { buffer: candidate, mad, attempt, score, fallback: true };
      }

      if (!truncated && mad >= 3.5 && mad <= maxDrift) {
        best = { buffer: candidate, mad, attempt, fallback: false };
        break;
      }
    }

    if (!best) {
      return res.status(500).json({ error: 'Failed to generate decodable glitch' });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Glitch-Diff', best.mad.toFixed(1));
    res.setHeader('X-Glitch-Attempts', String(best.attempt));
    res.setHeader('X-Glitch-Fallback', String(best.fallback));
    res.send(best.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JPEG Glitcher running at http://localhost:${PORT}`);
});
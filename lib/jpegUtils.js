import { clampByte } from './prng.js';

export function parseJpegStructure(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('Invalid JPEG header');
  }

  let offset = 2;
  let scanStart = -1;
  const dqtTables = [];

  while (offset < buf.length - 1) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < buf.length && buf[offset] === 0xff) offset++;
    if (offset >= buf.length) break;

    const marker = buf[offset++];

    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }

    if (offset + 1 >= buf.length) break;
    const length = (buf[offset] << 8) | buf[offset + 1];

    if (marker === 0xdb) {
      // Define Quantization Table (DQT)
      const segEnd = Math.min(buf.length, offset + length);
      let p = offset + 2;
      while (p < segEnd) {
        const pqTq = buf[p++];
        const pq = pqTq >> 4;
        const tq = pqTq & 0x0f;
        const byteCount = pq === 0 ? 64 : 128;
        if (p + byteCount > segEnd) break;
        if (pq === 0) {
          dqtTables.push({ id: tq, start: p, length: 64 });
        }
        p += byteCount;
      }
    } else if (marker === 0xda) {
      // Start of Scan (SOS)
      scanStart = offset + length;
      break;
    }

    offset += length;
  }

  if (scanStart === -1 || scanStart >= buf.length - 2) {
    throw new Error('Could not locate JPEG scan data');
  }

  const safeScanIndices = [];
  let i = scanStart;
  while (i < buf.length - 1) {
    if (buf[i] === 0xff) {
      const next = buf[i + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        i += 2;
        continue;
      }
      if (next === 0xff) {
        i += 1;
        continue;
      }
      break;
    }
    safeScanIndices.push(i);
    i++;
  }

  // Keep start accessible for overscan mutations; leave tiny tail margin before EOI
  const headMargin = Math.min(2, safeScanIndices.length);
  const tailMargin = Math.min(12, Math.floor(safeScanIndices.length * 0.01));
  const trimmed = safeScanIndices.slice(
    headMargin,
    Math.max(headMargin, safeScanIndices.length - tailMargin)
  );

  return { safeScanIndices: trimmed, dqtTables };
}

/**
 * Prepends a sacrificial top overscan strip (mirrored + micro-textured)
 * so forced early-scan mutations take effect before visible row 0.
 */
export function addTopOverscan(rgbBuf, width, height, padTop = 64) {
  const rowBytes = width * 3;
  const out = new Uint8Array((height + padTop) * rowBytes);

  for (let y = 0; y < padTop; y++) {
    const srcY = Math.min(height - 1, padTop - 1 - y);
    const srcOff = srcY * rowBytes;
    const dstOff = y * rowBytes;

    for (let x = 0; x < width; x++) {
      // Deterministic micro-dither guarantees Huffman entropy even on flat skies
      const dither = (((x * 17 + y * 31) ^ (x >> 2)) & 15) - 7;
      const p = x * 3;
      out[dstOff + p] = clampByte(rgbBuf[srcOff + p] + dither);
      out[dstOff + p + 1] = clampByte(rgbBuf[srcOff + p + 1] + dither);
      out[dstOff + p + 2] = clampByte(rgbBuf[srcOff + p + 2] + dither);
    }
  }

  out.set(rgbBuf, padTop * rowBytes);
  return out;
}

/**
 * Mutates JPEG scan bytes (and optionally DQT tables) deterministically using `rng`.
 * Forces 1–2 mutations inside the overscan byte window so row 0 is already glitched.
 */
export function mutateJpeg(
  baseBuf,
  structure,
  rng,
  { mutations = 6, overscanRatio = 0.06, mutateDqt = false, dqtStrength = 6 } = {}
) {
  const out = new Uint8Array(baseBuf);
  const { safeScanIndices, dqtTables } = structure;

  if (mutateDqt && dqtTables.length > 0) {
    for (const table of dqtTables) {
      // Gentle nudge to DC coefficient (index 0) so colors/contrast shift uniformly
      if (rng.next() < 0.75) {
        const dcPos = table.start;
        const factor = rng.range(0.45, 2.6);
        out[dcPos] = Math.max(4, Math.min(72, Math.round(out[dcPos] * factor)));
      }

      // Mutate AC frequency coefficients for mosaic / painterly block textures
      const acEdits = Math.max(2, Math.min(28, Math.round(dqtStrength * 1.4)));
      for (let e = 0; e < acEdits; e++) {
        const coeffIdx = rng.int(1, 48);
        const pos = table.start + coeffIdx;
        if (rng.next() < 0.45) {
          // Low value -> sharp ringing & color bleed
          out[pos] = rng.int(1, 6);
        } else {
          // High value -> bold quantized mosaic blocks
          out[pos] = rng.int(55, 225);
        }
      }
    }
  }

  const len = safeScanIndices.length;
  if (len === 0) return out;

  const count = Math.min(mutations, len);
  const earlyWindow = Math.max(
    8,
    Math.min(len - 1, Math.floor(len * Math.min(0.18, overscanRatio * 1.15)))
  );

  // Guarantee 1–2 mutations inside the top overscan strip
  const earlyCount = Math.min(count, mutations >= 5 ? 2 : 1);

  for (let m = 0; m < count; m++) {
    let idx;
    if (m < earlyCount) {
      const upper = m === 0 ? Math.max(4, Math.floor(earlyWindow * 0.65)) : earlyWindow;
      idx = rng.int(0, upper);
    } else {
      idx = rng.int(earlyWindow, len - 1);
    }

    const pos = safeScanIndices[idx];
    const oldVal = out[pos];
    let newVal = rng.int(0, 254); // Never write 0xFF
    if (newVal === oldVal) newVal = (newVal + 1) % 255;
    out[pos] = newVal;
  }

  return out;
}

/**
 * Calculates max intensity slider upper bound directly corresponding to image resolution.
 */
export function getMaxIntensity(maxDim = 1024) {
  const d = Math.max(256, Number(maxDim) || 1024);
  return Math.max(16, Math.min(120, Math.round(d / 20)));
}

/**
 * Maps intensity level to actual byte mutations using an exponential e^n curve
 * scaled dynamically to image resolution so glitch density stays perceptually consistent.
 */
export function calculateMutations(intensity, maxDim = 1024) {
  const maxM = getMaxIntensity(maxDim);
  const val = Math.max(1, Math.min(maxM, Number(intensity) || 1));
  const t = maxM > 1 ? (val - 1) / (maxM - 1) : 0;
  return Math.max(1, Math.round(Math.exp(t * Math.log(maxM))));
}

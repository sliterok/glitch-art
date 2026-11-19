import { clampByte, createNoise1D, createNoise2D } from './prng.js';

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
 * Interpolates corruption targets based on the Corruption (0-100) slider
 * according to the specification table:
 * 0–25 (Clean Bands): 1-bit flips | M=6 | maxClip<=0.08 | minDetail>=0.80 | targetLuma 8–22 | minChroma 18–55
 * 26–55 (Readable Glitch): 1-2 bit flips | M=5 | maxClip<=0.18 | minDetail>=0.65 | targetLuma 15–40 | minChroma 25–75
 * 56–80 (Heavy Decay): 2-4 bit / byte edits | M=3 | maxClip<=0.45 | minDetail>=0.35 | targetLuma 30–75 | minChroma 35–100
 * 81–100 (Full Meltdown): Full byte + DQT | M=1 | maxClip<=0.85 | minDetail>=0.10 | targetLuma 50–130 | minChroma 40–130
 */
export function getCorruptionConfig(corruption = 30, autoBalance = true) {
  const c = Math.max(0, Math.min(100, Number(corruption) || 0));

  let mutationMode;
  let defaultM;
  if (c <= 25) {
    mutationMode = '1-bit';
    defaultM = 6;
  } else if (c <= 55) {
    mutationMode = '1-2-bit';
    defaultM = 5;
  } else if (c <= 80) {
    mutationMode = 'nibble';
    defaultM = 3;
  } else {
    mutationMode = 'full-byte';
    defaultM = 1;
  }

  const M = autoBalance ? defaultM : 1;

  function lerp(c0, c1, v0, v1, val) {
    if (val <= c0) return v0;
    if (val >= c1) return v1;
    return v0 + ((val - c0) / (c1 - c0)) * (v1 - v0);
  }

  let maxClipRatio;
  let minDetailRetention;
  let targetLumaMad;
  let minChromaMad;
  let wClip;

  if (c <= 25) {
    maxClipRatio = lerp(0, 25, 0.05, 0.08, c);
    minDetailRetention = lerp(0, 25, 0.85, 0.80, c);
    targetLumaMad = lerp(0, 25, 12, 22, c);
    minChromaMad = lerp(0, 25, 20, 35, c);
    wClip = 320;
  } else if (c <= 55) {
    maxClipRatio = lerp(25, 55, 0.08, 0.18, c);
    minDetailRetention = lerp(25, 55, 0.80, 0.65, c);
    targetLumaMad = lerp(25, 55, 22, 40, c);
    minChromaMad = lerp(25, 55, 35, 50, c);
    wClip = lerp(25, 55, 320, 220, c);
  } else if (c <= 80) {
    maxClipRatio = lerp(55, 80, 0.18, 0.45, c);
    minDetailRetention = lerp(55, 80, 0.65, 0.35, c);
    targetLumaMad = lerp(55, 80, 40, 75, c);
    minChromaMad = lerp(55, 80, 50, 65, c);
    wClip = lerp(55, 80, 220, 140, c);
  } else {
    maxClipRatio = lerp(80, 100, 0.45, 0.85, c);
    minDetailRetention = lerp(80, 100, 0.35, 0.10, c);
    targetLumaMad = lerp(80, 100, 75, 115, c);
    minChromaMad = lerp(80, 100, 65, 85, c);
    wClip = 100;
  }

  return {
    corruption: c,
    autoBalance,
    M,
    mutationMode,
    maxClipRatio,
    minDetailRetention,
    targetLumaMad,
    minChromaMad,
    wClip,
    wDetail: 200,
    wY: 1.0,
    wC: 0.8,
    earlyThreshold: 3.5,
    mutateDqt: c >= 85,
  };
}

/**
 * Divides safe scan indices into K sequential vertical zones.
 * Zone 0 = overscan strip so row 0 glitches cleanly.
 * Zones 1..K-1 = top-to-bottom bands of the visible image.
 */
export function divideScanZones(safeScanIndices, overscanRatio = 0.06, K = 5) {
  const len = safeScanIndices.length;
  if (len === 0) return [];
  const overscanEnd = Math.max(16, Math.min(Math.floor(len * overscanRatio), Math.floor(len * 0.25)));
  const visibleLen = len - overscanEnd;
  const numBands = Math.max(1, K - 1);
  const bandLen = Math.floor(visibleLen / numBands);

  const zones = [];
  zones.push({ id: 0, start: 0, end: overscanEnd, isOverscan: true });
  for (let z = 1; z < K; z++) {
    const start = overscanEnd + (z - 1) * bandLen;
    const end = (z === K - 1) ? len : overscanEnd + z * bandLen;
    zones.push({ id: z, start, end, isOverscan: false });
  }
  return zones;
}

/**
 * Precomputes Y, Cb, Cr, clipping, 8x8 cell ranges, and bottom gray on a 64x64 raw RGB thumbnail.
 */
export function precomputeOrigMetrics(origThumb64) {
  const N = 4096;
  const origY = new Float32Array(N);
  const origCb = new Float32Array(N);
  const origCr = new Float32Array(N);
  const origClip = new Uint8Array(N);
  let origBottomGrayCount = 0;

  for (let i = 0; i < N; i++) {
    const r = origThumb64[i * 3];
    const g = origThumb64[i * 3 + 1];
    const b = origThumb64[i * 3 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    origY[i] = y;
    origCb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    origCr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

    let pinned = 0;
    if (r <= 10 || r >= 245) pinned++;
    if (g <= 10 || g >= 245) pinned++;
    if (b <= 10 || b >= 245) pinned++;
    if (y < 16 || y > 240 || pinned >= 2) origClip[i] = 1;

    if (i >= 3072) {
      if (Math.abs(r - 128) <= 4 && Math.abs(g - 128) <= 4 && Math.abs(b - 128) <= 4) {
        origBottomGrayCount++;
      }
    }
  }

  const origCellRanges = new Float32Array(64);
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      let minY = 255;
      let maxY = 0;
      for (let dy = 0; dy < 8; dy++) {
        const py = cy * 8 + dy;
        const rowOff = py * 64 + cx * 8;
        for (let dx = 0; dx < 8; dx++) {
          const yVal = origY[rowOff + dx];
          if (yVal < minY) minY = yVal;
          if (yVal > maxY) maxY = yVal;
        }
      }
      origCellRanges[cy * 8 + cx] = maxY - minY;
    }
  }

  return {
    origThumb64,
    origY,
    origCb,
    origCr,
    origClip,
    origCellRanges,
    origBottomGray: origBottomGrayCount / 1024,
  };
}

/**
 * Computes readability-aware metrics comparing a 64x64 candidate against origMetrics.
 */
export function computeReadabilityMetrics(
  candThumb64,
  origMetrics,
  startRow = 0,
  config = getCorruptionConfig(30),
  isZoneZero = false
) {
  const { origY, origCb, origCr, origClip, origCellRanges, origBottomGray } = origMetrics;
  const startPixel = startRow * 64;
  const numDownstream = 4096 - startPixel;
  const startCellRow = Math.floor(startRow / 8);

  const candY = new Float32Array(4096);
  let glitchClipCount = 0;
  let origClipCount = 0;
  let lumaDiffSum = 0;
  let chromaDiffSum = 0;

  for (let i = startPixel; i < 4096; i++) {
    const r = candThumb64[i * 3];
    const g = candThumb64[i * 3 + 1];
    const b = candThumb64[i * 3 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    candY[i] = y;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

    let pinned = 0;
    if (r <= 10 || r >= 245) pinned++;
    if (g <= 10 || g >= 245) pinned++;
    if (b <= 10 || b >= 245) pinned++;
    if (y < 16 || y > 240 || pinned >= 2) glitchClipCount++;
    if (origClip[i] === 1) origClipCount++;

    lumaDiffSum += Math.abs(y - origY[i]);
    chromaDiffSum += 0.5 * (Math.abs(cb - origCb[i]) + Math.abs(cr - origCr[i]));
  }

  const addedClipRatio = Math.max(0, (glitchClipCount - origClipCount) / numDownstream);
  const lumaMad = lumaDiffSum / numDownstream;
  const chromaMad = chromaDiffSum / numDownstream;

  let strongCells = 0;
  let retainedCells = 0;
  for (let cy = startCellRow; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      const cIdx = cy * 8 + cx;
      if (origCellRanges[cIdx] > 25) {
        strongCells++;
        let minY = 255;
        let maxY = 0;
        for (let dy = 0; dy < 8; dy++) {
          const py = cy * 8 + dy;
          const rOff = py * 64 + cx * 8;
          for (let dx = 0; dx < 8; dx++) {
            const yVal = candY[rOff + dx];
            if (yVal < minY) minY = yVal;
            if (yVal > maxY) maxY = yVal;
          }
        }
        if ((maxY - minY) > 18) retainedCells++;
      }
    }
  }
  const detailRetention = (strongCells === 0) ? 1.0 : (retainedCells / strongCells);

  let bottomGrayCount = 0;
  for (let i = 3072; i < 4096; i++) {
    const r = candThumb64[i * 3];
    const g = candThumb64[i * 3 + 1];
    const b = candThumb64[i * 3 + 2];
    if (Math.abs(r - 128) <= 4 && Math.abs(g - 128) <= 4 && Math.abs(b - 128) <= 4) {
      bottomGrayCount++;
    }
  }
  const addedBottomGray = (bottomGrayCount / 1024) - origBottomGray;
  const truncated = addedBottomGray > 0.30;

  let topDiffSum = 0;
  for (let i = 0; i < 768; i++) {
    const r = candThumb64[i * 3];
    const g = candThumb64[i * 3 + 1];
    const b = candThumb64[i * 3 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    topDiffSum += Math.abs(y - origY[i]);
  }
  const topMad = topDiffSum / 768;
  const topShifted = topMad >= 3.0;
  const topRowUnshifted = isZoneZero && !topShifted;

  const clipExcess = Math.max(0, addedClipRatio - config.maxClipRatio);
  const detailDeficit = Math.max(0, config.minDetailRetention - detailRetention);
  const lumaDist = Math.abs(lumaMad - config.targetLumaMad);
  const chromaDeficit = Math.max(0, config.minChromaMad - chromaMad);

  let cost = config.wClip * clipExcess +
             config.wDetail * detailDeficit +
             config.wY * lumaDist +
             config.wC * chromaDeficit;

  if (truncated) cost += 1000;
  if (topRowUnshifted) cost += 1000;

  return {
    addedClipRatio,
    detailRetention,
    lumaMad,
    chromaMad,
    addedBottomGray,
    topMad,
    topShifted,
    truncated,
    topRowUnshifted,
    cost,
  };
}

/**
 * Mutates a candidate buffer within a single zone respecting the 0xFF invariants.
 */
export function mutateZoneCandidate(
  baseBuf,
  safeScanIndices,
  zone,
  corruption,
  trialRng,
  {
    driftMode = 'noise',
    driftMultiplier = 1.0,
    width = 1024,
    height = 1024,
  } = {}
) {
  const out = new Uint8Array(baseBuf);
  const zoneLen = zone.end - zone.start;
  if (zoneLen <= 0) return out;

  const numEdits = corruption >= 85 ? (trialRng.next() < 0.5 ? 2 : 1) : 1;

  for (let e = 0; e < numEdits; e++) {
    let chosenIdx = zone.start + trialRng.int(0, zoneLen - 1);
    let pos = safeScanIndices[chosenIdx];

    let tries = 0;
    while (
      tries < 16 &&
      (
        out[pos] === 0xff ||
        (pos > 0 && out[pos - 1] === 0xff) ||
        (pos < out.length - 1 && out[pos + 1] === 0xff)
      )
    ) {
      chosenIdx = zone.start + trialRng.int(0, zoneLen - 1);
      pos = safeScanIndices[chosenIdx];
      tries++;
    }

    const curByte = out[pos];
    let nextByte;

    if (corruption <= 25) {
      const bit = trialRng.int(0, 7);
      nextByte = curByte ^ (1 << bit);
      if (nextByte === 0xff) {
        nextByte = curByte ^ (1 << ((bit + 1) % 8));
        if (nextByte === 0xff) nextByte = 0xfe;
      }
    } else if (corruption <= 55) {
      const twoBits = trialRng.next() < (corruption - 25) / 30;
      const b1 = trialRng.int(0, 7);
      let mask = 1 << b1;
      if (twoBits) {
        const b2 = (b1 + trialRng.int(1, 7)) % 8;
        mask |= (1 << b2);
      }
      nextByte = curByte ^ mask;
      if (nextByte === 0xff) nextByte = curByte ^ 1;
      if (nextByte === 0xff) nextByte = 0xfe;
    } else if (corruption <= 80) {
      const mask = trialRng.int(1, 0x3f);
      nextByte = curByte ^ mask;
      if (nextByte === 0xff) nextByte = 0xfe;
      if (nextByte === curByte) {
        nextByte = (curByte + trialRng.int(5, 35)) % 255;
        if (nextByte === 0xff) nextByte = 0xfe;
      }
    } else {
      nextByte = trialRng.int(0, 254);
      if (nextByte === 0xff) nextByte = 0xfe;
      if (nextByte === curByte) {
        nextByte = (curByte + 27) % 255;
        if (nextByte === 0xff) nextByte = 0xfe;
      }
    }

    out[pos] = nextByte;
  }

  return out;
}

/**
 * Mutates DQT tables for high corruption levels.
 */
export function mutateDqtTables(buf, dqtTables, rng, strength = 6, driftFactor = 1.0) {
  const out = new Uint8Array(buf);
  if (!dqtTables || dqtTables.length === 0) return out;

  for (const table of dqtTables) {
    if (rng.next() < 0.75) {
      const dcPos = table.start;
      const factor = rng.range(0.45, 2.6) * Math.sqrt(driftFactor);
      out[dcPos] = Math.max(4, Math.min(85, Math.round(out[dcPos] * factor)));
    }

    const acEdits = Math.max(2, Math.min(48, Math.round(strength * 1.4 * driftFactor)));
    for (let e = 0; e < acEdits; e++) {
      const coeffIdx = rng.int(1, 48);
      const pos = table.start + coeffIdx;
      if (rng.next() < 0.45) {
        out[pos] = rng.int(1, Math.max(2, Math.min(10, Math.round(6 * driftFactor))));
      } else {
        out[pos] = rng.int(Math.max(25, Math.round(55 * driftFactor)), 245);
      }
    }
  }
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
  {
    mutations = 6,
    overscanRatio = 0.06,
    mutateDqt = false,
    dqtStrength = 6,
    driftMode = 'noise',
    driftMultiplier = 1.0,
    maxDrift = 65,
    origThumb = null,
    width = 1024,
    height = 1024,
  } = {}
) {
  const out = new Uint8Array(baseBuf);
  const { safeScanIndices, dqtTables } = structure;

  const driftFactor = Math.max(0.15, maxDrift / 65);

  if (mutateDqt && dqtTables.length > 0) {
    for (const table of dqtTables) {
      // Gentle nudge to DC coefficient (index 0) so colors/contrast shift uniformly
      if (rng.next() < 0.75) {
        const dcPos = table.start;
        const factor = rng.range(0.45, 2.6) * Math.sqrt(driftFactor);
        out[dcPos] = Math.max(4, Math.min(85, Math.round(out[dcPos] * factor)));
      }

      // Mutate AC frequency coefficients for mosaic / painterly block textures
      const acEdits = Math.max(2, Math.min(48, Math.round(dqtStrength * 1.4 * driftFactor)));
      for (let e = 0; e < acEdits; e++) {
        const coeffIdx = rng.int(1, 48);
        const pos = table.start + coeffIdx;
        if (rng.next() < 0.45) {
          // Low value -> sharp ringing & color bleed
          out[pos] = rng.int(1, Math.max(2, Math.min(10, Math.round(6 * driftFactor))));
        } else {
          // High value -> bold quantized mosaic blocks
          out[pos] = rng.int(Math.max(25, Math.round(55 * driftFactor)), 245);
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
  const mult = Math.max(0.1, Math.min(5.0, Number(driftMultiplier) || 1.0));
  const noise1D = createNoise1D(`${rng.seed}::jpeg1D`);
  const noise2D = createNoise2D(`${rng.seed}::jpeg2D`);
  const scanFreq = 0.02 * mult;
  const driftMagnitude = Math.max(6, Math.min(240, Math.round(maxDrift * 1.75)));

  for (let m = 0; m < count; m++) {
    let idx;
    if (m < earlyCount) {
      const upper = m === 0 ? Math.max(4, Math.floor(earlyWindow * 0.65)) : earlyWindow;
      idx = rng.int(0, upper);
    } else {
      const remainingCount = Math.max(1, count - earlyCount);
      const step = (len - earlyWindow) / remainingCount;
      const baseIdx = earlyWindow + Math.floor((m - earlyCount + 0.5) * step);
      const progress = baseIdx / len;
      const y = progress * height;
      const x = (baseIdx * 13) % width;

      if (driftMode === 'noise') {
        const n = noise1D(y * scanFreq);
        const shift = Math.round(n * (step * 0.45));
        idx = Math.max(earlyWindow, Math.min(len - 1, baseIdx + shift));
      } else if (driftMode === '2d') {
        const n = noise2D(x * 0.012 * mult, y * 0.012 * mult);
        const shift = Math.round(n * (step * 0.45));
        idx = Math.max(earlyWindow, Math.min(len - 1, baseIdx + shift));
      } else if (driftMode === 'color') {
        let lum = 0.5;
        let chroma = 0;
        if (origThumb && origThumb.length === 32 * 32 * 3) {
          const tx = Math.max(0, Math.min(31, Math.floor((x / width) * 32)));
          const ty = Math.max(0, Math.min(31, Math.floor((y / height) * 32)));
          const toff = (ty * 32 + tx) * 3;
          const r = origThumb[toff];
          const g = origThumb[toff + 1];
          const b = origThumb[toff + 2];
          lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          chroma = (b - r) / 255;
        }
        const colVal = noise1D((lum * 6.5 + chroma * 4.5) * mult);
        const shift = Math.round((colVal * 0.7 + (lum - 0.5) * 0.6) * (step * 0.45));
        idx = Math.max(earlyWindow, Math.min(len - 1, baseIdx + shift));
      } else {
        idx = rng.int(earlyWindow, len - 1);
      }
    }

    const pos = safeScanIndices[idx];
    const oldVal = out[pos];

    // Compute delta driven by driftMode, driftMultiplier, and maxDrift
    const progress = idx / len;
    const y = progress * height;
    const x = (idx * 13) % width;
    let delta = 0;

    if (driftMode === 'noise') {
      const n = noise1D((y + m * 23.7) * scanFreq);
      delta = Math.round(n * driftMagnitude);
    } else if (driftMode === '2d') {
      const n = noise2D((x + m * 17.3) * 0.015 * mult, (y + m * 31.1) * 0.015 * mult);
      delta = Math.round(n * driftMagnitude);
    } else if (driftMode === 'color') {
      let lum = 0.5;
      let chroma = 0;
      if (origThumb && origThumb.length === 32 * 32 * 3) {
        const tx = Math.max(0, Math.min(31, Math.floor((x / width) * 32)));
        const ty = Math.max(0, Math.min(31, Math.floor((y / height) * 32)));
        const toff = (ty * 32 + tx) * 3;
        const r = origThumb[toff];
        const g = origThumb[toff + 1];
        const b = origThumb[toff + 2];
        lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        chroma = (b - r) / 255;
      }
      const colVal = noise1D((lum * 7.5 + chroma * 4.5 + m * 0.3) * mult);
      delta = Math.round((colVal * 0.75 + (lum - 0.5) * 0.7) * driftMagnitude);
    } else {
      delta = Math.round(rng.range(-1, 1) * driftMagnitude);
    }

    if (delta === 0) {
      delta = (rng.next() < 0.5 ? 1 : -1) * Math.max(2, Math.round(maxDrift * 0.5));
    }

    let newVal = clampByte(oldVal + delta);
    if (newVal === 0xff) newVal = 0xfe;
    if (newVal === oldVal) {
      newVal = (oldVal + Math.max(2, Math.round(maxDrift * 0.4))) % 255;
      if (newVal === 0xff) newVal = 0xfe;
    }
    out[pos] = newVal;
  }

  return out;
}

/**
 * Calculates max intensity slider upper bound directly corresponding to image resolution.
 */
export function getMaxIntensity(maxDim = 1024) {
  const d = Math.max(256, Number(maxDim) || 1024);
  return Math.max(60, Math.min(360, Math.round(d / 5)));
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

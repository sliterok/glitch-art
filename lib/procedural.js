import { clampByte, hslToRgb, rgbToYcbcr, ycbcrToRgb, createNoise1D, createNoise2D } from './prng.js';

/**
 * Generates a cohesive 4-color palette sorted dark -> light from a seed.
 */
export function generateSeededPalette(rng) {
  const baseHue = rng.range(0, 360);
  const scheme = rng.pick([
    'analogous',
    'split-comp',
    'cyber-dusk',
    'sunset',
    'deep-mono',
    'triadic-soft',
  ]);

  let hues;
  if (scheme === 'analogous') {
    hues = [baseHue - 30, baseHue - 10, baseHue + 18, baseHue + 42];
  } else if (scheme === 'split-comp') {
    hues = [baseHue, baseHue + 20, baseHue + 155, baseHue + 200];
  } else if (scheme === 'cyber-dusk') {
    hues = [baseHue, baseHue + 35, baseHue + 125, baseHue + 165];
  } else if (scheme === 'sunset') {
    const start = rng.range(220, 310);
    hues = [start, start + 45, start + 95, start + 135];
  } else if (scheme === 'deep-mono') {
    hues = [baseHue - 8, baseHue, baseHue + 8, baseHue + 16];
  } else {
    hues = [baseHue, baseHue + 115, baseHue + 230, baseHue + 25];
  }

  const satBase = rng.range(0.38, 0.78);
  const lights = [
    rng.range(0.11, 0.22),
    rng.range(0.28, 0.42),
    rng.range(0.48, 0.64),
    rng.range(0.70, 0.84),
  ];

  return hues.map((h, i) =>
    hslToRgb(h, Math.min(0.88, satBase + (i % 2 === 0 ? 0.05 : -0.06)), lights[i])
  );
}

/**
 * Extracts a 4-color palette sorted dark -> light from a 32x32 raw RGB thumbnail.
 */
export function extractPaletteFromThumb(thumbRgb) {
  const pixels = [];
  for (let i = 0; i < thumbRgb.length; i += 3) {
    pixels.push([thumbRgb[i], thumbRgb[i + 1], thumbRgb[i + 2]]);
  }
  if (pixels.length === 0) return [[20, 24, 40], [60, 80, 120], [160, 110, 130], [220, 200, 190]];

  // Deterministic k-means (4 centroids, 6 iterations)
  let centroids = [
    pixels[0],
    pixels[Math.floor(pixels.length * 0.33)],
    pixels[Math.floor(pixels.length * 0.66)],
    pixels[pixels.length - 1],
  ].map((c) => [...c]);

  for (let iter = 0; iter < 6; iter++) {
    const sums = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    for (const p of pixels) {
      let best = 0;
      let bestDist = Infinity;
      for (let k = 0; k < 4; k++) {
        const dr = p[0] - centroids[k][0];
        const dg = p[1] - centroids[k][1];
        const db = p[2] - centroids[k][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) {
          bestDist = d;
          best = k;
        }
      }
      sums[best][0] += p[0];
      sums[best][1] += p[1];
      sums[best][2] += p[2];
      sums[best][3] += 1;
    }
    for (let k = 0; k < 4; k++) {
      if (sums[k][3] > 0) {
        centroids[k] = [
          Math.round(sums[k][0] / sums[k][3]),
          Math.round(sums[k][1] / sums[k][3]),
          Math.round(sums[k][2] / sums[k][3]),
        ];
      }
    }
  }

  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return centroids.sort((a, b) => lum(a) - lum(b));
}

function samplePalette(palette, t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const scaled = clamped * (palette.length - 1);
  const idx = Math.min(palette.length - 2, Math.floor(scaled));
  const f = scaled - idx;
  const a = palette[idx];
  const b = palette[idx + 1];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

/**
 * Precomputes a 256-step RGB lookup table from a 4-color palette
 * to eliminate millions of array allocations and function calls in pixel loops.
 */
function createPaletteLut(palette) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = samplePalette(palette, i / 255);
    const p = i * 3;
    lut[p] = clampByte(r);
    lut[p + 1] = clampByte(g);
    lut[p + 2] = clampByte(b);
  }
  return lut;
}

/**
 * Generates a fast seeded RGB procedural base (used by Options 1, 2, 3, 4).
 */
export function renderProceduralBase(width, height, rng, { pattern = 'auto', palette = null, grain = 10 } = {}) {
  const pal = palette || generateSeededPalette(rng);
  const palLut = createPaletteLut(pal);
  const mode =
    pattern === 'auto'
      ? rng.pick(['gradient', 'plasma', 'stripes', 'waves'])
      : pattern;

  const buf = new Uint8Array(width * height * 3);

  // Precompute trig lookup tables for fast full-res synthesis
  const angle = rng.range(0, Math.PI * 2);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const freq1 = rng.range(1.8, 5.5);
  const freq2 = rng.range(2.2, 6.5);
  const phase1 = rng.range(0, Math.PI * 2);
  const phase2 = rng.range(0, Math.PI * 2);
  const cx = rng.range(0.2, 0.8);
  const cy = rng.range(0.2, 0.8);

  const sinX = new Float32Array(width);
  const cosX = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const nx = x / width;
    sinX[x] = Math.sin(nx * Math.PI * 2 * freq1 + phase1);
    cosX[x] = Math.cos(nx * Math.PI * 2 * freq2 + phase2);
  }

  const sinY = new Float32Array(height);
  const cosY = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const ny = y / height;
    sinY[y] = Math.sin(ny * Math.PI * 2 * freq1 + phase2);
    cosY[y] = Math.cos(ny * Math.PI * 2 * freq2 + phase1);
  }

  // Fast inline LCG for deterministic per-pixel film grain
  let noiseState = rng.int(1, 0x7fffffff);

  let ptr = 0;
  for (let y = 0; y < height; y++) {
    const ny = y / height;
    const sy = sinY[y];
    const cyv = cosY[y];

    for (let x = 0; x < width; x++) {
      const nx = x / width;
      let t;

      if (mode === 'gradient') {
        const dx = nx - cx;
        const dy = ny - cy;
        const lin = (nx - 0.5) * cosA + (ny - 0.5) * sinA + 0.5;
        const rad = Math.sqrt(dx * dx + dy * dy);
        t = lin * 0.65 + (1 - Math.min(1, rad * 1.15)) * 0.35;
      } else if (mode === 'plasma') {
        const v = (sinX[x] + sy + cosX[x] * cyv) / 3;
        t = v * 0.5 + 0.5;
      } else if (mode === 'stripes') {
        const proj = nx * cosA + ny * sinA;
        const wave = Math.sin((proj * freq1 * 2.2 + sinX[x] * 0.15) * Math.PI * 2 + phase1);
        t = wave * 0.45 + 0.5 + (ny - 0.5) * 0.25;
      } else {
        // 'waves': layered horizon-like bands
        const ridge = Math.sin(nx * Math.PI * 2 * freq1 + phase1) * 0.08 +
                      Math.cos(nx * Math.PI * 2 * (freq2 * 0.6) + phase2) * 0.05;
        t = ny + ridge;
      }

      const lutIdx = (t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0) * 3;
      const r = palLut[lutIdx];
      const g = palLut[lutIdx + 1];
      const b = palLut[lutIdx + 2];

      noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
      const n = ((noiseState >>> 24) / 255 - 0.5) * 2 * grain;

      buf[ptr++] = clampByte(r + n);
      buf[ptr++] = clampByte(g + n);
      buf[ptr++] = clampByte(b + n);
    }
  }

  return { rgb: buf, palette: pal, pattern: mode };
}

/**
 * Option 2 Post-Harmonizer: keeps all real JPEG discontinuities, block shifts,
 * and sharp horizontal bands while gently remapping extreme swings back into the palette.
 */
export function harmonizeWithPalette(rgbBuf, palette, lockStrength = 0.48) {
  const out = new Uint8Array(rgbBuf.length);
  const palLut = createPaletteLut(palette);
  const keep = 1 - lockStrength;

  for (let i = 0; i < rgbBuf.length; i += 3) {
    const r = rgbBuf[i];
    const g = rgbBuf[i + 1];
    const b = rgbBuf[i + 2];

    // Use glitched luminance + slight chroma bias to preserve band contrast
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const chromaBias = ((r - b) / 255) * 0.12;
    const t = lum + chromaBias;
    const lutIdx = (t <= 0 ? 0 : t >= 1 ? 255 : (t * 255) | 0) * 3;

    const pr = palLut[lutIdx];
    const pg = palLut[lutIdx + 1];
    const pb = palLut[lutIdx + 2];

    // Soft-compress extreme clipped values so foreground subjects stay legible
    const rr = r * keep + pr * lockStrength;
    const gg = g * keep + pg * lockStrength;
    const bb = b * keep + pb * lockStrength;

    out[i] = clampByte(rr * 0.92 + 10);
    out[i + 1] = clampByte(gg * 0.92 + 10);
    out[i + 2] = clampByte(bb * 0.92 + 10);
  }
  return out;
}

/**
 * Option 3: Pure Algorithmic JPEG-Glitch Synthesizer (No JPEG corruption).
 * Deterministic YCbCr MCU-row banding, mid-scanline jogs, phase wraps, and 8x8 quantization.
 */
export function synthesizeAlgoGlitch(
  width,
  height,
  rng,
  {
    pattern = 'auto',
    intensity = 6,
    maxDrift = 70,
    quality = 85,
    driftMode = 'noise',
    driftMultiplier = 1.0,
  } = {}
) {
  const palette = generateSeededPalette(rng.fork('pal'));
  const { rgb: baseRgb } = renderProceduralBase(width, height, rng.fork('base'), {
    pattern,
    palette,
    grain: 6,
  });

  const bandRng = rng.fork('bands');
  const mcuH = 16;
  const mcuW = 8;
  const totalMcuRows = Math.ceil(height / mcuH);
  const driftScale = maxDrift / 70;
  const isNoise1D = driftMode === 'noise';
  const isNoise2D = driftMode === '2d';
  const isColorNoise = driftMode === 'color';
  const isAnyNoise = isNoise1D || isNoise2D || isColorNoise;

  // Build horizontal glitch events
  const eventCount = isAnyNoise
    ? Math.max(6, Math.min(totalMcuRows, Math.round(intensity * 1.8)))
    : Math.max(3, Math.min(32, Math.round(intensity * 1.45)));

  const eventRows = [0];
  for (let e = 1; e < eventCount; e++) {
    eventRows.push(bandRng.int(1, Math.max(1, totalMcuRows - 1)));
  }
  eventRows.sort((a, b) => a - b);

  // Deduplicate rows while keeping row 0
  const uniqueRows = [...new Set(eventRows)];
  const events = [];

  const noise1D = isAnyNoise ? createNoise1D(`${rng.seed}::driftNoise1D`) : null;
  const noise2D = isNoise2D ? createNoise2D(`${rng.seed}::driftNoise2D`) : null;
  const mult = Math.max(0.05, Math.min(10.0, Number(driftMultiplier) || 1.0));
  const noiseFreq = 0.045 * mult;
  const coordFreq = 0.015 * mult;

  let curDy = 0;
  let curDcb = 0;
  let curDcr = 0;
  let curShift = 0;

  if (!isAnyNoise) {
    curDy = bandRng.range(-28, 28) * driftScale;
    curDcb = bandRng.range(-55, 55) * driftScale;
    curDcr = bandRng.range(-55, 55) * driftScale;
    curShift = bandRng.int(-4, 4) * mcuW;
  }

  for (let i = 0; i < uniqueRows.length; i++) {
    const row = uniqueRows[i];
    let invertChroma = false;

    if (isAnyNoise) {
      // Continuous smooth noise function input coordinates
      const t = row * noiseFreq;
      const nShift = noise1D(t);
      const nDy = noise1D(t + 43.17);
      const nDcb = noise1D(t + 119.82);
      const nDcr = noise1D(t + 281.41);

      curShift = Math.round((nShift * (maxDrift * 1.6)) / mcuW) * mcuW;
      curDy = Math.max(-85, Math.min(85, nDy * maxDrift * 0.85));
      curDcb = Math.max(-125, Math.min(125, nDcb * maxDrift * 1.35));
      curDcr = Math.max(-125, Math.min(125, nDcr * maxDrift * 1.35));
      invertChroma = noise1D(t + 490.5) > 0.58;
    } else {
      if (i > 0) {
        curDy = Math.max(-75, Math.min(75, curDy + bandRng.range(-38, 38) * driftScale));
        curDcb = Math.max(-115, Math.min(115, curDcb + bandRng.range(-75, 75) * driftScale));
        curDcr = Math.max(-115, Math.min(115, curDcr + bandRng.range(-75, 75) * driftScale));
        if (bandRng.next() < 0.7) {
          curShift = (curShift + bandRng.int(-14, 14) * mcuW) % width;
        }
      }
      invertChroma = bandRng.next() < 0.14 * Math.min(1.5, driftScale);
    }

    events.push({
      mcuRow: row,
      startX: i === 0 ? 0 : isAnyNoise ? (Math.abs(curShift) % 2 === 0 ? 0 : bandRng.int(0, Math.floor(width / mcuW) - 1) * mcuW) : bandRng.int(0, Math.floor(width / mcuW) - 1) * mcuW,
      dY: curDy,
      dCb: curDcb,
      dCr: curDcr,
      xShift: curShift,
      invertChroma,
    });
  }

  // Quality controls simulated 8x8 block quantization step
  const quantStep = Math.max(1, Math.round((100 - quality) * 0.42));
  const out = new Uint8Array(width * height * 3);

  let evIdx = 0;
  let prevState = events[0];
  let currState = events[0];

  for (let y = 0; y < height; y++) {
    const mcuRow = Math.floor(y / mcuH);
    while (evIdx + 1 < events.length && events[evIdx + 1].mcuRow <= mcuRow) {
      prevState = events[evIdx];
      evIdx++;
      currState = events[evIdx];
    }

    const isTransitionRow = currState.mcuRow === mcuRow && currState.startX > 0;
    const blockY = (y >> 3) << 3; // 8x8 vertical block anchor
    const rowOutOff = y * width * 3;

    for (let x = 0; x < width; x++) {
      const st = isTransitionRow && x < currState.startX ? prevState : currState;

      let localShift = 0;
      let localDy = 0;
      let localDcb = 0;
      let localDcr = 0;

      if (isNoise2D) {
        // Continuous 2D coordinate noise at current pixel
        const nx = x * coordFreq;
        const ny = y * coordFreq;
        const n2d = noise2D(nx, ny);
        localShift = Math.round(n2d * maxDrift * 0.7);
        localDy = noise2D(nx + 33.1, ny + 17.5) * (maxDrift * 0.45);
        localDcb = noise2D(nx + 71.3, ny + 59.8) * (maxDrift * 0.85);
        localDcr = noise2D(nx + 117.9, ny + 91.2) * (maxDrift * 0.85);
      } else if (isColorNoise) {
        // Noise & drift driven by color & luminance at current pixel
        const unshiftedOff = (y * width + x) * 3;
        const ur = baseRgb[unshiftedOff];
        const ug = baseRgb[unshiftedOff + 1];
        const ub = baseRgb[unshiftedOff + 2];
        const lum = (0.299 * ur + 0.587 * ug + 0.114 * ub) / 255;
        const chroma = (ub - ur) / 255;
        const colVal = noise1D((lum * 7.5 + chroma * 4.5) * mult);
        localShift = Math.round(colVal * maxDrift * (0.25 + 0.75 * lum));
        localDy = (lum - 0.5) * maxDrift * 0.75;
        localDcb = chroma * maxDrift * 1.5;
        localDcr = ((ug / 255) - 0.5) * maxDrift * 1.5;
      }

      // Wrap X horizontally to simulate MCU bit-stream shift
      let sx = (x + st.xShift + localShift) % width;
      if (sx < 0) sx += width;

      // Slight 8x8 quantization sampling on lower quality settings
      const qx = quantStep > 4 ? (sx & ~3) : sx;
      const qy = quantStep > 8 ? blockY : y;
      const srcOff = (qy * width + qx) * 3;

      const sr = baseRgb[srcOff];
      const sg = baseRgb[srcOff + 1];
      const sb = baseRgb[srcOff + 2];

      let Y = 0.299 * sr + 0.587 * sg + 0.114 * sb;
      let Cb = 128 - 0.168736 * sr - 0.331264 * sg + 0.5 * sb;
      let Cr = 128 + 0.5 * sr - 0.418688 * sg - 0.081312 * sb;

      if (st.invertChroma) {
        Cb = 255 - Cb;
        Cr = 255 - Cr;
      }

      Y += st.dY + localDy;
      Cb += st.dCb + localDcb;
      Cr += st.dCr + localDcr;

      // Simulate subtle 8x8 DCT block edge quantization
      if (quantStep > 1) {
        const blockHash = (((x >> 3) * 37 + (y >> 3) * 17) & 7) - 3.5;
        Y = Math.round((Y + blockHash * (quantStep * 0.15)) / quantStep) * quantStep;
      }

      const clY = Y < 0 ? 0 : Y > 255 ? 255 : Y;
      const cb128 = (Cb < 0 ? 0 : Cb > 255 ? 255 : Cb) - 128;
      const cr128 = (Cr < 0 ? 0 : Cr > 255 ? 255 : Cr) - 128;

      const r = clampByte(clY + 1.402 * cr128);
      const g = clampByte(clY - 0.344136 * cb128 - 0.714136 * cr128);
      const b = clampByte(clY + 1.772 * cb128);

      const dstOff = rowOutOff + x * 3;
      out[dstOff] = r;
      out[dstOff + 1] = g;
      out[dstOff + 2] = b;
    }
  }

  return out;
}
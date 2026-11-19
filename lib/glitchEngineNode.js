import sharp from 'sharp';
import { createRng } from './prng.js';
import { addTopOverscan, mutateJpeg, parseJpegStructure, calculateMutations, getMaxIntensity } from './jpegUtils.js';
import {
  generateSeededPalette,
  harmonizeWithPalette,
  renderProceduralBase,
  synthesizeAlgoGlitch,
  extractPaletteFromThumb,
} from './procedural.js';

const PAD_TOP = 64; // 4 full 16px MCU rows

function bottomGrayRatio(thumb) {
  const start = 24 * 32 * 3;
  const totalPixels = 8 * 32;
  let grayPixels = 0;
  for (let i = start; i < thumb.length; i += 3) {
    if (
      Math.abs(thumb[i] - 128) <= 4 &&
      Math.abs(thumb[i + 1] - 128) <= 4 &&
      Math.abs(thumb[i + 2] - 128) <= 4
    ) {
      grayPixels++;
    }
  }
  return grayPixels / totalPixels;
}

function thumbMetrics(thumb, refThumb) {
  let diffSum = 0;
  let topDiffSum = 0;
  const topEnd = 6 * 32 * 3; // Top ~19% of visible image

  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < thumb.length; i++) {
    const v = thumb[i];
    sum += v;
    sumSq += v * v;
    if (refThumb) {
      const d = Math.abs(v - refThumb[i]);
      diffSum += d;
      if (i < topEnd) topDiffSum += d;
    }
  }

  const n = thumb.length;
  const mean = sum / n;
  const stdDev = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const mad = refThumb ? diffSum / n : stdDev;
  const topMad = refThumb ? topDiffSum / topEnd : stdDev;

  return { mad, topMad, stdDev };
}

export async function encodeBaselinePadded(rgbBuf, width, height, quality) {
  const paddedRgb = addTopOverscan(rgbBuf, width, height, PAD_TOP);
  const jpeg = await sharp(Buffer.from(paddedRgb.buffer, paddedRgb.byteOffset, paddedRgb.byteLength), {
    raw: { width, height: height + PAD_TOP, channels: 3 },
  })
    .jpeg({
      quality,
      progressive: false,
      chromaSubsampling: '4:2:0',
      mozjpeg: false,
    })
    .toBuffer();

  const structure = parseJpegStructure(new Uint8Array(jpeg));
  return { jpeg: new Uint8Array(jpeg), structure, overscanRatio: PAD_TOP / (height + PAD_TOP) };
}

async function runValidatedJpegGlitch({
  baseJpeg,
  structure,
  overscanRatio,
  width,
  height,
  origThumb,
  origBottomGray,
  seed,
  mutations,
  maxDrift = 65,
  mutateDqt = false,
  dqtStrength = 6,
  driftMode = 'noise',
  driftMultiplier = 1.0,
  maxAttempts = 16,
}) {
  let best = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const rng = createRng(`${seed}::${driftMode}::${Math.round(driftMultiplier * 10)}::${Math.round(maxDrift)}::try:${attempt}`);
    const candidate = mutateJpeg(baseJpeg, structure, rng, {
      mutations,
      overscanRatio,
      mutateDqt,
      dqtStrength,
      driftMode,
      driftMultiplier,
      maxDrift,
      origThumb,
      width,
      height,
    });

    let croppedThumb;
    try {
      croppedThumb = await sharp(Buffer.from(candidate.buffer, candidate.byteOffset, candidate.byteLength), { failOn: 'none' })
        .extract({ left: 0, top: PAD_TOP, width, height })
        .resize(32, 32, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer();
    } catch {
      continue;
    }

    if (croppedThumb.length !== 32 * 32 * 3) continue;

    const addedGray = bottomGrayRatio(croppedThumb) - origBottomGray;
    const truncated = addedGray > 0.32;
    const { mad, topMad, stdDev } = thumbMetrics(croppedThumb, origThumb);

    const blownOut = stdDev < 9; // Reject flat white/black/gray washouts
    const topShifted = topMad >= 3.0;

    // Score prioritizes non-truncated, non-blown-out frames where row 0 shifted and mad is near targetMad
    const targetMad = maxDrift * 0.55;
    const score =
      Math.abs(mad - targetMad) +
      (truncated ? 150 : 0) +
      (blownOut ? 150 : 0) +
      (topShifted ? 0 : 85);

    const minRequiredMad = Math.min(3.0, Math.max(0.4, maxDrift * 0.28));
    const requiresTopShift = maxDrift >= 8;
    const isGood =
      !truncated &&
      !blownOut &&
      (requiresTopShift ? topShifted : true) &&
      mad >= minRequiredMad &&
      mad <= maxDrift * 1.15;

    if (isGood) {
      if (!best || score < best.score || best.fallback) {
        best = { candidate, mad, topMad, attempt, score, fallback: false };
      }
      // Stop early if candidate is within 30% of target drift
      if (Math.abs(mad - targetMad) <= Math.max(3.0, targetMad * 0.3)) {
        break;
      }
    } else if (!best || score < best.score) {
      best = { candidate, mad, topMad, attempt, score, fallback: true };
    }
  }

  if (!best) {
    throw new Error('Could not decode a valid glitched frame');
  }

  // Decode and crop off the sacrificial overscan strip
  const croppedRgb = await sharp(Buffer.from(best.candidate.buffer, best.candidate.byteOffset, best.candidate.byteLength), { failOn: 'none' })
    .extract({ left: 0, top: PAD_TOP, width, height })
    .removeAlpha()
    .raw()
    .toBuffer();

  return {
    rgb: new Uint8Array(croppedRgb),
    mad: best.mad,
    attempt: best.attempt,
    fallback: best.fallback,
  };
}

/**
 * Image Mode: glitches an uploaded image uniformly from row 0.
 */
export async function glitchUploadedImage(imageState, opts) {
  const {
    seed,
    intensity = 8,
    maxDrift,
    includeDqt,
    driftMode = 'noise',
    driftMultiplier = 1.0,
  } = opts;
  const maxDim = Math.max(imageState.width, imageState.height);
  const mutations = opts.mutations || calculateMutations(intensity, maxDim);
  const dqtStrength = Math.max(2, Math.min(30, Math.round(mutations * 0.6)));

  const result = await runValidatedJpegGlitch({
    baseJpeg: imageState.paddedJpeg,
    structure: imageState.structure,
    overscanRatio: imageState.overscanRatio,
    width: imageState.width,
    height: imageState.height,
    origThumb: imageState.origThumb,
    origBottomGray: imageState.origBottomGray,
    seed,
    mutations,
    maxDrift,
    mutateDqt: Boolean(includeDqt),
    dqtStrength,
    driftMode,
    driftMultiplier,
  });

  const outJpeg = await sharp(Buffer.from(result.rgb.buffer, result.rgb.byteOffset, result.rgb.byteLength), {
    raw: { width: imageState.width, height: imageState.height, channels: 3 },
  })
    .jpeg({ quality: 92 })
    .toBuffer();

  return {
    buffer: outJpeg,
    diff: result.mad,
    attempts: result.attempt,
    fallback: result.fallback,
    engine: includeDqt ? 'image+dqt' : 'image',
  };
}

/**
 * Background Mode: executes any of the 4 seeded background engines.
 */
export async function generateGlitchBackground(opts) {
  const {
    engine = 'procedural-jpeg',
    seed,
    pattern = 'auto',
    width = 1024,
    height = 1024,
    intensity = 8,
    maxDrift = 75,
    quality = 85,
    imagePalette = null,
    matchImagePalette = false,
    driftMode = 'noise',
    driftMultiplier = 1.0,
  } = opts;

  const w = Math.max(256, Math.min(2560, Number(width) || 1024));
  const h = Math.max(256, Math.min(2560, Number(height) || 1024));
  const maxDim = Math.max(w, h);
  const mutations = opts.mutations || calculateMutations(intensity, maxDim);
  const rng = createRng(seed);

  // Option 3: Pure Algorithmic Glitch Synthesizer
  if (engine === 'algo-synth') {
    const rgb = synthesizeAlgoGlitch(w, h, rng, {
      pattern,
      intensity: mutations,
      maxDrift,
      quality,
      driftMode,
      driftMultiplier,
    });
    const buffer = await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 92 })
      .toBuffer();

    return {
      buffer,
      diff: maxDrift * 0.55,
      attempts: 1,
      fallback: false,
      engine,
    };
  }

  // Options 1, 2, 4 share a seeded procedural base -> padded baseline JPEG pipeline
  const usePalette =
    engine === 'palette-jpeg' && matchImagePalette && imagePalette
      ? imagePalette
      : generateSeededPalette(rng.fork('palette'));

  const { rgb: baseRgb, palette } = renderProceduralBase(w, h, rng.fork('base'), {
    pattern,
    palette: usePalette,
    grain: engine === 'palette-jpeg' ? 8 : 11,
  });

  const origThumb = await sharp(Buffer.from(baseRgb.buffer, baseRgb.byteOffset, baseRgb.byteLength), { raw: { width: w, height: h, channels: 3 } })
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer();
  const origBottomGray = bottomGrayRatio(new Uint8Array(origThumb));

  const { jpeg: baseJpeg, structure, overscanRatio } = await encodeBaselinePadded(
    baseRgb,
    w,
    h,
    quality
  );

  const isDqtHybrid = engine === 'dqt-hybrid';
  const dqtStrength = Math.max(2, Math.min(30, Math.round(mutations * 0.6)));
  const result = await runValidatedJpegGlitch({
    baseJpeg,
    structure,
    overscanRatio,
    width: w,
    height: h,
    origThumb: new Uint8Array(origThumb),
    origBottomGray,
    seed: `${seed}::${engine}`,
    mutations: isDqtHybrid ? Math.max(2, Math.round(mutations * 0.85)) : mutations,
    maxDrift: isDqtHybrid ? Math.min(150, maxDrift + 25) : maxDrift,
    mutateDqt: isDqtHybrid,
    dqtStrength,
    driftMode,
    driftMultiplier,
  });

  let finalRgb = result.rgb;

  // Option 2: Palette-guided harmonization for background usability
  if (engine === 'palette-jpeg') {
    const lockStrength = Math.max(0.28, Math.min(0.68, 0.72 - (maxDrift / 160) * 0.4));
    finalRgb = harmonizeWithPalette(finalRgb, palette, lockStrength);
  }

  const outJpeg = await sharp(Buffer.from(finalRgb.buffer, finalRgb.byteOffset, finalRgb.byteLength), { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();

  return {
    buffer: outJpeg,
    diff: result.mad,
    attempts: result.attempt,
    fallback: result.fallback,
    engine,
  };
}

export async function prepareUploadedImage(rawBuffer, quality) {
  const q = Math.max(30, Math.min(96, Number(quality) || 85));

  const { data: normRgb, info } = await sharp(rawBuffer)
    .rotate()
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const origJpeg = await sharp(normRgb, {
    raw: { width: info.width, height: info.height, channels: 3 },
  })
    .jpeg({ quality: 92 })
    .toBuffer();

  const origThumb = await sharp(normRgb, {
    raw: { width: info.width, height: info.height, channels: 3 },
  })
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer();

  const thumbUint8 = new Uint8Array(origThumb);
  const palette = extractPaletteFromThumb(thumbUint8);

  const { jpeg: paddedJpeg, structure, overscanRatio } = await encodeBaselinePadded(
    new Uint8Array(normRgb),
    info.width,
    info.height,
    q
  );

  return {
    rawSource: rawBuffer,
    quality: q,
    width: info.width,
    height: info.height,
    origJpeg,
    origThumb: thumbUint8,
    origBottomGray: bottomGrayRatio(thumbUint8),
    palette,
    paddedJpeg,
    structure,
    overscanRatio,
  };
}


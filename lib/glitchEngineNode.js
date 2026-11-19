import sharp from 'sharp';
import { createRng } from './prng.js';
import {
  addTopOverscan,
  mutateJpeg,
  parseJpegStructure,
  calculateMutations,
  getMaxIntensity,
  getCorruptionConfig,
  divideScanZones,
  precomputeOrigMetrics,
  computeReadabilityMetrics,
  mutateZoneCandidate,
  mutateDqtTables,
} from './jpegUtils.js';
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
  origThumb64,
  origMetrics,
  origThumb,
  origBottomGray,
  seed,
  corruption = 30,
  autoBalance = true,
  mutations,
  maxDrift = 65,
  mutateDqt = false,
  dqtStrength = 6,
  driftMode = 'noise',
  driftMultiplier = 1.0,
}) {
  const cVal = corruption !== undefined
    ? Number(corruption)
    : (maxDrift !== undefined ? Math.round((maxDrift / 140) * 80) : 30);
  const effectiveCorr = Math.max(0, Math.min(100, isNaN(cVal) ? 30 : cVal));

  const rng = createRng(`${seed}::${driftMode}::${Math.round(driftMultiplier * 10)}::corr:${effectiveCorr}`);

  // Ensure 64x64 reference metrics
  let localMetrics = origMetrics;
  if (!localMetrics) {
    let localThumb = origThumb64;
    if (!localThumb || localThumb.length !== 64 * 64 * 3) {
      const origThumbBuf = await sharp(Buffer.from(baseJpeg.buffer, baseJpeg.byteOffset, baseJpeg.byteLength), { failOn: 'none' })
        .extract({ left: 0, top: PAD_TOP, width, height })
        .resize(64, 64, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer();
      localThumb = new Uint8Array(origThumbBuf);
    }
    localMetrics = precomputeOrigMetrics(localThumb);
  }

  const config = getCorruptionConfig(effectiveCorr, autoBalance);
  if (mutateDqt) config.mutateDqt = true;

  const K = 5;
  const zones = divideScanZones(structure.safeScanIndices, overscanRatio, K);

  let currentBuffer = new Uint8Array(baseJpeg);

  // If high corruption or DQT requested, mutate quantization tables on initial buffer
  if (config.mutateDqt && structure.dqtTables.length > 0) {
    currentBuffer = mutateDqtTables(currentBuffer, structure.dqtTables, rng.fork('dqt'), dqtStrength);
  }

  let totalDecodes = 0;
  let lastCommittedMetrics = null;

  for (let z = 0; z < K; z++) {
    const zone = zones[z];
    const startRow = (z === 0) ? 0 : Math.floor(((z - 1) / (K - 1)) * 64);

    let bestBuf = null;
    let bestCost = Infinity;
    let bestMetrics = null;

    const M = config.M;
    for (let m = 0; m < M; m++) {
      const trialRng = rng.fork(`zone-${z}-try-${m}`);
      const candidateBuf = mutateZoneCandidate(
        currentBuffer,
        structure.safeScanIndices,
        zone,
        effectiveCorr,
        trialRng,
        { driftMode, driftMultiplier, width, height }
      );

      let candThumb64;
      try {
        totalDecodes++;
        const buf = await sharp(Buffer.from(candidateBuf.buffer, candidateBuf.byteOffset, candidateBuf.byteLength), { failOn: 'none' })
          .extract({ left: 0, top: PAD_TOP, width, height })
          .resize(64, 64, { fit: 'fill' })
          .removeAlpha()
          .raw()
          .toBuffer();
        candThumb64 = new Uint8Array(buf);
      } catch {
        continue;
      }

      const metrics = computeReadabilityMetrics(
        candThumb64,
        localMetrics,
        startRow,
        config,
        z === 0
      );

      if (metrics.cost < bestCost) {
        bestCost = metrics.cost;
        bestBuf = candidateBuf;
        bestMetrics = metrics;
      }

      if (metrics.cost < config.earlyThreshold) {
        break;
      }
    }

    if (bestBuf && bestCost < 1000) {
      currentBuffer = bestBuf;
      lastCommittedMetrics = bestMetrics;
    } else if (bestBuf && z === 0 && bestCost < 1500) {
      currentBuffer = bestBuf;
      lastCommittedMetrics = bestMetrics;
    }
  }

  // Final decode: extract visible area without overscan
  const croppedRgb = await sharp(Buffer.from(currentBuffer.buffer, currentBuffer.byteOffset, currentBuffer.byteLength), { failOn: 'none' })
    .extract({ left: 0, top: PAD_TOP, width, height })
    .removeAlpha()
    .raw()
    .toBuffer();

  const finalDiff = lastCommittedMetrics
    ? (lastCommittedMetrics.lumaMad + lastCommittedMetrics.chromaMad * 0.5)
    : 0;

  return {
    rgb: new Uint8Array(croppedRgb),
    mad: finalDiff,
    lumaMad: lastCommittedMetrics?.lumaMad || 0,
    chromaMad: lastCommittedMetrics?.chromaMad || 0,
    clipRatio: lastCommittedMetrics?.addedClipRatio || 0,
    detailRetention: lastCommittedMetrics?.detailRetention || 1.0,
    attempt: totalDecodes,
    fallback: !lastCommittedMetrics,
  };
}

/**
 * Image Mode: glitches an uploaded image uniformly from row 0.
 */
export async function glitchUploadedImage(imageState, opts) {
  const {
    seed,
    corruption = 30,
    autoBalance = true,
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
    origThumb64: imageState.origThumb64,
    origMetrics: imageState.origMetrics,
    seed,
    corruption,
    autoBalance,
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
    corruption = 30,
    autoBalance = true,
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

  const origThumb64Buf = await sharp(Buffer.from(baseRgb.buffer, baseRgb.byteOffset, baseRgb.byteLength), { raw: { width: w, height: h, channels: 3 } })
    .resize(64, 64, { fit: 'fill' })
    .raw()
    .toBuffer();
  const origThumb64 = new Uint8Array(origThumb64Buf);
  const origMetrics = precomputeOrigMetrics(origThumb64);

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
    origThumb64,
    origMetrics,
    seed: `${seed}::${engine}`,
    corruption: isDqtHybrid ? Math.min(100, corruption + 15) : corruption,
    autoBalance,
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

  const origThumb64Buf = await sharp(normRgb, {
    raw: { width: info.width, height: info.height, channels: 3 },
  })
    .resize(64, 64, { fit: 'fill' })
    .raw()
    .toBuffer();

  const origThumb64 = new Uint8Array(origThumb64Buf);
  const origMetrics = precomputeOrigMetrics(origThumb64);
  const palette = extractPaletteFromThumb(origThumb64);

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
    origThumb: origThumb64,
    origThumb64,
    origMetrics,
    origBottomGray: origMetrics.origBottomGray,
    palette,
    paddedJpeg,
    structure,
    overscanRatio,
  };
}


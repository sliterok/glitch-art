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
  extractPaletteFromThumb,
  generateSeededPalette,
  harmonizeWithPalette,
  renderProceduralBase,
  synthesizeAlgoGlitch,
} from './procedural.js';

const PAD_TOP = 64; // 4 full 16px MCU rows

function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

async function canvasToJpeg(canvas, quality = 0.85) {
  let blob;
  if (canvas.convertToBlob) {
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } else {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  const buf = await blob.arrayBuffer();
  return { blob, uint8: new Uint8Array(buf) };
}

function putRgbOnCanvas(canvas, rgb, w, h) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.createImageData(w, h);
  const data = imgData.data;
  let s = 0;
  let d = 0;
  const len = w * h;
  for (let i = 0; i < len; i++) {
    data[d] = rgb[s];
    data[d + 1] = rgb[s + 1];
    data[d + 2] = rgb[s + 2];
    data[d + 3] = 255;
    s += 3;
    d += 4;
  }
  ctx.putImageData(imgData, 0, 0);
  return ctx;
}

function getRgbFromCanvas(canvas, w, h) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const rgb = new Uint8Array(w * h * 3);
  let s = 0;
  let d = 0;
  const len = w * h;
  for (let i = 0; i < len; i++) {
    rgb[d] = data[s];
    rgb[d + 1] = data[s + 1];
    rgb[d + 2] = data[s + 2];
    s += 4;
    d += 3;
  }
  return rgb;
}

function extractThumbRgb(source, cropTop, cropW, cropH) {
  const thumbCanvas = createCanvas(32, 32);
  const ctx = thumbCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, cropTop, cropW, cropH, 0, 0, 32, 32);
  const imgData = ctx.getImageData(0, 0, 32, 32);
  const data = imgData.data;
  const rgb = new Uint8Array(32 * 32 * 3);
  let s = 0;
  let d = 0;
  for (let i = 0; i < 32 * 32; i++) {
    rgb[d] = data[s];
    rgb[d + 1] = data[s + 1];
    rgb[d + 2] = data[s + 2];
    s += 4;
    d += 3;
  }
  return rgb;
}

function extractThumb64Rgb(source, cropTop, cropW, cropH) {
  const thumbCanvas = createCanvas(64, 64);
  const ctx = thumbCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, cropTop, cropW, cropH, 0, 0, 64, 64);
  const imgData = ctx.getImageData(0, 0, 64, 64);
  const data = imgData.data;
  const rgb = new Uint8Array(64 * 64 * 3);
  let s = 0;
  let d = 0;
  for (let i = 0; i < 4096; i++) {
    rgb[d] = data[s];
    rgb[d + 1] = data[s + 1];
    rgb[d + 2] = data[s + 2];
    s += 4;
    d += 3;
  }
  return rgb;
}

/**
 * Universal decoder compatible with Web Workers, OffscreenCanvas, and Window.
 * Prioritizes native createImageBitmap (available in workers) and falls back to Image in DOM.
 */
async function decodeToBitmapOrImage(blobOrUrl) {
  if (typeof createImageBitmap !== 'undefined') {
    let blob = blobOrUrl;
    if (typeof blobOrUrl === 'string') {
      const res = await fetch(blobOrUrl);
      blob = await res.blob();
    }
    const bmp = await createImageBitmap(blob);
    return {
      source: bmp,
      width: bmp.width,
      height: bmp.height,
      close: () => bmp.close(),
    };
  }

  if (typeof Image !== 'undefined') {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
      img.onload = () => {
        resolve({
          source: img,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          close: () => {
            if (typeof blobOrUrl !== 'string') URL.revokeObjectURL(url);
          },
        });
      };
      img.onerror = () => {
        if (typeof blobOrUrl !== 'string') URL.revokeObjectURL(url);
        reject(new Error('Image decode failed'));
      };
      img.src = url;
    });
  }

  throw new Error('No image decoder available in this environment');
}

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
  const paddedCanvas = createCanvas(width, height + PAD_TOP);
  putRgbOnCanvas(paddedCanvas, paddedRgb, width, height + PAD_TOP);
  const { uint8: jpeg } = await canvasToJpeg(paddedCanvas, quality / 100);
  const structure = parseJpegStructure(jpeg);
  return { jpeg, structure, overscanRatio: PAD_TOP / (height + PAD_TOP) };
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
  harmonizePalette = null,
  lockStrength = 0.48,
}) {
  const cVal = corruption !== undefined
    ? Number(corruption)
    : (maxDrift !== undefined ? Math.round((maxDrift / 140) * 80) : 30);
  const effectiveCorr = Math.max(0, Math.min(100, isNaN(cVal) ? 30 : cVal));

  const rng = createRng(`${seed}::${driftMode}::${Math.round(driftMultiplier * 10)}::corr:${effectiveCorr}`);

  const hasImageBitmap = typeof createImageBitmap !== 'undefined';
  const thumbCanvas = createCanvas(64, 64);
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
  const candThumb64 = new Uint8Array(64 * 64 * 3);

  let localMetrics = origMetrics;
  if (!localMetrics) {
    let localThumb = origThumb64;
    if (!localThumb || localThumb.length !== 64 * 64 * 3) {
      const baseBlob = new Blob([baseJpeg], { type: 'image/jpeg' });
      if (hasImageBitmap) {
        const bmp = await createImageBitmap(baseBlob, 0, PAD_TOP, width, height, {
          resizeWidth: 64,
          resizeHeight: 64,
          resizeQuality: 'pixelated',
        });
        thumbCtx.drawImage(bmp, 0, 0);
        bmp.close();
      } else {
        const decoded = await decodeToBitmapOrImage(baseBlob);
        thumbCtx.drawImage(decoded.source, 0, PAD_TOP, width, height, 0, 0, 64, 64);
        decoded.close();
      }
      const data = thumbCtx.getImageData(0, 0, 64, 64).data;
      localThumb = new Uint8Array(4096 * 3);
      for (let i = 0, s = 0, d = 0; i < 4096; i++, s += 4, d += 3) {
        localThumb[d] = data[s];
        localThumb[d + 1] = data[s + 1];
        localThumb[d + 2] = data[s + 2];
      }
    }
    localMetrics = precomputeOrigMetrics(localThumb);
  }

  const config = getCorruptionConfig(effectiveCorr, autoBalance);
  if (mutateDqt) config.mutateDqt = true;

  const K = 5;
  const zones = divideScanZones(structure.safeScanIndices, overscanRatio, K);

  let currentBuffer = new Uint8Array(baseJpeg);

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

      const candidateBlob = new Blob([candidateBuf], { type: 'image/jpeg' });
      let decodedOk = false;

      if (hasImageBitmap) {
        try {
          totalDecodes++;
          const bmp = await createImageBitmap(candidateBlob, 0, PAD_TOP, width, height, {
            resizeWidth: 64,
            resizeHeight: 64,
            resizeQuality: 'pixelated',
          });
          thumbCtx.drawImage(bmp, 0, 0);
          bmp.close();
          const data = thumbCtx.getImageData(0, 0, 64, 64).data;
          for (let i = 0, s = 0, d = 0; i < 4096; i++, s += 4, d += 3) {
            candThumb64[d] = data[s];
            candThumb64[d + 1] = data[s + 1];
            candThumb64[d + 2] = data[s + 2];
          }
          decodedOk = true;
        } catch {
          continue;
        }
      } else {
        let decoded;
        try {
          totalDecodes++;
          decoded = await decodeToBitmapOrImage(candidateBlob);
        } catch {
          continue;
        }
        try {
          thumbCtx.drawImage(decoded.source, 0, PAD_TOP, width, height, 0, 0, 64, 64);
          const data = thumbCtx.getImageData(0, 0, 64, 64).data;
          for (let i = 0, s = 0, d = 0; i < 4096; i++, s += 4, d += 3) {
            candThumb64[d] = data[s];
            candThumb64[d + 1] = data[s + 1];
            candThumb64[d + 2] = data[s + 2];
          }
          decodedOk = true;
        } finally {
          decoded.close();
        }
      }

      if (!decodedOk) continue;

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

  // Draw winning candidate onto cropped output canvas ONCE
  const outCanvas = createCanvas(width, height);
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  const winningBlob = new Blob([currentBuffer], { type: 'image/jpeg' });

  try {
    if (hasImageBitmap) {
      const bmp = await createImageBitmap(winningBlob, 0, PAD_TOP, width, height);
      outCtx.drawImage(bmp, 0, 0);
      bmp.close();
    } else {
      const decoded = await decodeToBitmapOrImage(winningBlob);
      outCtx.drawImage(decoded.source, 0, PAD_TOP, width, height, 0, 0, width, height);
      decoded.close();
    }
  } catch {
    // blank canvas fallback
  }

  if (harmonizePalette) {
    const finalRgb = getRgbFromCanvas(outCanvas, width, height);
    const harmonizedRgb = harmonizeWithPalette(finalRgb, harmonizePalette, lockStrength);
    putRgbOnCanvas(outCanvas, harmonizedRgb, width, height);
  }

  const { blob: outBlob, uint8 } = await canvasToJpeg(outCanvas, 0.92);
  const finalDiff = lastCommittedMetrics
    ? (lastCommittedMetrics.lumaMad + lastCommittedMetrics.chromaMad * 0.5)
    : 0;

  return {
    blob: outBlob,
    buffer: uint8,
    url: typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(outBlob) : null,
    diff: finalDiff,
    lumaMad: lastCommittedMetrics?.lumaMad || 0,
    chromaMad: lastCommittedMetrics?.chromaMad || 0,
    clipRatio: lastCommittedMetrics?.addedClipRatio || 0,
    detailRetention: lastCommittedMetrics?.detailRetention || 1.0,
    attempts: totalDecodes,
    fallback: !lastCommittedMetrics,
  };
}

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

  return {
    blob: result.blob,
    url: result.url,
    diff: result.diff,
    attempts: result.attempts,
    fallback: result.fallback,
    engine: includeDqt ? 'image+dqt' : 'image',
  };
}

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
    const canvas = createCanvas(w, h);
    putRgbOnCanvas(canvas, rgb, w, h);
    const { blob } = await canvasToJpeg(canvas, 0.92);

    return {
      blob,
      url: typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(blob) : null,
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

  const baseCanvas = createCanvas(w, h);
  putRgbOnCanvas(baseCanvas, baseRgb, w, h);
  const origThumb64 = extractThumb64Rgb(baseCanvas, 0, w, h);
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
    harmonizePalette: engine === 'palette-jpeg' ? palette : null,
    lockStrength: Math.max(0.28, Math.min(0.68, 0.72 - (maxDrift / 160) * 0.4)),
  });

  return {
    blob: result.blob,
    url: result.url,
    diff: result.diff,
    attempts: result.attempts,
    fallback: result.fallback,
    engine,
  };
}

export async function prepareUploadedImage(fileOrBlob, quality = 85) {
  const q = Math.max(30, Math.min(96, Number(quality) || 85));

  const decoded = await decodeToBitmapOrImage(fileOrBlob);

  let w = decoded.width;
  let h = decoded.height;
  if (w > 1280 || h > 1280) {
    const scale = Math.min(1280 / w, 1280 / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const normCanvas = createCanvas(w, h);
  const normCtx = normCanvas.getContext('2d', { willReadFrequently: true });
  normCtx.drawImage(decoded.source, 0, 0, w, h);
  decoded.close();

  const { blob: origJpegBlob } = await canvasToJpeg(normCanvas, 0.92);

  const normRgb = getRgbFromCanvas(normCanvas, w, h);
  const origThumb64 = extractThumb64Rgb(normCanvas, 0, w, h);
  const origMetrics = precomputeOrigMetrics(origThumb64);
  const palette = extractPaletteFromThumb(origThumb64);

  const { jpeg: paddedJpeg, structure, overscanRatio } = await encodeBaselinePadded(
    normRgb,
    w,
    h,
    q
  );

  return {
    rawSource: fileOrBlob,
    quality: q,
    width: w,
    height: h,
    origBlob: origJpegBlob,
    origJpegUrl: typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(origJpegBlob) : null,
    normRgb,
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

import { createRng } from './prng.js';
import { addTopOverscan, mutateJpeg, parseJpegStructure } from './jpegUtils.js';
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

function decodeImage(blobOrUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let url;
    let shouldRevoke = false;
    if (typeof blobOrUrl === 'string') {
      url = blobOrUrl;
    } else {
      url = URL.createObjectURL(blobOrUrl);
      shouldRevoke = true;
    }
    img.onload = () => {
      resolve({
        img,
        cleanup: () => {
          if (shouldRevoke) URL.revokeObjectURL(url);
        },
      });
    };
    img.onerror = () => {
      if (shouldRevoke) URL.revokeObjectURL(url);
      reject(new Error('Image decode failed'));
    };
    img.src = url;
  });
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
  origThumb,
  origBottomGray,
  seed,
  mutations,
  maxDrift,
  mutateDqt = false,
  dqtStrength = 6,
  maxAttempts = 16,
  harmonizePalette = null,
  lockStrength = 0.48,
}) {
  let best = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const rng = createRng(`${seed}::try:${attempt}`);
    const candidate = mutateJpeg(baseJpeg, structure, rng, {
      mutations,
      overscanRatio,
      mutateDqt,
      dqtStrength,
    });

    const candidateBlob = new Blob([candidate], { type: 'image/jpeg' });
    let decoded;
    try {
      decoded = await decodeImage(candidateBlob);
    } catch {
      continue;
    }

    let croppedThumb;
    try {
      croppedThumb = extractThumbRgb(decoded.img, PAD_TOP, width, height);
    } catch {
      decoded.cleanup();
      continue;
    }

    const addedGray = bottomGrayRatio(croppedThumb) - origBottomGray;
    const truncated = addedGray > 0.32;
    const { mad, topMad, stdDev } = thumbMetrics(croppedThumb, origThumb);

    const blownOut = stdDev < 9;
    const topShifted = topMad >= 3.0;

    const targetMad = maxDrift * 0.55;
    const score =
      Math.abs(mad - targetMad) +
      (truncated ? 150 : 0) +
      (blownOut ? 150 : 0) +
      (topShifted ? 0 : 85);

    const isGood = !truncated && !blownOut && topShifted && mad >= 4.0 && mad <= maxDrift;

    if (!best || score < best.score) {
      if (best?.cleanup) best.cleanup();
      best = {
        candidateBlob,
        decoded,
        mad,
        topMad,
        attempt,
        score,
        fallback: !isGood,
        cleanup: decoded.cleanup,
      };
    } else {
      decoded.cleanup();
    }

    if (isGood) {
      break;
    }
  }

  // Draw winning candidate onto cropped output canvas
  const outCanvas = createCanvas(width, height);
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });

  if (best && best.decoded) {
    outCtx.drawImage(best.decoded.img, 0, PAD_TOP, width, height, 0, 0, width, height);
    if (best.cleanup) best.cleanup();
  } else {
    // Fallback: draw from baseJpeg directly
    try {
      const fallbackDecoded = await decodeImage(new Blob([baseJpeg], { type: 'image/jpeg' }));
      outCtx.drawImage(fallbackDecoded.img, 0, PAD_TOP, width, height, 0, 0, width, height);
      fallbackDecoded.cleanup();
    } catch {
      // blank canvas fallback
    }
  }

  if (harmonizePalette) {
    const finalRgb = getRgbFromCanvas(outCanvas, width, height);
    const harmonizedRgb = harmonizeWithPalette(finalRgb, harmonizePalette, lockStrength);
    putRgbOnCanvas(outCanvas, harmonizedRgb, width, height);
  }

  const { blob: outBlob, uint8 } = await canvasToJpeg(outCanvas, 0.92);

  return {
    blob: outBlob,
    buffer: uint8,
    url: URL.createObjectURL(outBlob),
    diff: best ? best.mad : 0,
    attempts: best ? best.attempt : maxAttempts,
    fallback: best ? best.fallback : true,
  };
}

export async function glitchUploadedImage(imageState, opts) {
  const { seed, intensity, maxDrift, includeDqt } = opts;
  const result = await runValidatedJpegGlitch({
    baseJpeg: imageState.paddedJpeg,
    structure: imageState.structure,
    overscanRatio: imageState.overscanRatio,
    width: imageState.width,
    height: imageState.height,
    origThumb: imageState.origThumb,
    origBottomGray: imageState.origBottomGray,
    seed,
    mutations: intensity,
    maxDrift,
    mutateDqt: Boolean(includeDqt),
    dqtStrength: intensity,
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
    intensity = 6,
    maxDrift = 75,
    quality = 85,
    imagePalette = null,
    matchImagePalette = false,
  } = opts;

  const w = Math.max(256, Math.min(2560, Number(width) || 1024));
  const h = Math.max(256, Math.min(2560, Number(height) || 1024));
  const rng = createRng(seed);

  // Option 3: Pure Algorithmic Glitch Synthesizer
  if (engine === 'algo-synth') {
    const rgb = synthesizeAlgoGlitch(w, h, rng, {
      pattern,
      intensity,
      maxDrift,
      quality,
    });
    const canvas = createCanvas(w, h);
    putRgbOnCanvas(canvas, rgb, w, h);
    const { blob } = await canvasToJpeg(canvas, 0.92);

    return {
      blob,
      url: URL.createObjectURL(blob),
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
  const origThumb = extractThumbRgb(baseCanvas, 0, w, h);
  const origBottomGray = bottomGrayRatio(origThumb);

  const { jpeg: baseJpeg, structure, overscanRatio } = await encodeBaselinePadded(
    baseRgb,
    w,
    h,
    quality
  );

  const isDqtHybrid = engine === 'dqt-hybrid';
  const result = await runValidatedJpegGlitch({
    baseJpeg,
    structure,
    overscanRatio,
    width: w,
    height: h,
    origThumb,
    origBottomGray,
    seed: `${seed}::${engine}`,
    mutations: isDqtHybrid ? Math.max(2, Math.round(intensity * 0.85)) : intensity,
    maxDrift: isDqtHybrid ? Math.min(150, maxDrift + 25) : maxDrift,
    mutateDqt: isDqtHybrid,
    dqtStrength: intensity,
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

  const decoded = await decodeImage(fileOrBlob);
  const img = decoded.img;

  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (w > 1280 || h > 1280) {
    const scale = Math.min(1280 / w, 1280 / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const normCanvas = createCanvas(w, h);
  const normCtx = normCanvas.getContext('2d', { willReadFrequently: true });
  normCtx.drawImage(img, 0, 0, w, h);
  decoded.cleanup();

  const { blob: origJpegBlob } = await canvasToJpeg(normCanvas, 0.92);
  const origJpegUrl = URL.createObjectURL(origJpegBlob);

  const normRgb = getRgbFromCanvas(normCanvas, w, h);
  const origThumb = extractThumbRgb(normCanvas, 0, w, h);
  const origBottomGray = bottomGrayRatio(origThumb);
  const palette = extractPaletteFromThumb(origThumb);

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
    origJpegUrl,
    origBlob: origJpegBlob,
    normRgb,
    origThumb,
    origBottomGray,
    palette,
    paddedJpeg,
    structure,
    overscanRatio,
  };
}

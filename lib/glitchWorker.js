import {
  generateGlitchBackground,
  glitchUploadedImage,
  prepareUploadedImage,
} from './glitchEngine.js';

let workerImageState = null;

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    if (type === 'prepareUploadedImage') {
      const prepared = await prepareUploadedImage(payload.fileOrBlob, payload.quality);
      workerImageState = prepared;
      self.postMessage({
        id,
        ok: true,
        data: {
          width: prepared.width,
          height: prepared.height,
          palette: prepared.palette,
          origBlob: prepared.origBlob,
        },
      });
    } else if (type === 'clearImage') {
      workerImageState = null;
      self.postMessage({ id, ok: true });
    } else if (type === 'glitchUploadedImage') {
      if (payload.quality !== workerImageState.quality) {
        const refreshed = await prepareUploadedImage(workerImageState.rawSource, payload.quality);
        refreshed.palette = workerImageState.palette;
        workerImageState = refreshed;
      }
      const result = await glitchUploadedImage(workerImageState, payload.opts);
      self.postMessage({
        id,
        ok: true,
        data: {
          blob: result.blob,
          diff: result.diff,
          attempts: result.attempts,
          fallback: result.fallback,
          engine: result.engine,
        },
      });
    } else if (type === 'generateGlitchBackground') {
      const result = await generateGlitchBackground({
        ...payload.opts,
        imagePalette: workerImageState?.palette || null,
      });
      self.postMessage({
        id,
        ok: true,
        data: {
          blob: result.blob,
          diff: result.diff,
          attempts: result.attempts,
          fallback: result.fallback,
          engine: result.engine,
        },
      });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};


import { createRequire } from 'node:module';
// Lazily loads OpenCV (WebAssembly build) once per process.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;
let ready: Promise<{ cv: CV }> | undefined;

/** Note: the Emscripten module is a thenable, so it must never be returned bare from an async function. */
export async function loadCv(): Promise<CV> {
  ready ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Imported lazily: the WebAssembly bundle is ~10 MB and only the recognition worker needs it.
    // require(), not import(): the Emscripten module object is a thenable and some loaders await it forever.
    let cv: any = createRequire(import.meta.url)('@techstark/opencv-js');
    if (cv instanceof Promise) cv = await cv;
    else if (!cv.Mat) await new Promise<void>((resolve) => (cv.onRuntimeInitialized = () => resolve()));
    if (typeof cv.then === 'function') {
      try {
        delete cv.then;
      } catch {
        /* ignore */
      }
    }
    return { cv };
  })();
  return (await ready).cv;
}

/** Simple RGB raster used across the pipeline (row-major, 3 bytes per pixel). */
export interface Raster {
  width: number;
  height: number;
  data: Uint8Array; // RGB
}

export function matFromRaster(cv: CV, r: Raster) {
  const mat = new cv.Mat(r.height, r.width, cv.CV_8UC3);
  mat.data.set(r.data);
  return mat;
}

export function rasterFromMat(m: CV): Raster {
  if (m.type() !== 16 /* CV_8UC3 */) throw new Error('Expected an 8-bit RGB matrix');
  return { width: m.cols, height: m.rows, data: new Uint8Array(m.data) };
}

/** Run fn with a scope that deletes every Mat registered through track(). */
export function withMats<T>(fn: (track: <M>(m: M) => M) => T): T {
  const mats: { delete(): void }[] = [];
  const track = <M>(m: M) => {
    mats.push(m as unknown as { delete(): void });
    return m;
  };
  try {
    return fn(track);
  } finally {
    for (const m of mats) {
      try {
        m.delete();
      } catch {
        /* already deleted */
      }
    }
  }
}

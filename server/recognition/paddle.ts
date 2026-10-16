// PaddleOCR (PP-OCR) text detection, orientation classification and recognition via ONNX Runtime.
// Runs entirely on the local CPU. Model files are listed in server/recognition/models.ts.
import * as ort from 'onnxruntime-node';
import { readFile } from 'node:fs/promises';
import { loadCv, matFromRaster, withMats, type CV, type Raster } from './cv.ts';

export interface ModelPaths {
  det: string;
  rec: string;
  dict: string;
  cls?: string;
}

/** A rotated text box in image coordinates (4 points clockwise from top-left). */
export type Quad = [number, number][];

export interface DetBox {
  quad: Quad;
  score: number;
}

export interface CharPos {
  ch: string;
  /** fraction 0..1 along the crop width */
  pos: number;
  prob: number;
}

export interface RecResult {
  text: string;
  confidence: number;
  chars: CharPos[];
}

export interface DetOptions {
  maxSide?: number;
  thresh?: number;
  boxThresh?: number;
  unclipRatio?: number;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export class PaddleOcr {
  det: ort.InferenceSession;
  rec: ort.InferenceSession;
  cls: ort.InferenceSession | undefined;
  charset: string[];
  name: string;
  constructor(det: ort.InferenceSession, rec: ort.InferenceSession, cls: ort.InferenceSession | undefined, charset: string[], name: string) {
    this.det = det;
    this.rec = rec;
    this.cls = cls;
    this.charset = charset;
    this.name = name;
  }

  static async load(paths: ModelPaths, name: string): Promise<PaddleOcr> {
    const opts: ort.InferenceSession.SessionOptions = { graphOptimizationLevel: 'all' };
    const [det, rec, cls, dictText] = await Promise.all([
      ort.InferenceSession.create(paths.det, opts),
      ort.InferenceSession.create(paths.rec, opts),
      paths.cls ? ort.InferenceSession.create(paths.cls, opts) : Promise.resolve(undefined),
      readFile(paths.dict, 'utf8'),
    ]);
    // Some distributed dictionaries contain stray blank lines; a blank entry is never a real class.
    const dict = dictText
      .replace(/\r/g, '')
      .split('\n')
      .filter((c) => c !== '');
    const ocr = new PaddleOcr(det, rec, cls, dict, name);
    return ocr;
  }

  /** Detect text regions. Returns quads in the coordinate space of `img`. */
  async detect(img: Raster, o: DetOptions = {}): Promise<DetBox[]> {
    const cv = await loadCv();
    const maxSide = o.maxSide ?? 1600;
    const thresh = o.thresh ?? 0.3;
    const boxThresh = o.boxThresh ?? 0.5;
    const unclip = o.unclipRatio ?? 1.6;

    let ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
    // Never shrink below ~960 on the long side; tiny text needs pixels.
    if (Math.max(img.width, img.height) * ratio < 960) ratio = Math.min(2, 960 / Math.max(img.width, img.height));
    const rw = Math.max(32, Math.round((img.width * ratio) / 32) * 32);
    const rh = Math.max(32, Math.round((img.height * ratio) / 32) * 32);

    const input = withMats((t) => {
      const src = t(matFromRaster(cv, img));
      const resized = t(new cv.Mat());
      cv.resize(src, resized, new cv.Size(rw, rh), 0, 0, cv.INTER_LINEAR);
      const data = new Float32Array(3 * rw * rh);
      const px = resized.data as Uint8Array;
      const plane = rw * rh;
      // Paddle models were trained on BGR input.
      for (let i = 0; i < plane; i++) {
        const r = px[i * 3],
          g = px[i * 3 + 1],
          b = px[i * 3 + 2];
        data[i] = (b / 255 - MEAN[0]) / STD[0];
        data[plane + i] = (g / 255 - MEAN[1]) / STD[1];
        data[2 * plane + i] = (r / 255 - MEAN[2]) / STD[2];
      }
      return data;
    });

    const feeds = { [this.det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, rh, rw]) };
    const out = await this.det.run(feeds);
    const prob = out[this.det.outputNames[0]].data as Float32Array;
    const sx = img.width / rw;
    const sy = img.height / rh;
    return dbPostprocess(cv, prob, rw, rh, thresh, boxThresh, unclip).map((b) => ({
      score: b.score,
      quad: b.quad.map(([x, y]) => [clamp(x * sx, 0, img.width - 1), clamp(y * sy, 0, img.height - 1)]) as Quad,
    }));
  }

  /** Probability that each crop is upside down (rotated 180 degrees). */
  async upsideDown(crops: Raster[]): Promise<number[]> {
    if (!this.cls || !crops.length) return crops.map(() => 0);
    const cv = await loadCv();
    const H = 48,
      W = 192;
    const result: number[] = [];
    for (let s = 0; s < crops.length; s += 16) {
      const batch = crops.slice(s, s + 16);
      const data = new Float32Array(batch.length * 3 * H * W);
      batch.forEach((c, bi) => fillRecTensor(cv, c, data, bi, H, W));
      const out = await this.cls.run({ [this.cls.inputNames[0]]: new ort.Tensor('float32', data, [batch.length, 3, H, W]) });
      const p = out[this.cls.outputNames[0]].data as Float32Array;
      for (let i = 0; i < batch.length; i++) result.push(p[i * 2 + 1]);
    }
    return result;
  }

  /** Recognize text in each crop (crops should be horizontal text lines). */
  async recognize(crops: Raster[]): Promise<RecResult[]> {
    const cv = await loadCv();
    const H = 48;
    const order = crops.map((c, i) => ({ i, r: c.width / Math.max(1, c.height) })).sort((a, b) => a.r - b.r);
    const results: RecResult[] = new Array(crops.length);
    const batchSize = 6;
    for (let s = 0; s < order.length; s += batchSize) {
      const items = order.slice(s, s + batchSize);
      const maxR = Math.max(320 / 48, ...items.map((x) => x.r));
      const W = Math.min(3200, Math.ceil(H * maxR));
      const data = new Float32Array(items.length * 3 * H * W);
      const used: number[] = [];
      items.forEach((it, bi) => used.push(fillRecTensor(cv, crops[it.i], data, bi, H, W)));
      const out = await this.rec.run({ [this.rec.inputNames[0]]: new ort.Tensor('float32', data, [items.length, 3, H, W]) });
      const tensor = out[this.rec.outputNames[0]];
      const [, T, C] = tensor.dims as number[];
      const probs = tensor.data as Float32Array;
      items.forEach((it, bi) => {
        results[it.i] = ctcDecode(probs, bi, T, C, this.charset, used[bi] / W);
      });
    }
    return results;
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Resize to height H (keeping aspect), normalise to [-1,1], write into batch slot. Returns used width. */
function fillRecTensor(cv: CV, crop: Raster, data: Float32Array, bi: number, H: number, W: number): number {
  return withMats((t) => {
    const src = t(matFromRaster(cv, crop));
    const ratio = crop.width / Math.max(1, crop.height);
    const w = Math.max(1, Math.min(W, Math.ceil(H * ratio)));
    const resized = t(new cv.Mat());
    cv.resize(src, resized, new cv.Size(w, H), 0, 0, cv.INTER_LINEAR);
    const px = resized.data as Uint8Array;
    const plane = H * W;
    const base = bi * 3 * plane;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 3;
        const o = y * W + x;
        // BGR order, (v/255 - 0.5) / 0.5
        data[base + o] = px[p + 2] / 127.5 - 1;
        data[base + plane + o] = px[p + 1] / 127.5 - 1;
        data[base + 2 * plane + o] = px[p] / 127.5 - 1;
      }
    }
    return w;
  });
}

function ctcDecode(probs: Float32Array, bi: number, T: number, C: number, charset: string[], usedFrac: number): RecResult {
  const spaceIdx = charset.length + 1 === C - 1 ? C - 1 : -1;
  let last = -1;
  const chars: CharPos[] = [];
  const effectiveT = Math.max(1, Math.round(T * Math.min(1, usedFrac)));
  for (let t = 0; t < T; t++) {
    let best = 0,
      bestP = -1;
    const off = (bi * T + t) * C;
    for (let c = 0; c < C; c++) {
      const p = probs[off + c];
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    if (best !== 0 && best !== last) {
      const ch = best === spaceIdx ? ' ' : (charset[best - 1] ?? '');
      chars.push({ ch, pos: (t + 0.5) / effectiveT, prob: bestP });
    }
    last = best;
  }
  const text = chars.map((c) => c.ch).join('');
  const scored = chars.filter((c) => c.ch !== ' ');
  const confidence = scored.length ? scored.reduce((a, c) => a + c.prob, 0) / scored.length : 0;
  return { text, confidence, chars };
}

/** DB (differentiable binarization) post-processing: probability map -> rotated boxes. */
function dbPostprocess(cv: CV, prob: Float32Array, w: number, h: number, thresh: number, boxThresh: number, unclipRatio: number): DetBox[] {
  return withMats((t) => {
    const bin = t(new cv.Mat(h, w, cv.CV_8UC1));
    const bd = bin.data as Uint8Array;
    for (let i = 0; i < w * h; i++) bd[i] = prob[i] > thresh ? 255 : 0;
    const contours = t(new cv.MatVector());
    const hierarchy = t(new cv.Mat());
    cv.findContours(bin, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const boxes: DetBox[] = [];
    const n = Math.min(contours.size(), 2000);
    for (let i = 0; i < n; i++) {
      const cnt = contours.get(i);
      try {
        const rect = cv.minAreaRect(cnt);
        if (Math.min(rect.size.width, rect.size.height) < 3) continue;
        // Box score: mean probability inside the contour's bounding rect area covered by the contour.
        const br = cv.boundingRect(cnt);
        const score = meanProbInContour(cv, prob, w, h, cnt, br);
        if (score < boxThresh) continue;
        const area = rect.size.width * rect.size.height;
        const perim = 2 * (rect.size.width + rect.size.height);
        const d = (area * unclipRatio) / perim;
        const grown = { center: rect.center, size: { width: rect.size.width + 2 * d, height: rect.size.height + 2 * d }, angle: rect.angle };
        if (Math.min(grown.size.width, grown.size.height) < 5) continue;
        boxes.push({ quad: orderQuad(rectPoints(grown)), score });
      } finally {
        cnt.delete();
      }
    }
    return boxes;
  });
}

function meanProbInContour(cv: CV, prob: Float32Array, w: number, h: number, cnt: CV, br: { x: number; y: number; width: number; height: number }) {
  return withMats((t) => {
    const mask = t(cv.Mat.zeros(br.height, br.width, cv.CV_8UC1));
    const shifted = t(new cv.Mat());
    const pts = cnt.data32S as Int32Array;
    const arr: number[] = [];
    for (let i = 0; i < pts.length; i += 2) arr.push(pts[i] - br.x, pts[i + 1] - br.y);
    const m = t(cv.matFromArray(arr.length / 2, 1, cv.CV_32SC2, arr));
    const vec = t(new cv.MatVector());
    vec.push_back(m);
    cv.fillPoly(mask, vec, new cv.Scalar(1));
    void shifted;
    const md = mask.data as Uint8Array;
    let sum = 0,
      count = 0;
    for (let y = 0; y < br.height; y++) {
      const yy = br.y + y;
      if (yy < 0 || yy >= h) continue;
      for (let x = 0; x < br.width; x++) {
        if (!md[y * br.width + x]) continue;
        const xx = br.x + x;
        if (xx < 0 || xx >= w) continue;
        sum += prob[yy * w + xx];
        count++;
      }
    }
    return count ? sum / count : 0;
  });
}

export function rectPoints(r: { center: { x: number; y: number }; size: { width: number; height: number }; angle: number }): Quad {
  const a = (r.angle * Math.PI) / 180;
  const c = Math.cos(a),
    s = Math.sin(a);
  const hw = r.size.width / 2,
    hh = r.size.height / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => [r.center.x + x * c - y * s, r.center.y + x * s + y * c]) as Quad;
}

/** Order 4 points: top-left, top-right, bottom-right, bottom-left (reading orientation). */
export function orderQuad(q: Quad): Quad {
  const pts = [...q].sort((a, b) => a[0] - b[0]);
  const left = pts.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const right = pts.slice(2).sort((a, b) => a[1] - b[1]);
  return [left[0], right[0], right[1], left[1]];
}

/** Perspective-crop a quad into an upright raster. Tall crops are rotated to horizontal. */
export async function cropQuad(img: Raster, quad: Quad, pad = 0): Promise<Raster> {
  const cv = await loadCv();
  const [tl, tr, br, bl] = quad;
  const wTop = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const wBot = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const hL = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const hR = Math.hypot(br[0] - tr[0], br[1] - tr[1]);
  const W = Math.max(2, Math.round(Math.max(wTop, wBot) + 2 * pad));
  const H = Math.max(2, Math.round(Math.max(hL, hR) + 2 * pad));
  return withMats((t) => {
    const src = t(matFromRaster(cv, img));
    const s = t(cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat()));
    const d = t(cv.matFromArray(4, 1, cv.CV_32FC2, [pad, pad, W - pad, pad, W - pad, H - pad, pad, H - pad]));
    const M = t(cv.getPerspectiveTransform(s, d));
    const dst = t(new cv.Mat());
    cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    let out = dst;
    if (H / W >= 1.5) {
      const rot = t(new cv.Mat());
      cv.rotate(dst, rot, cv.ROTATE_90_COUNTERCLOCKWISE);
      out = rot;
    }
    return { width: out.cols, height: out.rows, data: new Uint8Array(out.data) };
  });
}

// Image decoding, card boundary detection, perspective correction and enhancement.
import sharp from 'sharp';
import { loadCv, matFromRaster, withMats, type CV, type Raster } from './cv.ts';
import { orderQuad, type Quad } from './paddle.ts';

export const MAX_DECODE_SIDE = 4800;

export class ImageFormatError extends Error {
  code: string;
  constructor(message: string, code = 'unsupported_image') {
    super(message);
    this.code = code;
  }
}

/** Sniff the container type from magic bytes (the browser-supplied MIME type is not trusted). */
export function sniffImageType(buf: Uint8Array): 'jpeg' | 'png' | 'webp' | 'heic' | 'gif' | 'unknown' {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  const ascii = (a: number, b: number) => String.fromCharCode(...buf.subarray(a, b));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(brand)) return brand === 'avif' ? 'unknown' : 'heic';
  }
  if (ascii(0, 3) === 'GIF') return 'gif';
  return 'unknown';
}

async function decodeHeic(buf: Uint8Array): Promise<Raster> {
  // heic-decode bundles a WebAssembly libheif build with an HEVC decoder (optional dependency).
  let decode: (o: { buffer: Uint8Array }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  try {
    decode = (await import('heic-decode')).default;
  } catch {
    throw new ImageFormatError(
      'This is an HEIC/HEIF photo and the HEIC decoder is not installed. Run "npm install" again, or on the iPhone choose Settings → Camera → Formats → Most Compatible (JPEG).',
      'heic_unavailable',
    );
  }
  try {
    const { width, height, data } = await decode({ buffer: buf });
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    // HEIC images are stored in display orientation by libheif (irot/imir applied).
    return downscaleRaster({ width, height, data: rgb }, MAX_DECODE_SIDE);
  } catch (e) {
    throw new ImageFormatError(`Could not decode this HEIC photo (${(e as Error).message}). Export it as JPEG and try again.`, 'heic_failed');
  }
}

/** Decode JPEG/PNG/WebP/HEIC into an upright RGB raster (EXIF orientation applied). */
export async function decodeImage(buf: Uint8Array): Promise<{ raster: Raster; format: string; originalWidth: number; originalHeight: number }> {
  const format = sniffImageType(buf);
  if (format === 'heic') {
    const raster = await decodeHeic(buf);
    return { raster, format, originalWidth: raster.width, originalHeight: raster.height };
  }
  if (format === 'gif' || format === 'unknown')
    throw new ImageFormatError(
      format === 'gif' ? 'GIF images are not supported. Use a JPEG, PNG, WebP or HEIC photo.' : 'This file is not a supported image (JPEG, PNG, WebP or HEIC).',
    );
  try {
    const img = sharp(buf, { failOn: 'error', limitInputPixels: 120_000_000 }).rotate();
    const meta = await img.metadata();
    const { data, info } = await img
      .resize({ width: MAX_DECODE_SIDE, height: MAX_DECODE_SIDE, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error(`unexpected channel count ${info.channels}`);
    const swap = (meta.orientation ?? 1) >= 5;
    return {
      raster: { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) },
      format,
      originalWidth: (swap ? meta.height : meta.width) ?? info.width,
      originalHeight: (swap ? meta.width : meta.height) ?? info.height,
    };
  } catch (e) {
    throw new ImageFormatError(
      `The ${format.toUpperCase()} file could not be read (${(e as Error).message}). It may be truncated or corrupted.`,
      'decode_failed',
    );
  }
}

export async function downscaleRaster(r: Raster, maxSide: number): Promise<Raster> {
  const s = maxSide / Math.max(r.width, r.height);
  if (s >= 1) return r;
  return resizeRaster(r, Math.round(r.width * s), Math.round(r.height * s));
}

export async function resizeRaster(r: Raster, w: number, h: number): Promise<Raster> {
  const cv = await loadCv();
  return withMats((t) => {
    const src = t(matFromRaster(cv, r));
    const dst = t(new cv.Mat());
    cv.resize(src, dst, new cv.Size(w, h), 0, 0, w > r.width ? cv.INTER_CUBIC : cv.INTER_AREA);
    return { width: w, height: h, data: new Uint8Array(dst.data) };
  });
}

export async function rotateRaster(r: Raster, quarterTurnsCW: number): Promise<Raster> {
  const k = ((quarterTurnsCW % 4) + 4) % 4;
  if (k === 0) return r;
  const cv = await loadCv();
  return withMats((t) => {
    const src = t(matFromRaster(cv, r));
    const dst = t(new cv.Mat());
    cv.rotate(src, dst, k === 1 ? cv.ROTATE_90_CLOCKWISE : k === 2 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE);
    return { width: dst.cols, height: dst.rows, data: new Uint8Array(dst.data) };
  });
}

export async function encodeJpeg(r: Raster, quality = 92): Promise<Buffer> {
  return sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.length), { raw: { width: r.width, height: r.height, channels: 3 } })
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** Contrast-limited histogram equalisation on luminance; keeps faint grey text readable. */
export async function enhanceContrast(r: Raster): Promise<Raster> {
  const cv = await loadCv();
  return withMats((t) => {
    const src = t(matFromRaster(cv, r));
    const lab = t(new cv.Mat());
    cv.cvtColor(src, lab, cv.COLOR_RGB2Lab);
    const planes = t(new cv.MatVector());
    cv.split(lab, planes);
    const L = t(planes.get(0));
    const clahe = t(new cv.CLAHE(3.0, new cv.Size(8, 8)));
    const L2 = t(new cv.Mat());
    clahe.apply(L, L2);
    // Build a 3-channel grey image from the equalised luminance.
    const rgb = t(new cv.Mat());
    cv.cvtColor(L2, rgb, cv.COLOR_GRAY2RGB);
    return { width: rgb.cols, height: rgb.rows, data: new Uint8Array(rgb.data) };
  });
}

export interface CardDetection {
  quad: Quad | null; // in source image coordinates
  method: string;
  score: number;
}

interface Candidate {
  quad: Quad;
  method: string;
}

function polyArea(q: Quad) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % q.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function sideLengths(q: Quad) {
  return q.map((p, i) => Math.hypot(q[(i + 1) % 4][0] - p[0], q[(i + 1) % 4][1] - p[1]));
}

function isConvex(q: Quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i],
      [bx, by] = q[(i + 1) % 4],
      [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    const s = Math.sign(cross);
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function cornerAngles(q: Quad) {
  return q.map((p, i) => {
    const a = q[(i + 3) % 4],
      b = q[(i + 1) % 4];
    const v1 = [a[0] - p[0], a[1] - p[1]],
      v2 = [b[0] - p[0], b[1] - p[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) + 1e-9);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  });
}

/** Find the business card's outline in a photo. Returns null quad when no confident card edge exists. */
export async function detectCard(img: Raster): Promise<CardDetection> {
  const cv = await loadCv();
  const scale = Math.min(1, 900 / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale),
    h = Math.round(img.height * scale);
  return withMats((t) => {
    const src = t(matFromRaster(cv, img));
    const small = t(new cv.Mat());
    cv.resize(src, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    const blurred = t(new cv.Mat());
    cv.GaussianBlur(small, blurred, new cv.Size(5, 5), 0);
    const gray = t(new cv.Mat());
    cv.cvtColor(blurred, gray, cv.COLOR_RGB2GRAY);
    const lab = t(new cv.Mat());
    cv.cvtColor(blurred, lab, cv.COLOR_RGB2Lab);

    const gradMag = gradientMagnitude(cv, t, gray);
    const candidates: Candidate[] = [];

    // Strategy A: Canny edges (several sensitivities) -> outer contours.
    for (const [lo, hi] of [
      [30, 90],
      [60, 160],
      [15, 50],
    ]) {
      const edges = t(new cv.Mat());
      cv.Canny(gray, edges, lo, hi);
      const k = t(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
      cv.dilate(edges, edges, k);
      collectQuads(cv, t, edges, candidates, `edges${lo}`);
    }
    // Strategy B: separate card from background colour (median border colour in Lab space).
    const dist = t(colourDistanceFromBorder(cv, t, lab));
    const binB = t(new cv.Mat());
    cv.threshold(dist, binB, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const k2 = t(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
    cv.morphologyEx(binB, binB, cv.MORPH_CLOSE, k2);
    cv.morphologyEx(binB, binB, cv.MORPH_OPEN, k2);
    collectQuads(cv, t, binB, candidates, 'colour');
    // Strategy C: brightness (light card on dark surface or vice versa).
    const binC = t(new cv.Mat());
    cv.threshold(gray, binC, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(binC, binC, cv.MORPH_CLOSE, k2);
    collectQuads(cv, t, binC, candidates, 'bright');
    const binD = t(new cv.Mat());
    cv.bitwise_not(binC, binD);
    collectQuads(cv, t, binD, candidates, 'dark');

    const scored: { quad: Quad; score: number; method: string; area: number }[] = [];
    const total = w * h;
    for (const c of candidates) {
      const q = orderQuad(c.quad);
      if (!isConvex(q)) continue;
      const area = polyArea(q);
      const frac = area / total;
      if (frac < 0.06 || frac > 0.97) continue;
      const angles = cornerAngles(q);
      const worst = Math.max(...angles.map((a) => Math.abs(90 - a)));
      if (worst > 28) continue;
      const sides = sideLengths(q);
      const wq = (sides[0] + sides[2]) / 2,
        hq = (sides[1] + sides[3]) / 2;
      const aspect = Math.max(wq, hq) / Math.max(1, Math.min(wq, hq));
      if (aspect > 2.6) continue;
      // Edge support: average gradient along the quad outline (card edges are strong, continuous lines).
      const edge = perimeterGradient(gradMag, w, h, q);
      // Touching the frame border usually means a partial region, not the card edge.
      const margin = 3;
      const touches = q.filter(([x, y]) => x < margin || y < margin || x > w - margin || y > h - margin).length;
      const aspectBonus = aspect >= 1.35 && aspect <= 2.0 ? 1 : aspect < 1.15 ? 0.85 : 0.92;
      const score = edge * aspectBonus * (1 - worst / 90) * Math.min(1, frac / 0.15 + 0.5) * (touches >= 2 ? 0.55 : 1);
      scored.push({ quad: q, score, method: c.method, area });
    }
    scored.sort((a, b) => b.score - a.score);
    let best = scored[0];
    if (best) {
      // A coloured panel or logo block inside the card can out-score the card outline itself. Prefer a
      // larger candidate that encloses the winner and still has convincing edges.
      const enclosing = scored.filter(
        (c) => c !== best && c.area > best.area * 1.25 && c.score >= Math.max(18, best.score * 0.45) && best.quad.every((p) => insideQuad(c.quad, p, 6)),
      );
      if (enclosing.length) {
        enclosing.sort((a, b) => b.score - a.score);
        best = { ...enclosing[0], method: enclosing[0].method + '+enclosing' };
      }
    }
    if (!best || best.score < 18) return { quad: null, method: 'none', score: best?.score ?? 0 };
    const inv = 1 / scale;
    return { quad: best.quad.map(([x, y]) => [x * inv, y * inv]) as Quad, method: best.method, score: best.score };
  });
}

function gradientMagnitude(cv: CV, t: <M>(m: M) => M, gray: CV): Float32Array {
  const gx = t(new cv.Mat());
  const gy = t(new cv.Mat());
  cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3);
  cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3);
  const mag = t(new cv.Mat());
  cv.magnitude(gx, gy, mag);
  return new Float32Array(mag.data32F);
}

function perimeterGradient(mag: Float32Array, w: number, h: number, q: Quad): number {
  let sum = 0,
    n = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i],
      [x2, y2] = q[(i + 1) % 4];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(2, Math.floor(len / 2));
    let sideSum = 0;
    for (let s = 0; s <= steps; s++) {
      const x = x1 + ((x2 - x1) * s) / steps,
        y = y1 + ((y2 - y1) * s) / steps;
      // take the max in a small neighbourhood (edge may be off by a pixel or two)
      let m = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = Math.round(x + dx),
            yy = Math.round(y + dy);
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) m = Math.max(m, mag[yy * w + xx]);
        }
      sideSum += Math.min(m, 400);
      n++;
    }
    sum += sideSum;
  }
  return n ? sum / n / 4 : 0;
}

function colourDistanceFromBorder(cv: CV, t: <M>(m: M) => M, lab: CV): CV {
  const w = lab.cols,
    h = lab.rows;
  const d = lab.data as Uint8Array;
  const samples: number[][] = [[], [], []];
  const bw = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      if (x >= bw && y >= bw && x < w - bw && y < h - bw) continue;
      const p = (y * w + x) * 3;
      samples[0].push(d[p]);
      samples[1].push(d[p + 1]);
      samples[2].push(d[p + 2]);
    }
  const med = samples.map((s) => s.sort((a, b) => a - b)[Math.floor(s.length / 2)] ?? 0);
  const out = new cv.Mat(h, w, cv.CV_8UC1);
  const o = out.data as Uint8Array;
  for (let i = 0; i < w * h; i++) {
    const p = i * 3;
    const dl = (d[p] - med[0]) * 0.6,
      da = d[p + 1] - med[1],
      db = d[p + 2] - med[2];
    o[i] = Math.min(255, Math.sqrt(dl * dl + da * da + db * db) * 2);
  }
  void t;
  return out;
}

function collectQuads(cv: CV, t: <M>(m: M) => M, bin: CV, out: Candidate[], method: string) {
  const contours = t(new cv.MatVector());
  const hier = t(new cv.Mat());
  cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const items: { i: number; area: number }[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    items.push({ i, area: cv.contourArea(c) });
    c.delete();
  }
  items.sort((a, b) => b.area - a.area);
  for (const { i, area } of items.slice(0, 6)) {
    if (area < 0.04 * bin.cols * bin.rows) break;
    const c = t(contours.get(i));
    const hull = t(new cv.Mat());
    cv.convexHull(c, hull, false, true);
    const peri = cv.arcLength(hull, true);
    for (const eps of [0.015, 0.02, 0.03, 0.045]) {
      const approx = t(new cv.Mat());
      cv.approxPolyDP(hull, approx, eps * peri, true);
      if (approx.rows === 4) {
        const p = approx.data32S as Int32Array;
        out.push({
          quad: [
            [p[0], p[1]],
            [p[2], p[3]],
            [p[4], p[5]],
            [p[6], p[7]],
          ],
          method,
        });
        break;
      }
    }
    // Rounded corners or a partly occluded edge: fall back to the min-area rectangle when it fits tightly.
    const rect = cv.minAreaRect(c);
    const rArea = rect.size.width * rect.size.height;
    if (rArea > 0 && area / rArea > 0.88) {
      const pts = cv.RotatedRect.points(rect);
      out.push({ quad: pts.map((p: { x: number; y: number }) => [p.x, p.y]) as Quad, method: method + '-rect' });
    }
  }
}

/** Warp the card quad to an upright rectangle at full resolution. */
export async function rectify(img: Raster, quad: Quad): Promise<Raster> {
  const cv = await loadCv();
  const s = sideLengths(quad);
  const W = Math.round(Math.max(s[0], s[2]));
  const H = Math.round(Math.max(s[1], s[3]));
  return withMats((t) => {
    const src = t(matFromRaster(cv, img));
    const a = t(cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat()));
    const b = t(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]));
    const M = t(cv.getPerspectiveTransform(a, b));
    const dst = t(new cv.Mat());
    cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    return { width: W, height: H, data: new Uint8Array(dst.data) };
  });
}

function insideQuad(q: Quad, p: [number, number], tolerance: number): boolean {
  // Point-in-convex-polygon test with a tolerance in pixels.
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i],
      [bx, by] = q[(i + 1) % 4];
    const cross = (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    if (cross / len < -tolerance) return false;
  }
  return true;
}

/** Rotate by an arbitrary angle (degrees, positive = the content's clockwise tilt is undone), expanding the canvas. */
export async function rotateByAngle(r: Raster, angleDeg: number): Promise<Raster> {
  const cv = await loadCv();
  return withMats((t) => {
    const src = t(matFromRaster(cv, r));
    const center = new cv.Point(r.width / 2, r.height / 2);
    const M = t(cv.getRotationMatrix2D(center, angleDeg, 1));
    const rad = (Math.abs(angleDeg) * Math.PI) / 180;
    const W = Math.round(r.width * Math.cos(rad) + r.height * Math.sin(rad));
    const H = Math.round(r.width * Math.sin(rad) + r.height * Math.cos(rad));
    // shift so the rotated image is centred in the expanded canvas
    const m = M.data64F as Float64Array;
    m[2] += W / 2 - r.width / 2;
    m[5] += H / 2 - r.height / 2;
    const dst = t(new cv.Mat());
    cv.warpAffine(src, dst, M, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    return { width: W, height: H, data: new Uint8Array(dst.data) };
  });
}

// Card recognition pipeline: decode -> card boundary -> orientation -> text detection (2 passes)
// -> recognition with two independent models -> disagreement resolution -> QR codes.
import jsQRModule from 'jsqr';
// jsqr is CommonJS; under Node ESM the default import is the function itself.
const jsQR = jsQRModule as unknown as typeof import('jsqr').default;
import { decodeImage, detectCard, rectify, resizeRaster, rotateRaster, rotateByAngle, enhanceContrast, downscaleRaster } from './image.ts';
import { PaddleOcr, cropQuad, type Quad, type RecResult, type DetBox } from './paddle.ts';
import type { Raster } from './cv.ts';
import { resolveModels } from './models.ts';
import { chooseReading, cleanText, foldReading, type Reading } from './consensus.ts';

import { ENGINE_VERSION } from './version.ts';
export { ENGINE_VERSION };

export type { Reading };

export interface OcrLine {
  id: string;
  text: string;
  confidence: number;
  /** Axis-aligned bounds in card-image pixels. */
  box: { x: number; y: number; w: number; h: number };
  quad: Quad;
  readings: Reading[];
  /** True when independent readings disagreed and no majority emerged. */
  disputed: boolean;
}

export interface OcrPage {
  engine: string;
  width: number;
  height: number;
  card: { detected: boolean; method: string; quad: Quad | null; rotation: number; sourceWidth: number; sourceHeight: number; scale: number };
  lines: OcrLine[];
  qr: string[];
  timingsMs: Record<string, number>;
  notes: string[];
}

export interface RecognizeOutput {
  page: OcrPage;
  /** The upright, perspective-corrected card image used for extraction. */
  cardImage: Raster;
}

let enginePromise: Promise<{ primary: PaddleOcr; secondary: PaddleOcr | null }> | undefined;

export function loadEngine() {
  enginePromise ??= (async () => {
    const m = resolveModels();
    const primary = await PaddleOcr.load(m.primary, 'ppocrv5-mobile');
    const secondary = m.secondary ? await PaddleOcr.load(m.secondary, 'en-ppocrv4') : null;
    return { primary, secondary };
  })();
  enginePromise.catch(() => (enginePromise = undefined));
  return enginePromise;
}

function boundsOf(q: Quad) {
  const xs = q.map((p) => p[0]),
    ys = q.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function quadSize(q: Quad) {
  const w = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
  const h = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
  return { w, h };
}

function overlapRatio(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

/** Split a recognized line where the characters have a wide horizontal gap (separate columns). */
function splitAtGaps(rec: RecResult, cropWidth: number, cropHeight: number): [number, number][] {
  const chars = rec.chars;
  const spans: [number, number][] = [];
  let start = 0;
  for (let i = 1; i < chars.length; i++) {
    if (chars[i].ch === ' ') continue;
    let j = i - 1;
    while (j >= 0 && chars[j].ch === ' ') j--;
    if (j < 0 || j === i - 1) continue; // no space between: never split inside a word
    const gapPx = (chars[i].pos - chars[j].pos) * cropWidth;
    if (gapPx > cropHeight * 2.2) {
      spans.push([start, j]);
      start = i;
    }
  }
  if (!spans.length) return [];
  spans.push([start, chars.length - 1]);
  return spans;
}

function pointInQuad(q: Quad, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i],
      [xj, yj] = q[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function subQuad(q: Quad, f0: number, f1: number): Quad {
  const lerp = (a: [number, number], b: [number, number], f: number): [number, number] => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  return [lerp(q[0], q[1], f0), lerp(q[0], q[1], f1), lerp(q[3], q[2], f1), lerp(q[3], q[2], f0)];
}

/**
 * Dominant reading direction of detected text boxes, in degrees (-90..90], weighted by box length.
 * Returns null when there is too little text to tell.
 */
function dominantTextAngle(boxes: DetBox[]): number | null {
  const items: { a: number; w: number }[] = [];
  for (const b of boxes) {
    const q = b.quad;
    const e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
    const e2 = [q[3][0] - q[0][0], q[3][1] - q[0][1]];
    const l1 = Math.hypot(e1[0], e1[1]),
      l2 = Math.hypot(e2[0], e2[1]);
    const [v, len, other] = l1 >= l2 ? [e1, l1, l2] : [e2, l2, l1];
    if (len < other * 2.5 || len < 40) continue; // only clearly elongated text lines
    let a = (Math.atan2(v[1], v[0]) * 180) / Math.PI;
    if (a > 90) a -= 180;
    if (a <= -90) a += 180;
    items.push({ a, w: len });
  }
  if (items.length < 2) return null;
  items.sort((x, y) => x.a - y.a);
  const total = items.reduce((s, i) => s + i.w, 0);
  let acc = 0;
  for (const i of items) {
    acc += i.w;
    if (acc >= total / 2) return i.a;
  }
  return null;
}

function decodeQr(img: Raster): string | null {
  const rgba = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0, j = 0; i < img.data.length; i += 3, j += 4) {
    rgba[j] = img.data[i];
    rgba[j + 1] = img.data[i + 1];
    rgba[j + 2] = img.data[i + 2];
    rgba[j + 3] = 255;
  }
  const res = jsQR(rgba, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return res?.data ?? null;
}

interface Region {
  card: Raster;
  rotation: number;
  scale: number;
  lines: OcrLine[];
}

/** Count of lines that look like contact details (used to choose between two readings of a photo). */
function contactEvidence(lines: OcrLine[]): number {
  let n = 0;
  for (const l of lines) {
    if (/@/.test(l.text)) n += 2;
    if ((l.text.match(/\d/g) ?? []).length >= 7) n += 1;
    if (/www\.|\.(com|net|org|io|co)\b/i.test(l.text)) n += 1;
  }
  return n;
}

async function readRegion(
  input: Raster,
  opts: { rotation?: number },
  notes: string[],
  lap: (k: string) => void,
  primary: PaddleOcr,
  secondary: PaddleOcr | null,
): Promise<Region> {
  let card = input;
  // 2. Working resolution: enough pixels for small print, bounded for speed.
  const long = Math.max(card.width, card.height);
  // scale = working-image pixels per photo pixel (used to judge how small the printed text was in the photo)
  let scale = 1;
  if (long < 1500) {
    scale = 1800 / long;
    card = await resizeRaster(card, Math.round(card.width * scale), Math.round(card.height * scale));
  } else if (long > 2600) {
    scale = 2400 / long;
    card = await resizeRaster(card, Math.round(card.width * scale), Math.round(card.height * scale));
  }

  // 3. Orientation (sideways / upside-down)
  let rotation = (((opts.rotation ?? 0) % 4) + 4) % 4;
  if (rotation) card = await rotateRaster(card, rotation);
  if (opts.rotation === undefined) {
    let probe = await primary.detect(card, { maxSide: 1280 });
    let tall = 0,
      wide = 0;
    for (const b of probe) {
      const { w, h } = quadSize(b.quad);
      if (h > w * 1.3) tall += w * h;
      else if (w > h * 1.3) wide += w * h;
    }
    // Text at an arbitrary angle (tilted card, or card outline not found): straighten it first.
    const skew = dominantTextAngle(probe);
    if (skew !== null && Math.abs(skew) > 4) {
      card = await rotateByAngle(card, skew);
      notes.push(`Straightened text tilted by ${Math.round(skew)}°.`);
      probe = await primary.detect(card, { maxSide: 1280 });
      tall = 0;
      wide = 0;
      for (const b of probe) {
        const { w, h } = quadSize(b.quad);
        if (h > w * 1.3) tall += w * h;
        else if (w > h * 1.3) wide += w * h;
      }
    }
    if (tall > wide * 1.2 && tall > 0) {
      card = await rotateRaster(card, 1);
      rotation = 1;
      probe = await primary.detect(card, { maxSide: 1280 });
    }
    const sample = probe
      .map((b) => ({ b, ...quadSize(b.quad) }))
      .filter((x) => x.w > x.h * 1.5)
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, 12);
    if (sample.length) {
      const crops = await Promise.all(sample.map((s) => cropQuad(card, s.b.quad)));
      const up = await primary.upsideDown(crops);
      const meanUp = up.reduce((a, b) => a + b, 0) / up.length;
      if (meanUp > 0.35) {
        // Confirm with recognition confidence in both orientations.
        const flipped = await Promise.all(crops.map((c) => rotateRaster(c, 2)));
        const [a, b] = await Promise.all([primary.recognize(crops), primary.recognize(flipped)]);
        const avg = (rs: RecResult[]) =>
          rs.reduce((s, r) => s + r.confidence * Math.max(1, r.text.length), 0) / rs.reduce((s, r) => s + Math.max(1, r.text.length), 0);
        if (avg(b) > avg(a)) {
          card = await rotateRaster(card, 2);
          rotation = (rotation + 2) % 4;
        }
      }
    }
  }
  if (rotation) notes.push(`Rotated ${rotation * 90}° to read the text upright.`);
  lap('orientation');

  // 4. Text detection: normal pass + contrast-enhanced pass for faint/coloured text.
  const maxSide = Math.min(2048, Math.max(card.width, card.height));
  const boxes: DetBox[] = await primary.detect(card, { maxSide });
  const enhanced = await enhanceContrast(card);
  const extra = await primary.detect(enhanced, { maxSide, thresh: 0.25, boxThresh: 0.42 });
  for (const e of extra) {
    const eb = boundsOf(e.quad);
    if (!boxes.some((b) => overlapRatio(boundsOf(b.quad), eb) > 0.3)) boxes.push(e);
  }
  // Ignore specks and anything implausibly large.
  const usable = boxes.filter((b) => {
    const { w, h } = quadSize(b.quad);
    return h >= 8 && w >= 8 && h < card.height * 0.5;
  });
  lap('detect');

  // 5. Recognition (primary), then split lines that span separate columns.
  let crops = await Promise.all(usable.map((b) => cropQuad(card, b.quad)));
  let recs = await primary.recognize(crops);
  const quads: Quad[] = [];
  const finalCrops: Raster[] = [];
  const finalRecs: RecResult[] = [];
  const toResplit: { quad: Quad }[] = [];
  usable.forEach((b, i) => {
    const spans = splitAtGaps(recs[i], crops[i].width, crops[i].height);
    if (!spans.length) {
      quads.push(b.quad);
      finalCrops.push(crops[i]);
      finalRecs.push(recs[i]);
      return;
    }
    const chars = recs[i].chars;
    for (const [s, e] of spans) {
      const f0 = Math.max(0, chars[s].pos - 0.6 * (crops[i].height / crops[i].width));
      const f1 = Math.min(1, chars[e].pos + 0.6 * (crops[i].height / crops[i].width));
      toResplit.push({ quad: subQuad(b.quad, f0, f1) });
    }
  });
  if (toResplit.length) {
    const c2 = await Promise.all(toResplit.map((s) => cropQuad(card, s.quad)));
    const r2 = await primary.recognize(c2);
    toResplit.forEach((s, i) => {
      quads.push(s.quad);
      finalCrops.push(c2[i]);
      finalRecs.push(r2[i]);
    });
    notes.push(`Separated ${toResplit.length} text segments that shared a row.`);
  }
  crops = finalCrops;
  recs = finalRecs;
  lap('recognize');

  // 6. Independent second reading (different model); a third reading only when they disagree.
  const readings: Reading[][] = recs.map((r) => [{ text: r.text, confidence: r.confidence, source: primary.name }]);
  if (secondary) {
    const r2 = await secondary.recognize(crops);
    r2.forEach((r, i) => readings[i].push({ text: r.text, confidence: r.confidence, source: secondary.name }));
    const disagree = readings.map((rs, i) => (foldReading(rs[0].text) !== foldReading(rs[1].text) ? i : -1)).filter((i) => i >= 0);
    if (disagree.length) {
      // Third reading: larger margin + upscaled crop with the primary model.
      const c3 = await Promise.all(
        disagree.map(async (i) => {
          const c = await cropQuad(card, quads[i], Math.round(quadSize(quads[i]).h * 0.15));
          return resizeRaster(c, Math.round(c.width * 1.5), Math.round(c.height * 1.5));
        }),
      );
      const r3 = await primary.recognize(c3);
      disagree.forEach((i, k) => readings[i].push({ text: r3[k].text, confidence: r3[k].confidence, source: primary.name + '-upscaled' }));
    }
  }
  lap('verify');

  const lines: OcrLine[] = [];
  readings.forEach((rs, i) => {
    const c = chooseReading(rs, primary.name);
    if (!c.text) return;
    if (c.text.replace(/\s/g, '').length === 1 && c.confidence < 0.8) return; // isolated specks
    lines.push({
      id: '',
      text: c.text,
      confidence: Number(c.confidence.toFixed(4)),
      box: boundsOf(quads[i]),
      quad: quads[i],
      readings: rs.map((r) => ({ ...r, text: cleanText(r.text), confidence: Number(r.confidence.toFixed(4)) })),
      disputed: c.disputed,
    });
  });

  // Reading order: top-to-bottom by row, then left-to-right.
  lines.sort((a, b) => {
    const ay = a.box.y + a.box.h / 2,
      by = b.box.y + b.box.h / 2;
    if (Math.abs(ay - by) < Math.min(a.box.h, b.box.h) * 0.5) return a.box.x - b.box.x;
    return ay - by;
  });
  lines.forEach((l, i) => (l.id = `l${i}`));
  return { card, rotation, scale, lines };
}

export async function recognizeCard(buffer: Uint8Array, opts: { skipCardDetection?: boolean; rotation?: number } = {}): Promise<RecognizeOutput> {
  const timings: Record<string, number> = {};
  const notes: string[] = [];
  let t0 = Date.now();
  const lap = (k: string) => {
    timings[k] = Date.now() - t0;
    t0 = Date.now();
  };
  const { primary, secondary } = await loadEngine();
  lap('load');

  const { raster: src } = await decodeImage(buffer);
  lap('decode');

  // 1. Card boundary
  let det: Awaited<ReturnType<typeof detectCard>> = { quad: null, method: 'skipped', score: 0 };
  let region: Region;
  if (!opts.skipCardDetection) {
    det = await detectCard(src);
    if (det.quad) {
      const rect = await rectify(src, det.quad);
      lap('card');
      // If much of the photo's text lies outside the outline, the outline may be wrong (a logo frame inside the card,
      // or a card running off the photo) -- or the outside text is just clutter (keyboard, papers). Read both ways
      // and keep the reading with more contact details; ties keep the card outline.
      const small = await downscaleRaster(src, 1280);
      const sx = small.width / src.width;
      const all = await primary.detect(small, { maxSide: 1280 });
      const q = det.quad.map(([x, y]) => [x * sx, y * sx]) as Quad;
      let inside = 0,
        outside = 0;
      for (const b of all) {
        const { w, h } = quadSize(b.quad);
        const cx = b.quad.reduce((a, p) => a + p[0], 0) / 4,
          cy = b.quad.reduce((a, p) => a + p[1], 0) / 4;
        if (pointInQuad(q, cx, cy)) inside += w * h;
        else outside += w * h;
      }
      region = await readRegion(rect, opts, notes, lap, primary, secondary);
      // Only when the card crop yielded almost no contact details (e.g. we framed a logo, or the card runs off the
      // photo) is the whole photo read as well; ordinary background clutter never triggers a second pass.
      if (outside > 0.35 * (inside + outside) && contactEvidence(region.lines) < 2) {
        const whole = await readRegion(src, opts, [], lap, primary, secondary);
        if (contactEvidence(whole.lines) >= contactEvidence(region.lines) + 2) {
          region = whole;
          det = { quad: null, method: `${det.method}-rejected`, score: det.score };
          notes.push('The card outline looked incomplete, so the whole photo was read.');
        }
      }
    } else {
      notes.push('Card edges not found; the whole photo was read.');
      lap('card');
      region = await readRegion(src, opts, notes, lap, primary, secondary);
    }
  } else region = await readRegion(src, opts, notes, lap, primary, secondary);
  const { card, rotation, scale, lines } = region;

  // 7. QR codes (vCard / LinkedIn links) from the card and from the full photo.
  const qr = new Set<string>();
  for (const img of [card, await downscaleRaster(src, 1600)]) {
    try {
      const v = decodeQr(img);
      if (v) qr.add(v);
    } catch {
      /* ignore undecodable */
    }
  }
  lap('qr');

  return {
    page: {
      engine: `${ENGINE_VERSION} (${primary.name}${secondary ? ' + ' + secondary.name : ''})`,
      width: card.width,
      height: card.height,
      card: {
        detected: !!det.quad,
        method: det.method,
        quad: det.quad,
        rotation,
        sourceWidth: src.width,
        sourceHeight: src.height,
        scale: Number(scale.toFixed(4)),
      },
      lines,
      qr: [...qr],
      timingsMs: timings,
      notes,
    },
    cardImage: card,
  };
}

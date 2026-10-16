// Card images on disk + recognition results in the database.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { CardImage, CardSide } from '../shared/types.ts';
import { dataDir, openDb } from './db.ts';
import { newId } from './contacts.ts';
import { sniffImageType } from './recognition/image.ts';
import type { OcrPage } from './recognition/engine.ts';
import { recognize } from './recognition/pool.ts';
import { ENGINE_VERSION } from './recognition/version.ts';

export const imagesDir = () => path.join(dataDir(), 'images');
const cardDir = (id: string) => path.join(imagesDir(), id.replace(/[^a-zA-Z0-9-]/g, ''));

const EXT: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', heic: 'heic' };
const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

interface CardRow {
  id: string;
  contact_id: string | null;
  side: string;
  original_name: string;
  original_mime: string;
  original_bytes: number;
  sha256: string;
  width: number;
  height: number;
  processed_width: number;
  processed_height: number;
  engine_version: string;
  ocr: string | null;
  processed_at: string | null;
  created_at: string;
}

function toCard(r: CardRow): CardImage {
  return {
    id: r.id,
    contactId: r.contact_id,
    side: r.side as CardSide,
    originalName: r.original_name,
    originalMime: r.original_mime,
    originalBytes: r.original_bytes,
    width: r.width,
    height: r.height,
    processedWidth: r.processed_width,
    processedHeight: r.processed_height,
    engineVersion: r.engine_version,
    processedAt: r.processed_at,
    createdAt: r.created_at,
  };
}

export function getCard(id: string): CardImage | null {
  const r = openDb().prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  return r ? toCard(r) : null;
}

export function getCardOcr(id: string): OcrPage | null {
  const r = openDb().prepare('SELECT ocr FROM cards WHERE id = ?').get(id) as { ocr: string | null } | undefined;
  return r?.ocr ? (JSON.parse(r.ocr) as OcrPage) : null;
}

/** Store an uploaded original exactly as received (no recompression). */
export async function storeOriginal(buf: Uint8Array, name: string, side: CardSide = 'front', id = newId()): Promise<CardImage> {
  const kind = sniffImageType(buf);
  if (!(kind in EXT)) throw Object.assign(new Error(`“${name}” is not a JPEG, PNG, WebP or HEIC image.`), { status: 415 });
  const dir = cardDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `original.${EXT[kind]}`), buf);
  let width = 0,
    height = 0;
  try {
    const m = await sharp(buf).metadata();
    const swap = (m.orientation ?? 1) >= 5;
    width = (swap ? m.height : m.width) ?? 0;
    height = (swap ? m.width : m.height) ?? 0;
  } catch {
    /* HEIC without a decoder, or a damaged file: recognition reports the specific problem */
  }
  const t = new Date().toISOString();
  openDb()
    .prepare(
      `INSERT INTO cards(id, side, original_name, original_mime, original_bytes, sha256, width, height, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, side, name.slice(0, 200), MIME[kind], buf.byteLength, createHash('sha256').update(buf).digest('hex'), width, height, t);
  return getCard(id)!;
}

export async function originalPath(id: string): Promise<string | null> {
  for (const ext of Object.values(EXT)) {
    const p = path.join(cardDir(id), `original.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

export const processedPath = (id: string) => path.join(cardDir(id), 'processed.jpg');
export const thumbPath = (id: string) => path.join(cardDir(id), 'thumb.jpg');

/** Run recognition for a stored card; saves the processed image, a thumbnail and the OCR result. */
export async function processCard(
  id: string,
  opts: { rotation?: number; skipCardDetection?: boolean; crop?: { x: number; y: number; w: number; h: number } } = {},
): Promise<OcrPage> {
  const p = await originalPath(id);
  if (!p) throw Object.assign(new Error('The original image for this card is missing.'), { code: 'missing_image' });
  let buf: Uint8Array = await readFile(p);
  if (opts.crop) {
    // Manual crop (fractions of the upright original). The original file itself is kept unchanged.
    const img = sharp(buf).rotate();
    const m = await img.metadata();
    const swap = (m.orientation ?? 1) >= 5;
    const W = (swap ? m.height : m.width) ?? 0,
      H = (swap ? m.width : m.height) ?? 0;
    const c = opts.crop;
    const left = Math.max(0, Math.round(c.x * W)),
      top = Math.max(0, Math.round(c.y * H));
    const width = Math.min(W - left, Math.round(c.w * W)),
      height = Math.min(H - top, Math.round(c.h * H));
    if (width < 50 || height < 30) throw Object.assign(new Error('The selected area is too small.'), { code: 'bad_crop' });
    buf = await img.extract({ left, top, width, height }).png().toBuffer();
  }
  const { page, jpeg } = await recognize(buf, { rotation: opts.rotation, skipCardDetection: opts.skipCardDetection || !!opts.crop });
  await writeFile(processedPath(id), jpeg);
  await sharp(jpeg).resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(thumbPath(id));
  openDb()
    .prepare('UPDATE cards SET ocr = ?, engine_version = ?, processed_at = ?, processed_width = ?, processed_height = ? WHERE id = ?')
    .run(JSON.stringify(page), ENGINE_VERSION, new Date().toISOString(), page.width, page.height, id);
  return page;
}

export function linkCard(cardId: string, contactId: string | null, side?: CardSide) {
  if (side) openDb().prepare('UPDATE cards SET contact_id = ?, side = ? WHERE id = ?').run(contactId, side, cardId);
  else openDb().prepare('UPDATE cards SET contact_id = ? WHERE id = ?').run(contactId, cardId);
}

export async function deleteCardFiles(id: string) {
  await rm(cardDir(id), { recursive: true, force: true });
  openDb().prepare('DELETE FROM cards WHERE id = ?').run(id);
}

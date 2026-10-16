// Versioned backup (.zip) and validated restore, plus import of backups from the earlier browser-only app.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Batch, Contact, MultiValue, TextField } from '../shared/types.ts';
import { openDb, tx, SCHEMA_VERSION } from './db.ts';
import { blankContact, findDuplicates, getContact, listContacts, newId, putContact } from './contacts.ts';
import { imagesDir, originalPath, processedPath, storeOriginal } from './cards.ts';
import { listBatches } from './batches.ts';
import { normalizeEmail, normalizePhone, normalizeWebsite } from './extraction/patterns.ts';

export const BACKUP_FORMAT = 'buz-cards-backup';
export const BACKUP_VERSION = 2;
const MAX_BACKUP_CONTACTS = 50_000;

interface Manifest {
  format: string;
  version: number;
  schema: number;
  createdAt: string;
  app: string;
  counts: { contacts: number; saved: number; drafts: number; cards: number; images: number };
  includes: string[];
}

export async function createBackup(opts: { includeImages?: boolean } = {}): Promise<Buffer> {
  const includeImages = opts.includeImages ?? true;
  const contacts = listContacts({ state: 'all' });
  const cards = openDb().prepare('SELECT * FROM cards').all() as Record<string, unknown>[];
  const batches: Batch[] = listBatches();
  const files: Record<string, Uint8Array> = {};
  let images = 0;
  if (includeImages) {
    for (const c of cards) {
      const id = String(c.id);
      const o = await originalPath(id);
      if (o) {
        files[`images/${id}/${path.basename(o)}`] = await readFile(o);
        images++;
      }
      if (existsSync(processedPath(id))) files[`images/${id}/processed.jpg`] = await readFile(processedPath(id));
    }
  }
  const manifest: Manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schema: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    app: 'Buz Cards',
    counts: {
      contacts: contacts.length,
      saved: contacts.filter((c) => c.state === 'saved').length,
      drafts: contacts.filter((c) => c.state === 'draft').length,
      cards: cards.length,
      images,
    },
    includes: [
      'contacts (saved + unreviewed drafts)',
      'card records with recognition results',
      'unfinished batch list',
      ...(includeImages ? ['original and processed card images'] : []),
    ],
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['contacts.json'] = strToU8(JSON.stringify(contacts));
  files['cards.json'] = strToU8(JSON.stringify(cards));
  files['batches.json'] = strToU8(JSON.stringify(batches));
  // Settings that hold API keys are deliberately NOT included.
  return Buffer.from(zipSync(files, { level: 0 })); // images are already compressed
}

export interface RestorePreview {
  token: string;
  kind: 'backup' | 'legacy';
  manifest: Partial<Manifest>;
  total: number;
  newContacts: number;
  sameIdIdentical: number;
  sameIdDifferent: number;
  possibleDuplicates: { incoming: string; existing: string; reasons: string[] }[];
  images: number;
  warnings: string[];
}

const pendingRestores = new Map<
  string,
  { contacts: Contact[]; cards: Record<string, unknown>[]; files: Record<string, Uint8Array>; createdAt: number; kind: 'backup' | 'legacy' }
>();

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validField(f: unknown): f is TextField {
  return isObj(f) && typeof f.value === 'string' && isObj(f.meta) && typeof f.meta.state === 'string';
}
function validMulti(vs: unknown): vs is MultiValue[] {
  return Array.isArray(vs) && vs.every((v) => isObj(v) && typeof v.value === 'string' && typeof v.id === 'string');
}

function validateContact(c: unknown, i: number): Contact {
  if (!isObj(c)) throw new Error(`Contact #${i + 1} is not an object.`);
  const bad = (what: string) => new Error(`Contact #${i + 1} (${typeof c.id === 'string' ? c.id : 'no id'}) has an invalid ${what}. Nothing was imported.`);
  if (typeof c.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(c.id)) throw bad('id');
  if (!['draft', 'saved', 'skipped'].includes(String(c.state))) throw bad('state');
  for (const k of ['name', 'company', 'title', 'address']) if (!validField(c[k])) throw bad(k);
  for (const k of ['emails', 'phones', 'websites']) if (!validMulti(c[k])) throw bad(k);
  if (!Array.isArray(c.tags) || !c.tags.every((t) => typeof t === 'string')) throw bad('tags');
  for (const k of ['createdAt', 'updatedAt']) if (typeof c[k] !== 'string' || !Number.isFinite(Date.parse(c[k] as string))) throw bad(k);
  const out = { ...blankContact(), ...(c as unknown as Contact) };
  out.credentials = validField(c.credentials) ? (c.credentials as TextField) : { value: '', meta: { state: 'not_found', source: 'import' } };
  return out;
}

/** Old browser-only app backups: { format: "buz-cards", version: 1, contacts: [{ name, email, phone, ... photos: [dataURL] }] } */
function convertLegacy(data: Record<string, unknown>): { contacts: Contact[]; photos: Map<string, string[]> } {
  if (!Array.isArray(data.contacts) || data.contacts.length > MAX_BACKUP_CONTACTS) throw new Error('This legacy backup has no contact list.');
  const photos = new Map<string, string[]>();
  const tf = (v: unknown): TextField => ({
    value: typeof v === 'string' ? v : '',
    meta: { state: typeof v === 'string' && v ? 'user_corrected' : 'not_found', source: 'import' },
  });
  const contacts = data.contacts.map((raw, i) => {
    if (!isObj(raw) || typeof raw.id !== 'string') throw new Error(`Legacy contact #${i + 1} is invalid. Nothing was imported.`);
    const mv = (v: unknown, label: string, norm: (s: string) => string): MultiValue[] =>
      typeof v === 'string' && v.trim()
        ? v
            .split(/[,;\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s, k) => ({ id: newId(), value: s, normalized: norm(s), label, primary: k === 0, meta: { state: 'user_corrected', source: 'import' } }))
        : [];
    const status = raw.status === 'follow-up' ? 'follow_up' : raw.status === 'connected' ? 'connected' : 'new';
    const id = /^[A-Za-z0-9-]{8,64}$/.test(raw.id) ? raw.id : randomUUID();
    if (Array.isArray(raw.photos))
      photos.set(
        id,
        raw.photos.filter((p): p is string => typeof p === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p)),
      );
    return blankContact({
      id,
      state: raw.isDemo ? 'skipped' : 'saved',
      status,
      name: tf(raw.name),
      company: tf(raw.company),
      title: tf(raw.title),
      address: tf(raw.address),
      emails: mv(raw.email, 'work', normalizeEmail),
      phones: mv(raw.phone, 'phone', normalizePhone),
      websites: mv(raw.website, 'website', normalizeWebsite),
      linkedin: {
        url: typeof raw.linkedin === 'string' ? raw.linkedin : '',
        meta: { state: raw.linkedin ? 'user_corrected' : 'not_found', source: 'import' },
        candidates: [],
      },
      event: typeof raw.event === 'string' ? raw.event : '',
      tags:
        typeof raw.tags === 'string'
          ? raw.tags
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      followUp: typeof raw.followUp === 'string' ? raw.followUp : '',
      ocrText: typeof raw.rawText === 'string' ? raw.rawText : '',
      createdAt: typeof raw.createdAt === 'string' && Date.parse(raw.createdAt) ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === 'string' && Date.parse(raw.updatedAt) ? raw.updatedAt : new Date().toISOString(),
      savedAt: new Date().toISOString(),
    });
  });
  return { contacts, photos };
}

export async function previewRestore(buf: Uint8Array): Promise<RestorePreview> {
  const warnings: string[] = [];
  let contacts: Contact[] = [];
  let cards: Record<string, unknown>[] = [];
  let files: Record<string, Uint8Array> = {};
  let manifest: Partial<Manifest> = {};
  let kind: 'backup' | 'legacy' = 'backup';
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (isZip) {
    try {
      files = unzipSync(buf);
    } catch {
      throw new Error('This file is not a readable .zip backup (it may be incomplete).');
    }
    if (!files['manifest.json'] || !files['contacts.json']) throw new Error('This .zip is not a Buz Cards backup (manifest.json or contacts.json missing).');
    manifest = JSON.parse(strFromU8(files['manifest.json']));
    if (manifest.format !== BACKUP_FORMAT) throw new Error('This .zip is not a Buz Cards backup.');
    if ((manifest.version ?? 0) > BACKUP_VERSION) throw new Error('This backup was made by a newer Buz Cards. Update the app first.');
    const raw = JSON.parse(strFromU8(files['contacts.json']));
    if (!Array.isArray(raw) || raw.length > MAX_BACKUP_CONTACTS) throw new Error('The backup contact list is invalid.');
    contacts = raw.map(validateContact);
    cards = files['cards.json'] ? JSON.parse(strFromU8(files['cards.json'])) : [];
    if (!Array.isArray(cards)) throw new Error('The backup card list is invalid.');
  } else {
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(buf));
    } catch {
      throw new Error('Choose a Buz Cards backup (.zip) or a backup from the earlier version (.json).');
    }
    if (!isObj(data) || data.format !== 'buz-cards') throw new Error('This JSON file is not a Buz Cards backup.');
    kind = 'legacy';
    const conv = convertLegacy(data);
    contacts = conv.contacts;
    // Legacy photos become card images.
    for (const [cid, list] of conv.photos) {
      list.forEach((dataUrl, k) => {
        const m = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
        if (!m) return;
        const cardId = newId();
        files[`legacy/${cid}/${k}/${cardId}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`] = Buffer.from(m[2], 'base64');
      });
    }
    manifest = {
      format: 'buz-cards (earlier version)',
      version: 1,
      counts: { contacts: contacts.length, saved: contacts.length, drafts: 0, cards: 0, images: Object.keys(files).length },
    };
    warnings.push('Backup from the earlier browser-only version: fields are imported as entered; there is no recognition evidence for them.');
  }
  const ids = new Set<string>();
  for (const c of contacts) {
    if (ids.has(c.id)) throw new Error(`The backup contains the contact id ${c.id} twice. Nothing was imported.`);
    ids.add(c.id);
  }
  let newContacts = 0,
    same = 0,
    diff = 0;
  const existingAll = listContacts({ state: 'all' });
  const dupes: RestorePreview['possibleDuplicates'] = [];
  for (const c of contacts) {
    const ex = getContact(c.id);
    if (!ex) {
      newContacts++;
      const d = findDuplicates(c, existingAll).filter((x) => x.strength === 'strong');
      if (d.length) dupes.push({ incoming: c.name.value || c.company.value || c.id, existing: d[0].name || d[0].company, reasons: d[0].reasons });
    } else if (JSON.stringify({ ...ex, revision: 0, updatedAt: '' }) === JSON.stringify({ ...c, revision: 0, updatedAt: '' })) same++;
    else diff++;
  }
  const token = randomUUID();
  pendingRestores.set(token, { contacts, cards, files, createdAt: Date.now(), kind });
  for (const [k, v] of pendingRestores) if (Date.now() - v.createdAt > 30 * 60_000) pendingRestores.delete(k);
  return {
    token,
    kind,
    manifest,
    total: contacts.length,
    newContacts,
    sameIdIdentical: same,
    sameIdDifferent: diff,
    possibleDuplicates: dupes.slice(0, 50),
    images: Object.keys(files).filter((f) => f.startsWith('images/') || f.startsWith('legacy/')).length,
    warnings,
  };
}

/**
 * Apply a previewed restore. Never deletes anything already in the app.
 * policy: 'skip' (keep existing on id clash, default) | 'overwrite' (replace clashing ids) | 'copy' (import clashes as new contacts)
 */
export async function applyRestore(token: string, policy: 'skip' | 'overwrite' | 'copy' = 'skip') {
  const p = pendingRestores.get(token);
  if (!p) throw new Error('This restore preview expired. Choose the backup file again.');
  let added = 0,
    replaced = 0,
    skipped = 0,
    copied = 0,
    images = 0;
  const cardIdMap = new Map<string, string>();
  // Images first (files), then all database rows in one transaction.
  if (p.kind === 'backup') {
    for (const card of p.cards) {
      const id = String(card.id ?? '');
      if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) continue;
      const exists = openDb().prepare('SELECT 1 FROM cards WHERE id = ?').get(id);
      if (exists && policy !== 'copy') {
        cardIdMap.set(id, id);
        continue;
      }
      const targetId = exists ? newId() : id;
      cardIdMap.set(id, targetId);
      const dir = path.join(imagesDir(), targetId);
      let wrote = false;
      for (const [name, data] of Object.entries(p.files)) {
        if (!name.startsWith(`images/${id}/`)) continue;
        const base = path.basename(name);
        if (!/^(original\.(jpg|png|webp|heic)|processed\.jpg)$/.test(base)) continue;
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, base), data);
        wrote = true;
      }
      if (wrote) images++;
      openDb()
        .prepare(
          `INSERT OR IGNORE INTO cards(id, contact_id, side, original_name, original_mime, original_bytes, sha256, width, height, processed_width, processed_height, engine_version, ocr, processed_at, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          targetId,
          (card.contact_id as string) ?? null,
          String(card.side ?? 'front'),
          String(card.original_name ?? ''),
          String(card.original_mime ?? ''),
          Number(card.original_bytes ?? 0),
          String(card.sha256 ?? ''),
          Number(card.width ?? 0),
          Number(card.height ?? 0),
          Number(card.processed_width ?? 0),
          Number(card.processed_height ?? 0),
          String(card.engine_version ?? ''),
          (card.ocr as string) ?? null,
          (card.processed_at as string) ?? null,
          String(card.created_at ?? new Date().toISOString()),
        );
    }
  }
  const legacyCards = new Map<string, string[]>();
  if (p.kind === 'legacy') {
    for (const [name, data] of Object.entries(p.files)) {
      const m = name.match(/^legacy\/([^/]+)\/\d+\//);
      if (!m) continue;
      const card = await storeOriginal(data, path.basename(name));
      legacyCards.set(m[1], [...(legacyCards.get(m[1]) ?? []), card.id]);
      images++;
    }
  }
  tx(() => {
    for (const c of p.contacts) {
      const existing = getContact(c.id);
      let incoming: Contact = { ...c, cardIds: c.cardIds.map((id) => cardIdMap.get(id) ?? id) };
      if (p.kind === 'legacy') incoming.cardIds = legacyCards.get(c.id) ?? [];
      if (existing) {
        if (policy === 'skip') {
          skipped++;
          continue;
        }
        if (policy === 'copy') {
          incoming = { ...incoming, id: newId(), mergedFrom: [] };
          copied++;
        } else replaced++;
        putContact(incoming);
      } else {
        putContact(incoming);
        added++;
      }
      for (const cid of incoming.cardIds) openDb().prepare('UPDATE cards SET contact_id = ? WHERE id = ?').run(incoming.id, cid);
    }
  });
  pendingRestores.delete(token);
  return { added, replaced, skipped, copied, images };
}

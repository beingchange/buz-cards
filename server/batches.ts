// Batches and the processing queue. Work is persisted before it is acknowledged, so a refresh, a dropped
// connection or a server restart never loses uploaded images or drafts, and retries never duplicate contacts.
import type { Batch, BatchItem, BatchItemStatus, Contact } from '../shared/types.ts';
import { openDb, tx } from './db.ts';
import { applyExtraction, attentionList, blankContact, getContact, newId, putContact } from './contacts.ts';
import { deleteCardFiles, linkCard, processCard, storeOriginal } from './cards.ts';
import { extractFields } from './extraction/fields.ts';
import { RecognitionError } from './recognition/pool.ts';

export const LIMITS = {
  maxFiles: Number(process.env.BUZ_MAX_FILES ?? 25),
  maxFileBytes: Number(process.env.BUZ_MAX_FILE_MB ?? 25) * 1024 * 1024,
  maxBatchBytes: Number(process.env.BUZ_MAX_BATCH_MB ?? 150) * 1024 * 1024,
};

const now = () => new Date().toISOString();

interface BatchRow {
  id: string;
  kind: string;
  label: string;
  event: string;
  tags: string;
  paused: number;
  discarded_at: string | null;
  created_at: string;
}
interface ItemRow {
  id: string;
  batch_id: string;
  client_key: string;
  position: number;
  card_id: string;
  contact_id: string | null;
  file_name: string;
  status: string;
  error: string | null;
  attempts: number;
  duration_ms: number | null;
  updated_at: string;
}

const toItem = (r: ItemRow): BatchItem & { clientKey: string } => ({
  id: r.id,
  batchId: r.batch_id,
  clientKey: r.client_key,
  position: r.position,
  cardId: r.card_id,
  contactId: r.contact_id,
  fileName: r.file_name,
  status: r.status as BatchItemStatus,
  error: r.error,
  attempts: r.attempts,
  durationMs: r.duration_ms,
  updatedAt: r.updated_at,
});

export function getBatch(id: string): Batch | null {
  const d = openDb();
  const b = d.prepare('SELECT * FROM batches WHERE id = ?').get(id) as BatchRow | undefined;
  if (!b) return null;
  const items = (d.prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY position').all(id) as unknown as ItemRow[]).map(toItem);
  return {
    id: b.id,
    kind: b.kind as Batch['kind'],
    label: b.label,
    event: b.event,
    tags: JSON.parse(b.tags),
    paused: !!b.paused,
    discardedAt: b.discarded_at,
    createdAt: b.created_at,
    items,
  };
}

export function listBatches(opts: { active?: boolean } = {}): Batch[] {
  const rows = openDb().prepare('SELECT id FROM batches WHERE discarded_at IS NULL ORDER BY created_at DESC LIMIT 50').all() as { id: string }[];
  const batches = rows.map((r) => getBatch(r.id)!).filter(Boolean);
  if (!opts.active) return batches;
  // "Active" = has anything not yet saved/skipped.
  return batches.filter((b) => b.items.some((i) => !['saved', 'skipped'].includes(i.status)));
}

export function createBatch(input: { label?: string; event?: string; tags?: string[]; kind?: 'batch' | 'single' }): Batch {
  const id = newId();
  openDb()
    .prepare('INSERT INTO batches(id, kind, label, event, tags, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(
      id,
      input.kind ?? 'batch',
      (input.label ?? '').slice(0, 120),
      (input.event ?? '').slice(0, 200),
      JSON.stringify((input.tags ?? []).slice(0, 30)),
      now(),
    );
  return getBatch(id)!;
}

export function updateBatch(id: string, patch: { label?: string; event?: string; tags?: string[]; paused?: boolean }) {
  const b = getBatch(id);
  if (!b) return null;
  openDb()
    .prepare('UPDATE batches SET label = ?, event = ?, tags = ?, paused = ? WHERE id = ?')
    .run(patch.label ?? b.label, patch.event ?? b.event, JSON.stringify(patch.tags ?? b.tags), (patch.paused ?? b.paused) ? 1 : 0, id);
  if (patch.paused === false) kick();
  return getBatch(id);
}

export class LimitError extends Error {
  status = 413;
}

/**
 * Add one uploaded image to a batch. Idempotent per (batch, clientKey): re-sending the same file after a
 * dropped connection returns the existing item instead of creating a duplicate.
 */
export async function addItem(batchId: string, clientKey: string, fileName: string, buf: Uint8Array, position: number) {
  const d = openDb();
  const existing = d.prepare('SELECT * FROM batch_items WHERE batch_id = ? AND client_key = ?').get(batchId, clientKey) as ItemRow | undefined;
  if (existing) return toItem(existing);
  const b = getBatch(batchId);
  if (!b || b.discardedAt) throw Object.assign(new Error('This batch no longer exists.'), { status: 404 });
  if (b.items.length >= LIMITS.maxFiles) throw new LimitError(`A batch holds at most ${LIMITS.maxFiles} images. Start another batch for the rest.`);
  if (buf.byteLength > LIMITS.maxFileBytes) throw new LimitError(`“${fileName}” is larger than ${LIMITS.maxFileBytes / 1024 / 1024} MB.`);
  const used = (
    d.prepare('SELECT COALESCE(SUM(c.original_bytes),0) AS n FROM batch_items i JOIN cards c ON c.id = i.card_id WHERE i.batch_id = ?').get(batchId) as {
      n: number;
    }
  ).n;
  if (used + buf.byteLength > LIMITS.maxBatchBytes)
    throw new LimitError(`This batch would exceed ${LIMITS.maxBatchBytes / 1024 / 1024} MB in total. Start another batch for the rest.`);

  const itemId = newId();
  let cardId = '';
  let status: BatchItemStatus = 'queued';
  let error: string | null = null;
  try {
    cardId = (await storeOriginal(buf, fileName)).id;
  } catch (e) {
    status = 'failed';
    error = (e as Error).message;
  }
  const contactId = status === 'queued' ? newId() : null;
  try {
    d.prepare(
      `INSERT INTO batch_items(id, batch_id, client_key, position, card_id, contact_id, file_name, status, error, attempts, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(itemId, batchId, clientKey, position, cardId, contactId, fileName.slice(0, 200), status, error, now());
  } catch (e) {
    // Two identical requests raced: keep the first.
    if (cardId) await deleteCardFiles(cardId);
    const again = d.prepare('SELECT * FROM batch_items WHERE batch_id = ? AND client_key = ?').get(batchId, clientKey) as ItemRow | undefined;
    if (again) return toItem(again);
    throw e;
  }
  kick();
  return toItem(d.prepare('SELECT * FROM batch_items WHERE id = ?').get(itemId) as unknown as ItemRow);
}

function setItem(
  id: string,
  patch: Partial<{ status: BatchItemStatus; error: string | null; attempts: number; duration_ms: number; contact_id: string | null }>,
) {
  const sets = Object.keys(patch).map((k) => `${k} = ?`);
  openDb()
    .prepare(`UPDATE batch_items SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...(Object.values(patch) as (string | number | null)[]), now(), id);
}

// ---------- processing loop ----------

let running = false;
let currentItem: string | null = null;
const listeners = new Set<() => void>();

export function onQueueChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => listeners.forEach((f) => f());

export function queueState() {
  const d = openDb();
  const queued = (
    d.prepare("SELECT COUNT(*) AS n FROM batch_items i JOIN batches b ON b.id = i.batch_id WHERE i.status = 'queued' AND b.discarded_at IS NULL").get() as {
      n: number;
    }
  ).n;
  return { running, currentItem, queued };
}

/** On startup: anything that was mid-processing when the server stopped goes back to the queue. */
export function recoverInterrupted() {
  openDb().prepare("UPDATE batch_items SET status = 'queued', updated_at = ? WHERE status = 'processing'").run(now());
}

export function kick() {
  if (running) return;
  running = true;
  void loop().finally(() => {
    running = false;
    currentItem = null;
    notify();
  });
}

async function loop() {
  for (;;) {
    const next = openDb()
      .prepare(
        `SELECT i.* FROM batch_items i JOIN batches b ON b.id = i.batch_id
         WHERE i.status = 'queued' AND b.discarded_at IS NULL AND b.paused = 0
         ORDER BY b.created_at, i.position LIMIT 1`,
      )
      .get() as ItemRow | undefined;
    if (!next) return;
    currentItem = next.id;
    setItem(next.id, { status: 'processing', attempts: next.attempts + 1 });
    notify();
    const started = Date.now();
    try {
      await processItem(toItem(next));
    } catch (e) {
      const err = e as Error;
      const friendly =
        err instanceof RecognitionError ? err.message : `Processing failed: ${err.message}. Use Retry; if it keeps failing, try another photo of this card.`;
      setItem(next.id, { status: 'failed', error: friendly, duration_ms: Date.now() - started });
    }
    notify();
  }
}

async function processItem(item: BatchItem) {
  const started = Date.now();
  const batch = getBatch(item.batchId)!;
  const page = await processCard(item.cardId);
  const ex = extractFields({ lines: page.lines, qr: page.qr, width: page.width, height: page.height, scale: page.card.scale });
  const ocrText = page.lines.map((l) => l.text).join('\n');
  // The contact id was assigned at upload time, so re-processing updates the same draft (never a duplicate).
  const contactId = item.contactId ?? newId();
  const existing = getContact(contactId);
  if (existing && existing.state === 'saved') {
    // Saved contacts are only changed by an explicit user action.
    setItem(item.id, { status: 'saved', error: null, duration_ms: Date.now() - started });
    return;
  }
  const base: Contact = existing ?? blankContact({ id: contactId, batchId: item.batchId, event: batch.event, tags: [...batch.tags], cardIds: [item.cardId] });
  const next = applyExtraction(base, ex, ocrText);
  if (!next.cardIds.includes(item.cardId)) next.cardIds = [item.cardId, ...next.cardIds];
  putContact(next);
  linkCard(item.cardId, contactId, 'front');
  const attention = attentionList(next);
  setItem(item.id, { status: attention.length ? 'needs_attention' : 'ready', error: null, contact_id: contactId, duration_ms: Date.now() - started });
}

// ---------- user actions ----------

export function retryItem(batchId: string, itemId: string) {
  const r = openDb().prepare('SELECT * FROM batch_items WHERE id = ? AND batch_id = ?').get(itemId, batchId) as ItemRow | undefined;
  if (!r) return null;
  if (!r.card_id) throw Object.assign(new Error('This file could not be stored, so it cannot be retried. Upload it again.'), { status: 409 });
  if (r.status === 'saved') throw Object.assign(new Error('This card is already saved as a contact. Use “Re-read” on the contact instead.'), { status: 409 });
  setItem(itemId, { status: 'queued', error: null, contact_id: r.contact_id ?? newId() });
  kick();
  return getBatch(batchId);
}

/** Re-read every unsaved draft in the batch with the current engine. User corrections are preserved. */
export function rereadBatch(batchId: string) {
  const b = getBatch(batchId);
  if (!b) return null;
  for (const i of b.items) if (['ready', 'needs_attention', 'failed'].includes(i.status) && i.cardId) setItem(i.id, { status: 'queued', error: null });
  kick();
  return getBatch(batchId);
}

export function markItemByContact(contactId: string, status: BatchItemStatus) {
  openDb().prepare('UPDATE batch_items SET status = ?, updated_at = ? WHERE contact_id = ?').run(status, now(), contactId);
}

/** Discard unsaved work in a batch. Contacts already saved from it are kept. */
export async function discardBatch(batchId: string) {
  const b = getBatch(batchId);
  if (!b) return null;
  const toDeleteCards: string[] = [];
  tx(() => {
    const d = openDb();
    for (const i of b.items) {
      if (i.status === 'saved') continue;
      if (i.contactId) {
        const c = getContact(i.contactId);
        if (c && c.state !== 'saved') d.prepare('DELETE FROM contacts WHERE id = ?').run(i.contactId);
        else if (c?.state === 'saved') continue;
      }
      if (i.cardId) toDeleteCards.push(i.cardId);
    }
    d.prepare('UPDATE batches SET discarded_at = ? WHERE id = ?').run(now(), batchId);
  });
  for (const id of toDeleteCards) await deleteCardFiles(id);
  return { discardedCards: toDeleteCards.length, keptSaved: b.items.filter((i) => i.status === 'saved').length };
}

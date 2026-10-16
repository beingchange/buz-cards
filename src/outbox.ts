// Upload outbox: photos chosen on the phone are written to IndexedDB first, then uploaded one at a time.
// A refresh, a dropped Wi-Fi connection or a locked phone does not lose them: uploading resumes when the
// page is open again and the computer is reachable. Each file has a stable key, so a retried upload never
// creates a second copy on the server.
import { openDB, type IDBPDatabase } from 'idb';
import { randomId } from './util';

export interface OutboxBatch {
  localId: string;
  serverId: string | null;
  kind: 'batch' | 'single';
  label: string;
  event: string;
  tags: string[];
  createdAt: number;
}
export interface OutboxFile {
  key: string;
  localBatchId: string;
  position: number;
  name: string;
  size: number;
  blob: Blob | null;
  state: 'pending' | 'uploading' | 'uploaded' | 'rejected';
  error: string | null;
  itemId: string | null;
}

let dbp: Promise<IDBPDatabase> | null = null;
let memory: { batches: Map<string, OutboxBatch>; files: Map<string, OutboxFile> } | null = null;
export let persistent = true;

async function db(): Promise<IDBPDatabase | null> {
  if (memory) return null;
  try {
    dbp ??= openDB('buz-outbox', 1, {
      upgrade(d) {
        d.createObjectStore('batches', { keyPath: 'localId' });
        const f = d.createObjectStore('files', { keyPath: 'key' });
        f.createIndex('batch', 'localBatchId');
      },
    });
    return await dbp;
  } catch {
    // Private browsing or storage disabled: keep working in memory (not refresh-proof).
    persistent = false;
    memory = { batches: new Map(), files: new Map() };
    return null;
  }
}

async function putBatch(b: OutboxBatch) {
  const d = await db();
  if (d) await d.put('batches', b);
  else memory!.batches.set(b.localId, b);
}
async function putFile(f: OutboxFile) {
  const d = await db();
  if (d) await d.put('files', f);
  else memory!.files.set(f.key, f);
}
export async function allBatches(): Promise<OutboxBatch[]> {
  const d = await db();
  return d ? ((await d.getAll('batches')) as OutboxBatch[]) : [...memory!.batches.values()];
}
export async function filesOf(localId: string): Promise<OutboxFile[]> {
  const d = await db();
  const list = d
    ? ((await d.getAllFromIndex('files', 'batch', localId)) as OutboxFile[])
    : [...memory!.files.values()].filter((f) => f.localBatchId === localId);
  return list.sort((a, b) => a.position - b.position);
}

const listeners = new Set<() => void>();
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const emit = () => listeners.forEach((f) => f());

export async function queueBatch(
  meta: { kind: 'batch' | 'single'; label: string; event: string; tags: string[]; serverId?: string },
  files: File[],
): Promise<OutboxBatch> {
  const b: OutboxBatch = {
    localId: randomId(),
    serverId: meta.serverId ?? null,
    kind: meta.kind,
    label: meta.label,
    event: meta.event,
    tags: meta.tags,
    createdAt: Date.now(),
  };
  await putBatch(b);
  let i = 0;
  for (const file of files) {
    i++;
    // Store the original bytes untouched: no resizing or recompression in the browser.
    await putFile({
      key: `u${randomId()}`,
      localBatchId: b.localId,
      position: i,
      name: file.name || `photo-${i}.jpg`,
      size: file.size,
      blob: file,
      state: 'pending',
      error: null,
      itemId: null,
    });
  }
  emit();
  void pump();
  return b;
}

export interface OutboxStatus {
  total: number;
  uploaded: number;
  rejected: OutboxFile[];
  pending: number;
  serverId: string | null;
  lastError: string | null;
}
let lastError: string | null = null;

export async function status(localId: string): Promise<OutboxStatus> {
  const fs = await filesOf(localId);
  const b = (await allBatches()).find((x) => x.localId === localId);
  return {
    total: fs.length,
    uploaded: fs.filter((f) => f.state === 'uploaded').length,
    rejected: fs.filter((f) => f.state === 'rejected'),
    pending: fs.filter((f) => f.state === 'pending' || f.state === 'uploading').length,
    serverId: b?.serverId ?? null,
    lastError,
  };
}

export async function serverIdFor(localId: string) {
  return (await allBatches()).find((b) => b.localId === localId)?.serverId ?? null;
}

let pumping = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (const b of (await allBatches()).sort((x, y) => x.createdAt - y.createdAt)) {
      const files = (await filesOf(b.localId)).filter((f) => f.state === 'pending' || f.state === 'uploading');
      if (!files.length) continue;
      if (!b.serverId) {
        const res = await fetch('/api/batches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: b.label, event: b.event, tags: b.tags, kind: b.kind }),
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Could not start the batch (${res.status}).`);
        b.serverId = (await res.json()).batch.id;
        await putBatch(b);
        emit();
      }
      for (const f of files) {
        f.state = 'uploading';
        await putFile(f);
        emit();
        const res = await fetch(`/api/batches/${b.serverId}/items`, {
          method: 'POST',
          headers: {
            'X-Client-Key': f.key,
            'X-File-Name': encodeURIComponent(f.name),
            'X-Position': String(f.position),
            'Content-Type': 'application/octet-stream',
          },
          body: f.blob,
          credentials: 'same-origin',
        });
        if (res.ok) {
          const { item } = await res.json();
          f.state = item.status === 'failed' ? 'rejected' : 'uploaded';
          f.error = item.status === 'failed' ? item.error : null;
          f.itemId = item.id;
          f.blob = null; // the computer has it now; free phone storage
        } else if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 408 && res.status !== 429) {
          f.state = 'rejected';
          f.error = (await res.json().catch(() => ({}))).error ?? `Rejected (${res.status})`;
          f.blob = null;
        } else {
          f.state = 'pending';
          await putFile(f);
          throw new Error((await res.json().catch(() => ({}))).error ?? `Upload failed (${res.status}).`);
        }
        await putFile(f);
        lastError = null;
        emit();
      }
    }
  } catch (e) {
    lastError =
      e instanceof TypeError
        ? 'Waiting for the Buz Cards computer (not reachable). Photos are kept on this phone and will upload automatically.'
        : (e as Error).message;
    emit();
    retryTimer ??= setTimeout(() => {
      retryTimer = null;
      void pump();
    }, 8000);
  } finally {
    pumping = false;
  }
}

if (typeof window !== 'undefined') {
  // Resume anything left over from before a refresh / browser restart.
  setTimeout(() => void pump(), 500);
  window.addEventListener('online', () => void pump());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pump();
  });
}

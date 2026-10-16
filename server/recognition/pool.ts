// One recognition worker (cards are processed one at a time: bounded memory/CPU on a laptop).
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { OcrPage } from './engine.ts';

interface Pending {
  resolve: (v: { page: OcrPage; jpeg: Buffer }) => void;
  reject: (e: Error) => void;
}

export class RecognitionError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
let status: { state: 'loading' | 'ready' | 'error'; error?: string } = { state: 'loading' };
const TIMEOUT_MS = Number(process.env.BUZ_RECOGNITION_TIMEOUT_MS ?? 120_000);

function start() {
  worker = new Worker(path.join(import.meta.dirname, 'worker.ts'));
  worker.on('message', (m: { id?: number; ok?: boolean; page?: OcrPage; jpeg?: Uint8Array; error?: string; code?: string; warm?: boolean }) => {
    if (m.warm !== undefined) {
      status = m.warm ? { state: 'ready' } : { state: 'error', error: m.error };
      return;
    }
    const p = pending.get(m.id!);
    if (!p) return;
    pending.delete(m.id!);
    if (m.ok) p.resolve({ page: m.page!, jpeg: Buffer.from(m.jpeg!) });
    else p.reject(new RecognitionError(m.error ?? 'Recognition failed', m.code ?? 'processing_failed'));
  });
  worker.on('error', (e) => {
    status = { state: 'error', error: e.message };
    for (const p of pending.values()) p.reject(new RecognitionError(`The recognition worker crashed: ${e.message}`, 'worker_crashed'));
    pending.clear();
    worker = null;
  });
  worker.on('exit', () => {
    worker = null;
  });
  worker.postMessage({ warmup: true });
}

export function warmup() {
  if (!worker) start();
}

export function engineStatus() {
  return status;
}

export function recognize(buffer: Uint8Array, opts: { rotation?: number; skipCardDetection?: boolean } = {}): Promise<{ page: OcrPage; jpeg: Buffer }> {
  if (!worker) start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new RecognitionError('Reading this image took too long and was stopped. Try a smaller or sharper photo.', 'timeout'));
      // A stuck worker is replaced so the queue keeps moving.
      worker?.terminate();
      worker = null;
    }, TIMEOUT_MS);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    const copy = new Uint8Array(buffer); // transfer a copy; the caller keeps its buffer
    worker!.postMessage({ id, buffer: copy, opts }, [copy.buffer]);
  });
}

export async function shutdown() {
  await worker?.terminate();
  worker = null;
}

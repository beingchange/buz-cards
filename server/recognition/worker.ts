// Worker thread: runs recognition off the main thread so the API stays responsive while cards are read.
import { parentPort } from 'node:worker_threads';
import { recognizeCard, loadEngine } from './engine.ts';
import { encodeJpeg } from './image.ts';
import { ImageFormatError } from './image.ts';

interface Job {
  id: number;
  buffer: Uint8Array;
  opts: { rotation?: number; skipCardDetection?: boolean };
}

parentPort!.on('message', async (msg: Job | { warmup: true }) => {
  if ('warmup' in msg) {
    try {
      await loadEngine();
      parentPort!.postMessage({ warm: true });
    } catch (e) {
      parentPort!.postMessage({ warm: false, error: (e as Error).message });
    }
    return;
  }
  try {
    const { page, cardImage } = await recognizeCard(msg.buffer, msg.opts);
    const encoded = await encodeJpeg(cardImage, 92);
    const jpeg = new Uint8Array(encoded); // own copy: Node Buffers may sit in a shared pool and cannot be transferred
    parentPort!.postMessage({ id: msg.id, ok: true, page, jpeg }, [jpeg.buffer]);
  } catch (e) {
    const err = e as Error & { code?: string };
    parentPort!.postMessage({ id: msg.id, ok: false, error: err.message, code: err instanceof ImageFormatError ? err.code : 'processing_failed' });
  }
});

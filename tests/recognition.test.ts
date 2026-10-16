// Real recognition engine on fictional photo-style fixtures: HEIC decoding, EXIF rotation, upside-down cards.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { recognizeCard } from '../server/recognition/engine.ts';
import { extractFields } from '../server/extraction/fields.ts';
import { ImageFormatError, decodeImage } from '../server/recognition/image.ts';

const fx = (p: string) => new Uint8Array(readFileSync(path.resolve(import.meta.dirname, 'fixtures', p)));
async function read(p: string) {
  const { page } = await recognizeCard(fx(p));
  return { page, ex: extractFields({ lines: page.lines, qr: page.qr, width: page.width, height: page.height, scale: page.card.scale }) };
}

describe('recognition engine', () => {
  it('reads an iPhone-style HEIC photo, including its QR vCard', async () => {
    const { ex, page } = await read('heic/s08-qr.heic');
    expect(ex.emails.map((e) => e.value)).toContain('tomas@cobaltrobotics.co');
    expect(ex.linkedin.url).toBe('https://www.linkedin.com/in/tomas-herrera-cobalt');
    expect(page.qr.length).toBe(1);
  });
  it('applies EXIF orientation and turns upside-down cards', async () => {
    const a = await read('synthetic/photos/s04-dark.jpg');
    expect(a.ex.name.value).toBe("Sarah-Jane O'Connell");
    const b = await read('synthetic/photos/s09-caps.jpg');
    expect(b.page.card.rotation).toBe(2);
    expect(b.ex.emails[0].value).toBe('knguyen@summitridgecap.com');
  });
  it('rejects non-images with a specific message', async () => {
    await expect(decodeImage(new TextEncoder().encode('hello'))).rejects.toBeInstanceOf(ImageFormatError);
  });
});

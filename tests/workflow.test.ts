// End-to-end server workflow with the real recognition engine on public synthetic photos:
// upload (idempotent) -> queue -> extraction -> edit -> re-read keeps edits -> save -> Excel/vCard -> backup/restore.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { zipSync, strToU8 } from 'fflate';

process.env.BUZ_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'buz-test-'));
process.env.BUZ_MAX_FILES = '4';

const { createApp } = await import('../server/app.ts');
const { openDb } = await import('../server/db.ts');
const { recoverInterrupted, kick } = await import('../server/batches.ts');
const { shutdown } = await import('../server/recognition/pool.ts');
const { EXCEL_COLUMNS, excelRow } = await import('../server/exports.ts');

const PHOTOS = path.resolve(import.meta.dirname, 'fixtures/synthetic/photos');
let server: Server;
let base = '';

async function j<T = Record<string, unknown>>(p: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const r = await fetch(base + p, { ...init, headers, body });
  return { status: r.status, body: (await r.json()) as T };
}

function upload(batchId: string, file: string, key: string, pos: number) {
  return j<{ item: { id: string; status: string; error: string | null } }>(`/api/batches/${batchId}/items`, {
    method: 'POST',
    headers: { 'x-client-key': key, 'x-file-name': encodeURIComponent(path.basename(file)), 'x-position': String(pos) },
    body: readFileSync(file),
  });
}

async function waitIdle(batchId: string) {
  for (let i = 0; i < 240; i++) {
    const { body } = await j<{ batch: { items: { status: string }[] } }>(`/api/batches/${batchId}`);
    if (body.batch.items.every((x) => !['queued', 'processing'].includes(x.status))) return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('batch did not finish');
}

beforeAll(async () => {
  openDb();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.close();
  await shutdown();
});

describe('batch workflow', () => {
  let batchId = '';
  let contactIds: string[] = [];

  it('accepts uploads idempotently and rejects bad files with a specific reason', async () => {
    const b = await j<{ batch: { id: string } }>('/api/batches', { method: 'POST', json: { label: 'Test batch', event: 'Fixture Expo', tags: ['fixture'] } });
    batchId = b.body.batch.id;
    const a = await upload(batchId, path.join(PHOTOS, 's01-classic.jpg'), 'key-aaaaaa', 1);
    const again = await upload(batchId, path.join(PHOTOS, 's01-classic.jpg'), 'key-aaaaaa', 1);
    expect(again.body.item.id).toBe(a.body.item.id); // retry does not duplicate
    await upload(batchId, path.join(PHOTOS, 's03-redpanel.jpg'), 'key-bbbbbb', 2);
    const bad = await upload(batchId, path.resolve(import.meta.dirname, '../package.json'), 'key-cccccc', 3);
    expect(bad.body.item.status).toBe('failed');
    expect(bad.body.item.error).toMatch(/not a JPEG, PNG, WebP or HEIC/);
    await upload(batchId, path.join(PHOTOS, 's11-tricky-email.jpg'), 'key-dddddd', 4);
    const over = await upload(batchId, path.join(PHOTOS, 's02-columns.jpg'), 'key-eeeeee', 5);
    expect(over.status).toBe(413);
    expect(JSON.stringify(over.body)).toMatch(/at most 4 images/);
  });

  it('processes every image and accounts for all of them', async () => {
    const body = await waitIdle(batchId);
    expect(body.batch.items).toHaveLength(4);
    expect(body.batch.items.filter((x) => x.status === 'failed')).toHaveLength(1);
    expect(body.batch.items.filter((x) => ['ready', 'needs_attention'].includes(x.status))).toHaveLength(3);
    const { body: b2 } = await j<{ contacts: { id: string; name: { value: string }; emails: { value: string }[]; event: string; tags: string[] }[] }>(
      `/api/batches/${batchId}`,
    );
    contactIds = b2.contacts.map((c) => c.id);
    const emails = b2.contacts.flatMap((c) => c.emails.map((e) => e.value)).sort();
    expect(emails).toEqual(['d.okafor@harbourline-logistics.com', 'info@vortexpumps.it', 'k_o-neill01@north-bay.co.uk', 'm.bellini@vortexpumps.it']);
    expect(b2.contacts.every((c) => c.event === 'Fixture Expo' && c.tags.includes('fixture'))).toBe(true);
  });

  it('recovers an item interrupted mid-processing without creating a duplicate contact', async () => {
    const d = openDb();
    const before = (d.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
    d.prepare("UPDATE batch_items SET status = 'processing' WHERE batch_id = ? AND position = 1").run(batchId);
    recoverInterrupted();
    kick();
    await waitIdle(batchId);
    const after = (d.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('keeps manual corrections when unsaved drafts are re-read', async () => {
    const id = contactIds[0];
    const { body } = await j<{ contact: Record<string, any> }>(`/api/contacts/${id}`);
    const c = body.contact;
    c.name.value = 'Corrected By Hand';
    c.notes = 'Talked about pumps';
    const put = await j<{ contact: Record<string, any>; attention: string[] }>(`/api/contacts/${id}`, {
      method: 'PUT',
      json: { contact: c, revision: c.revision },
    });
    expect(put.body.contact.name.meta.state).toBe('user_corrected');
    expect(put.body.attention).not.toContain('name');
    await j(`/api/batches/${batchId}/reread`, { method: 'POST', json: {} });
    await waitIdle(batchId);
    const re = await j<{ contact: Record<string, any> }>(`/api/contacts/${id}`);
    expect(re.body.contact.name.value).toBe('Corrected By Hand');
    expect(re.body.contact.notes).toBe('Talked about pumps');
    // stale revision is refused rather than silently overwriting
    const stale = await j(`/api/contacts/${id}`, { method: 'PUT', json: { contact: c, revision: c.revision } });
    expect(stale.status).toBe(409);
  });

  it('saves, then exports Excel/vCard whose contents match the stored contacts', async () => {
    const r = await j<{ results: { ok: boolean }[] }>('/api/contacts/save-many', { method: 'POST', json: { ids: contactIds } });
    expect(r.body.results.every((x) => x.ok)).toBe(true);
    const sum = await j<{ count: number; withEmail: number }>('/api/export/summary?scope=all');
    expect(sum.body.count).toBe(3);
    const res = await fetch(base + '/api/export.xlsx?scope=all');
    expect(res.headers.get('content-type')).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Contacts')!;
    expect(ws.rowCount).toBe(4);
    const { body: list } = await j<{ contacts: any[] }>('/api/contacts?state=saved&sort=recent');
    const byId = new Map(list.contacts.map((c) => [c.id, c]));
    const idCol = EXCEL_COLUMNS.findIndex((c) => c.key === 'id') + 1;
    for (let r2 = 2; r2 <= ws.rowCount; r2++) {
      const row = ws.getRow(r2);
      const stored = byId.get(String(row.getCell(idCol).value));
      expect(stored).toBeTruthy();
      const want = excelRow(stored);
      EXCEL_COLUMNS.forEach((col, i) => expect(row.getCell(i + 1).value ?? '').toBe(want[col.key]));
    }
    const vcf = await (await fetch(base + '/api/export.vcf?scope=all')).text();
    expect((vcf.match(/BEGIN:VCARD/g) ?? []).length).toBe(3);
    expect(vcf).toContain('EMAIL;TYPE=INTERNET,WORK,PREF:d.okafor@harbourline-logistics.com');
  });

  it('warns about a duplicate when the same card is scanned again', async () => {
    const b = await j<{ batch: { id: string } }>('/api/batches', { method: 'POST', json: { label: 'Second batch' } });
    await upload(b.body.batch.id, path.join(PHOTOS, 's03-redpanel.jpg'), 'key-ffffff', 1);
    const body = await waitIdle(b.body.batch.id);
    void body;
    const { body: bb } = await j<{ contacts: { duplicates: { strength: string; reasons: string[] }[] }[] }>(`/api/batches/${b.body.batch.id}`);
    expect(bb.contacts[0].duplicates[0].strength).toBe('strong');
    expect(bb.contacts[0].duplicates[0].reasons.join(' ')).toMatch(/same e-mail/);
    // discarding the batch removes only its unsaved draft
    const saved = (await j<{ contacts: unknown[] }>('/api/contacts?state=saved')).body.contacts.length;
    await j(`/api/batches/${b.body.batch.id}/discard`, { method: 'POST', json: {} });
    expect((await j<{ contacts: unknown[] }>('/api/contacts?state=saved')).body.contacts.length).toBe(saved);
  });

  it('backs up and restores without deleting anything, and rejects malformed backups', async () => {
    const zip = Buffer.from(await (await fetch(base + '/api/backup.zip')).arrayBuffer());
    const victim = contactIds[1];
    await j(`/api/contacts/${victim}`, { method: 'DELETE' });
    const prev = await j<{ token: string; newContacts: number; sameIdIdentical: number }>('/api/restore/preview', { method: 'POST', body: zip });
    expect(prev.status).toBe(200);
    expect(prev.body.newContacts).toBeGreaterThanOrEqual(1);
    const applied = await j<{ added: number }>('/api/restore/apply', { method: 'POST', json: { token: prev.body.token, policy: 'skip' } });
    expect(applied.body.added).toBeGreaterThanOrEqual(1);
    expect((await j(`/api/contacts/${victim}`)).status).toBe(200);
    const img = await fetch(
      base + `/api/cards/${(await j<{ contact: { cardIds: string[] } }>(`/api/contacts/${victim}`)).body.contact.cardIds[0]}/image?variant=original`,
    );
    expect(img.status).toBe(200);

    const notZip = await j('/api/restore/preview', { method: 'POST', body: Buffer.from('PK\u0003\u0004garbage') });
    expect(notZip.status).toBe(400);
    const fake = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'buz-cards-backup', version: 2 })),
      'contacts.json': strToU8(JSON.stringify([{ id: 'x' }])),
    });
    const bad = await j<{ error: string }>('/api/restore/preview', { method: 'POST', body: Buffer.from(fake) });
    expect(bad.body.error).toMatch(/invalid id|Nothing was imported/);
  });

  it('imports a backup from the earlier browser-only version', async () => {
    const legacy = {
      format: 'buz-cards',
      version: 1,
      contacts: [
        {
          id: 'legacy-0001-abcd',
          name: 'Old Contact',
          company: 'Old Co',
          title: 'Buyer',
          email: 'old@example.com',
          phone: '+1 555 0100',
          website: '',
          linkedin: '',
          address: '',
          event: 'Old Expo',
          notes: 'n',
          tags: 'a, b',
          status: 'follow-up',
          followUp: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          rawText: '',
          photos: [],
        },
      ],
    };
    const prev = await j<{ token: string; kind: string; total: number }>('/api/restore/preview', { method: 'POST', body: Buffer.from(JSON.stringify(legacy)) });
    expect(prev.body.kind).toBe('legacy');
    await j('/api/restore/apply', { method: 'POST', json: { token: prev.body.token } });
    const c = await j<{ contact: any }>('/api/contacts/legacy-0001-abcd');
    expect(c.body.contact.emails[0].value).toBe('old@example.com');
    expect(c.body.contact.status).toBe('follow_up');
    expect(c.body.contact.tags).toEqual(['a', 'b']);
  });
});

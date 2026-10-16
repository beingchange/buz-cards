// Browser tests (phone + desktop layouts) against the real server and recognition engine.
// Uses fictional synthetic card photos only.
import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const PHOTOS = path.resolve(import.meta.dirname, '../fixtures/synthetic/photos');

// The test server treats this computer like a phone (BUZ_TRUST_LOOPBACK=0), so the access code is required.
test.beforeEach(async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('buz-first-run-done', '1'));
  if (!info.title.startsWith('phone on plain-HTTP')) {
    const r = await page.request.post('/api/access', { data: { code: '424242' } });
    expect(r.ok()).toBe(true);
  }
});

test('gallery batch: upload, review with evidence, correct, save, export Excel', async ({ page }, info) => {
  const event = `Fixture Expo ${info.project.name}`;
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Choose from gallery/ })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose from gallery/ }).click();
  await (
    await chooser
  ).setFiles([path.join(PHOTOS, 's02-columns.jpg'), path.join(PHOTOS, 's07-icons.jpg'), path.resolve(import.meta.dirname, '../../package.json')]);
  await expect(page.getByText('1 file will not be read')).toBeVisible();
  await page.getByLabel(/Event or place/).fill(event);
  await page.getByRole('button', { name: 'Read 2 cards' }).click();

  await expect(page.getByText('All photos have been read.')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.list').getByText('Priya Raman').first()).toBeVisible();
  await page.getByRole('link', { name: 'Review next card' }).click();

  // Review screen: fields + evidence highlight
  const name = page.locator('#f-name');
  await expect(name).not.toHaveValue('');
  await name.focus();
  await expect(page.locator('.evidence')).toBeVisible();
  const first = await name.inputValue();
  await name.fill(first + ' Jr');
  await expect(
    page
      .locator('.f')
      .filter({ has: page.locator('#f-name') })
      .getByText('Edited'),
  ).toBeVisible();
  await page.getByRole('button', { name: /Save contact & next/ }).click();
  await expect(page).toHaveURL(/#\/contact\//);
  await expect(page.locator('#f-name')).not.toHaveValue(first + ' Jr');
  await page.getByRole('button', { name: /Save contact & next/ }).click();
  await expect(page.getByText('This batch is finished')).toBeVisible();

  await page.locator('nav').getByRole('link', { name: 'Contacts' }).click();
  await expect(page.getByText(first + ' Jr').first()).toBeVisible();
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByText(/with e-mail/)).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.getByRole('link', { name: /Excel/ }).click();
  const file = path.join(os.tmpdir(), `buz-${Date.now()}.xlsx`);
  await (await dl).saveAs(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(file) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Contacts')!;
  const rows = ws.getSheetValues().slice(2) as unknown[][];
  const emails = rows.map((r) => r[5]);
  expect(emails).toEqual(expect.arrayContaining(['priya.raman@kestrelanalytics.io', 'elena_petrova-2@northwind-solar.com']));
});

test('phone on plain-HTTP Wi-Fi address: access code, no secure-context APIs needed', async ({ page }) => {
  // A non-localhost http:// origin, like http://192.168.1.20:4173 on a phone (mapped to this machine).
  await page.goto('http://buzcards.test:4199/');
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await page.getByLabel('Access code').fill('000000');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByText(/not right/)).toBeVisible();
  await page.getByLabel('Access code').fill('424242');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('button', { name: /Take a photo/ })).toBeVisible();
  // single photo via the camera input, over insecure HTTP
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Take a photo/ }).click();
  await (await chooser).setFiles(path.join(PHOTOS, 's11-tricky-email.jpg'));
  await expect(page.locator('#f-name')).toHaveValue("Kieran O'Neill", { timeout: 120_000 });
  await expect(page.getByLabel('Email').first()).toHaveValue('k_o-neill01@north-bay.co.uk');
});

test('photos chosen before a reload are still uploaded afterwards', async ({ page }, info) => {
  await page.goto('/');
  await page.route('**/api/batches/*/items', (route) => route.abort()); // computer "unreachable" for uploads
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose from gallery/ }).click();
  await (await chooser).setFiles([path.join(PHOTOS, 's06-initials.jpg')]);
  const event = `Reload test ${info.project.name}`;
  await page.getByLabel(/Event or place/).fill(event);
  await page.getByRole('button', { name: 'Read 1 card' }).click();
  await expect(page.getByText(/Waiting for the Buz Cards computer/).first()).toBeVisible({ timeout: 30_000 });
  await page.unroute('**/api/batches/*/items');
  await page.reload(); // the photo is only in this browser's IndexedDB now
  await page.goto('/#/batches');
  await page.getByRole('link', { name: new RegExp(event) }).click();
  await expect(
    page
      .locator('.list')
      .getByText(/Whitfield/)
      .first(),
  ).toBeVisible({ timeout: 120_000 });
});

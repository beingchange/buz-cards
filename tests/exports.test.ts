// Excel and vCard exports: the downloaded file itself is read back and compared with the stored values.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { EXCEL_COLUMNS, buildWorkbook, excelRow, foldLine, toVCard } from '../server/exports.ts';
import { blankContact } from '../server/contacts.ts';
import type { Contact, MultiValue } from '../shared/types.ts';

const mv = (value: string, label: string, primary = false): MultiValue => ({
  id: value,
  value,
  normalized: value,
  label,
  primary,
  meta: { state: 'extracted', source: 'ocr' },
});
const tf = (value: string) => ({ value, meta: { state: 'extracted' as const, source: 'ocr' as const } });

function tricky(): Contact {
  return blankContact({
    state: 'saved',
    name: tf('Zoë O’Brien-Łukasiewicz'),
    credentials: tf('PE, CEM'),
    title: tf('Head of R&D; "Special" projects'),
    company: tf('=HYPERLINK("http://evil.example","click")'),
    address: tf('Unit 4, Dockside Park\nDublin 2, Ireland'),
    emails: [mv('zoe.obrien@example.ie', 'work', true), mv('+info@example.ie', 'general')],
    phones: [mv('+353 87 555 0123', 'mobile', true), mv('0044 20 7946 0321', 'office'), mv('00123', 'other')],
    websites: [mv('www.example.ie', 'website', true)],
    notes: 'Met at the stand.\nLong note: ' + 'x'.repeat(3000),
    tags: ['HVAC', 'Dublin'],
    event: '-Expo 2026',
    followUp: '2026-11-02',
  });
}

describe('Excel export', () => {
  it('writes exactly the stored values as text cells (no formulas, no lost "+" or leading zeros)', async () => {
    const c = tricky();
    const other = blankContact({ state: 'saved', name: tf('Second Person'), emails: [], phones: [] });
    const buf = await buildWorkbook([c, other], { scope: 'test' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Contacts')!;
    expect(ws.getRow(1).values).toEqual([undefined, ...EXCEL_COLUMNS.map((x) => x.header)]);
    expect(ws.rowCount).toBe(3);
    const expected = excelRow(c);
    EXCEL_COLUMNS.forEach((col, i) => {
      const cell = ws.getRow(2).getCell(i + 1);
      expect(typeof cell.value === 'string' || cell.value === null || (cell.value as unknown) === '').toBe(true);
      expect(cell.formula).toBeUndefined();
      expect(cell.value ?? '').toBe(expected[col.key]);
    });
    const byHeader = (h: string) => ws.getRow(2).getCell(EXCEL_COLUMNS.findIndex((x) => x.header === h) + 1);
    expect(byHeader('Phone (primary)').value).toBe('+353 87 555 0123');
    expect(byHeader('Other phones').value).toBe('Office: 0044 20 7946 0321\nOther: 00123');
    expect(byHeader('Email (primary)').value).toBe('zoe.obrien@example.ie');
    expect(byHeader('Other emails').value).toBe('+info@example.ie');
    expect(byHeader('Name').value).toBe('Zoë O’Brien-Łukasiewicz');
    expect(byHeader('Company').value).toBe('=HYPERLINK("http://evil.example","click")');
    expect(byHeader('Company').numFmt).toBe('@');
    expect(byHeader('Company').type).toBe(ExcelJS.ValueType.String);
    expect(String(byHeader('Notes').value).length).toBe(c.notes.length);
    // empty e-mail stays empty (and is counted, not hidden)
    expect(ws.getRow(3).getCell(EXCEL_COLUMNS.findIndex((x) => x.key === 'email') + 1).value ?? '').toBe('');
  });
});

describe('vCard export', () => {
  it('escapes special characters, folds long lines and keeps all e-mails/phones', () => {
    const v = toVCard(tricky());
    expect(v.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true);
    expect(v).toContain('TITLE:Head of R&D\\; "Special" projects');
    expect(v).toContain('ADR;TYPE=WORK:;;Unit 4\\, Dockside Park\\nDublin 2\\, Ireland;;;;');
    expect(v).toContain('TEL;TYPE=CELL,VOICE,PREF:+353 87 555 0123');
    expect(v).toContain('TEL;TYPE=WORK,VOICE:0044 20 7946 0321');
    expect((v.match(/^EMAIL/gm) ?? []).length).toBe(2);
    expect(v).toMatch(/^N:Łukasiewicz|^N:O’Brien-Łukasiewicz/m);
    for (const l of v.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    // unfolding restores the original note text
    const unfolded = v.replace(/\r\n /g, '');
    expect(unfolded).toContain('x'.repeat(3000));
  });
  it('never splits a multi-byte character when folding', () => {
    const folded = foldLine('NOTE:' + 'ü'.repeat(100));
    expect(folded.replace(/\r\n /g, '')).toBe('NOTE:' + 'ü'.repeat(100));
  });
});

// Excel (.xlsx) and phone-contact (.vcf) exports. Values are written exactly as stored (original formatting).
import ExcelJS from 'exceljs';
import type { Contact, MultiValue } from '../shared/types.ts';
import { attentionList } from './contacts.ts';

export const EXCEL_COLUMNS = [
  { key: 'name', header: 'Name', width: 26 },
  { key: 'credentials', header: 'Credentials', width: 16 },
  { key: 'title', header: 'Position', width: 28 },
  { key: 'company', header: 'Company', width: 28 },
  { key: 'email', header: 'Email (primary)', width: 32 },
  { key: 'emailsMore', header: 'Other emails', width: 32 },
  { key: 'phone', header: 'Phone (primary)', width: 20 },
  { key: 'phoneLabel', header: 'Phone type', width: 11 },
  { key: 'phonesMore', header: 'Other phones', width: 30 },
  { key: 'website', header: 'Website', width: 28 },
  { key: 'linkedin', header: 'LinkedIn (confirmed)', width: 34 },
  { key: 'address', header: 'Address', width: 40 },
  { key: 'event', header: 'Event / where met', width: 24 },
  { key: 'tags', header: 'Tags', width: 20 },
  { key: 'status', header: 'Status', width: 12 },
  { key: 'followUp', header: 'Follow-up date', width: 14 },
  { key: 'notes', header: 'Notes', width: 50 },
  { key: 'review', header: 'Review state', width: 22 },
  { key: 'createdAt', header: 'Added', width: 20 },
  { key: 'updatedAt', header: 'Updated', width: 20 },
  { key: 'id', header: 'Contact ID', width: 38 },
] as const;

const STATUS_LABEL: Record<string, string> = { new: 'New', follow_up: 'Follow up', connected: 'Connected' };
const LABEL: Record<string, string> = {
  mobile: 'Mobile',
  office: 'Office',
  direct: 'Direct',
  fax: 'Fax',
  home: 'Home',
  phone: 'Phone',
  other: 'Other',
  work: 'Work',
  general: 'General',
  personal: 'Personal',
};

const primaryOf = (vs: MultiValue[]) => vs.find((v) => v.primary) ?? vs[0];
// Multiple values: one per line inside the cell, "Label: value" so nothing is lost or merged.
const others = (vs: MultiValue[], withLabel = true) =>
  vs
    .filter((v) => v !== primaryOf(vs))
    .map((v) => (withLabel ? `${LABEL[v.label] ?? v.label}: ${v.value}` : v.value))
    .join('\n');

/** The exact cell text for each column. Used by the workbook writer AND by the export verification tests. */
export function excelRow(c: Contact): Record<(typeof EXCEL_COLUMNS)[number]['key'], string> {
  const pe = primaryOf(c.emails);
  const pp = primaryOf(c.phones);
  const printedSites = c.websites.filter((w) => w.label !== 'qr-link');
  const attention = attentionList(c);
  return {
    name: c.name.value,
    credentials: c.credentials.value,
    title: c.title.value,
    company: c.company.value,
    email: pe?.value ?? '',
    emailsMore: others(c.emails, false),
    phone: pp?.value ?? '',
    phoneLabel: pp ? (LABEL[pp.label] ?? pp.label) : '',
    phonesMore: others(c.phones),
    website: [...printedSites.map((w) => w.value), ...c.websites.filter((w) => w.label === 'qr-link').map((w) => `QR: ${w.value}`)].join('\n'),
    linkedin: c.linkedin.url,
    address: c.address.value,
    event: c.event,
    tags: c.tags.join(', '),
    status: STATUS_LABEL[c.status] ?? c.status,
    followUp: c.followUp,
    notes: c.notes,
    review:
      c.state === 'saved'
        ? attention.length
          ? `Saved; unverified: ${attention.join(', ')}`
          : 'Saved'
        : `DRAFT (not reviewed)${attention.length ? '; check: ' + attention.join(', ') : ''}`,
    createdAt: c.createdAt.replace('T', ' ').slice(0, 19),
    updatedAt: c.updatedAt.replace('T', ' ').slice(0, 19),
    id: c.id,
  };
}

/** Values Excel/LibreOffice/Sheets could treat as formulas if typed in or converted to CSV. */
export const looksLikeFormula = (v: string) => /^[=+\-@\t\r]/.test(v);

export async function buildWorkbook(contacts: Contact[], meta: { scope: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Buz Cards';
  wb.created = new Date();
  const ws = wb.addWorksheet('Contacts', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = EXCEL_COLUMNS.map((c) => ({ key: c.key, header: c.header, width: c.width }));
  for (const c of contacts) {
    const values = excelRow(c);
    const row = ws.addRow({});
    EXCEL_COLUMNS.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const v = values[col.key];
      // Always a text cell: phone numbers keep their "+" and leading zeros; nothing is evaluated as a formula.
      cell.value = v; // a JS string is always written as a text (shared string) cell
      // Text number format: if someone later edits the cell in Excel it stays text instead of turning "=..." or
      // "+1 212..." into a formula/number. A string cell in .xlsx is never executed as a formula.
      cell.numFmt = '@';
    });
    row.alignment = { vertical: 'top', wrapText: true };
  }
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  header.alignment = { vertical: 'middle' };
  header.height = 24;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXCEL_COLUMNS.length } };

  const info = wb.addWorksheet('About this export');
  info.columns = [
    { header: 'Item', key: 'k', width: 26 },
    { header: 'Value', key: 'v', width: 90 },
  ];
  info.addRows([
    { k: 'Exported', v: new Date().toISOString() },
    { k: 'Scope', v: meta.scope },
    { k: 'Contacts', v: String(contacts.length) },
    { k: 'With e-mail', v: String(contacts.filter((c) => c.emails.length).length) },
    { k: 'With phone', v: String(contacts.filter((c) => c.phones.length).length) },
    { k: 'Multiple values', v: 'The primary e-mail/phone has its own column; others are listed one per line as "Type: value".' },
    { k: 'Review state', v: 'DRAFT rows were not reviewed by a person. "unverified" lists fields the scanner flagged and nobody confirmed.' },
  ]);
  info.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- vCard 3.0 (best supported by iOS Contacts and Google/Android Contacts) ----------

export const escapeVCard = (v: string) => v.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

/** Fold lines longer than 75 octets (RFC 6350/2426), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  let out = '',
    bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > 75) {
      out += '\r\n ';
      bytes = 1;
    }
    out += ch;
    bytes += n;
  }
  return out;
}

function splitName(full: string): { given: string; family: string; middle: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { given: parts[0] ?? '', family: '', middle: '' };
  const particles = new Set(['de', 'da', 'del', 'della', 'di', 'van', 'von', 'der', 'den', 'la', 'le', 'du', 'bin', 'al', 'el', 'dos', 'das']);
  let i = parts.length - 1;
  while (i > 1 && particles.has(parts[i - 1].toLowerCase())) i--;
  return { given: parts[0], middle: parts.slice(1, i).join(' '), family: parts.slice(i).join(' ') };
}

const TEL_TYPE: Record<string, string> = {
  mobile: 'CELL,VOICE',
  office: 'WORK,VOICE',
  direct: 'WORK,VOICE',
  fax: 'WORK,FAX',
  home: 'HOME,VOICE',
  phone: 'VOICE',
  other: 'VOICE',
};

export function toVCard(c: Contact): string {
  const name = c.name.value.trim();
  const n = splitName(name);
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  lines.push(`N:${escapeVCard(n.family)};${escapeVCard(n.given)};${escapeVCard(n.middle)};;${escapeVCard(c.credentials.value)}`);
  lines.push(`FN:${escapeVCard(name || c.company.value || c.emails[0]?.value || 'Unnamed contact')}`);
  if (c.company.value) lines.push(`ORG:${escapeVCard(c.company.value)}`);
  if (c.title.value) lines.push(`TITLE:${escapeVCard(c.title.value)}`);
  const sortP = <T extends MultiValue>(vs: T[]) => [...vs].sort((a, b) => Number(b.primary) - Number(a.primary));
  for (const e of sortP(c.emails))
    lines.push(`EMAIL;TYPE=INTERNET,${e.label === 'personal' ? 'HOME' : 'WORK'}${e.primary ? ',PREF' : ''}:${escapeVCard(e.value)}`);
  for (const p of sortP(c.phones)) lines.push(`TEL;TYPE=${TEL_TYPE[p.label] ?? 'VOICE'}${p.primary ? ',PREF' : ''}:${escapeVCard(p.value)}`);
  for (const w of c.websites.filter((w) => w.label !== 'qr-link')) lines.push(`URL;TYPE=WORK:${escapeVCard(w.value)}`);
  if (c.linkedin.url) {
    lines.push(`URL;TYPE=LinkedIn:${escapeVCard(c.linkedin.url)}`);
    lines.push(`X-SOCIALPROFILE;TYPE=linkedin:${escapeVCard(c.linkedin.url)}`);
  }
  if (c.address.value) lines.push(`ADR;TYPE=WORK:;;${escapeVCard(c.address.value)};;;;`);
  const note = [c.event && `Met at: ${c.event}`, c.notes, c.tags.length ? `Tags: ${c.tags.join(', ')}` : '', c.followUp && `Follow up: ${c.followUp}`]
    .filter(Boolean)
    .join('\n');
  if (note) lines.push(`NOTE:${escapeVCard(note)}`);
  if (c.tags.length) lines.push(`CATEGORIES:${c.tags.map(escapeVCard).join(',')}`);
  lines.push(`UID:urn:uuid:${c.id}`);
  lines.push(`REV:${c.updatedAt}`);
  lines.push('END:VCARD');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function toVCards(contacts: Contact[]): string {
  return contacts.map(toVCard).join('');
}

export function exportSummary(contacts: Contact[]) {
  return {
    count: contacts.length,
    withEmail: contacts.filter((c) => c.emails.length).length,
    withoutEmail: contacts.filter((c) => !c.emails.length).length,
    withPhone: contacts.filter((c) => c.phones.length).length,
    withoutPhone: contacts.filter((c) => !c.phones.length).length,
    unverified: contacts.filter((c) => attentionList(c).length).length,
    drafts: contacts.filter((c) => c.state !== 'saved').length,
  };
}

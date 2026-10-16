// Contact records: creation from extraction, rescans that preserve manual corrections, search, duplicates.
import { randomUUID } from 'node:crypto';
import type { Contact, FieldMeta, MultiValue, TextField } from '../shared/types.ts';
import { openDb, tx } from './db.ts';
import type { Extraction } from './extraction/fields.ts';
import { normalizeEmail, normalizeName, normalizePhone, normalizeWebsite, phoneMatchKey } from './extraction/patterns.ts';

export const newId = () => randomUUID();
const now = () => new Date().toISOString();

const emptyField = (): TextField => ({ value: '', meta: { state: 'not_found', source: 'ocr' } });

export function blankContact(partial: Partial<Contact> = {}): Contact {
  const t = now();
  return {
    id: newId(),
    state: 'draft',
    status: 'new',
    name: emptyField(),
    credentials: emptyField(),
    company: emptyField(),
    title: emptyField(),
    address: emptyField(),
    emails: [],
    phones: [],
    websites: [],
    linkedin: { url: '', meta: { state: 'not_found', source: 'ocr' }, candidates: [] },
    event: '',
    tags: [],
    notes: '',
    followUp: '',
    cardIds: [],
    batchId: null,
    ocrText: '',
    extractorVersion: '',
    createdAt: t,
    updatedAt: t,
    savedAt: null,
    revision: 0,
    mergedFrom: [],
    ...partial,
  };
}

const TEXT_FIELDS = ['name', 'credentials', 'company', 'title', 'address'] as const;
const MULTI_FIELDS = ['emails', 'phones', 'websites'] as const;

function withMachine(f: TextField): TextField {
  return { value: f.value, meta: { ...f.meta, machineValue: f.value } };
}

/** Apply a (new) machine extraction to a contact. Fields the user corrected are never overwritten. */
export function applyExtraction(c: Contact, ex: Extraction, ocrText: string): Contact {
  const out: Contact = structuredClone(c);
  for (const k of TEXT_FIELDS) {
    const cur = out[k];
    if (cur.meta.state === 'user_corrected') {
      cur.meta.machineValue = ex[k].value; // remember the new suggestion without applying it
      continue;
    }
    out[k] = withMachine(ex[k]);
  }
  for (const k of MULTI_FIELDS) {
    const userItems = out[k].filter((v) => v.meta.state === 'user_corrected' || v.meta.source === 'user');
    const userKeys = new Set(userItems.map((v) => v.normalized));
    // Machine items the user deleted are remembered so a rescan does not resurrect them.
    const removed = new Set(((out as unknown as { removedMachine?: Record<string, string[]> }).removedMachine?.[k] ?? []) as string[]);
    const machine = ex[k]
      .filter((v) => !userKeys.has(v.normalized) && !removed.has(v.normalized))
      .map((v) => ({ ...v, meta: { ...v.meta, machineValue: v.value } }));
    const merged = [...userItems, ...machine];
    if (merged.length && !merged.some((v) => v.primary)) merged[0].primary = true;
    if (merged.filter((v) => v.primary).length > 1) {
      let seen = false;
      for (const v of merged) {
        if (v.primary && seen) v.primary = false;
        if (v.primary) seen = true;
      }
    }
    out[k] = merged as MultiValue[];
  }
  if (out.linkedin.meta.source !== 'user' && out.linkedin.meta.state !== 'enriched') {
    out.linkedin = { ...out.linkedin, url: ex.linkedin.url, meta: { ...ex.linkedin.meta, machineValue: ex.linkedin.url } };
  }
  out.ocrText = ocrText;
  out.extractorVersion = ex.version;
  return out;
}

/** Merge information from the back of a card: fills empty fields and adds extra e-mails/phones/websites. */
export function applyBackExtraction(c: Contact, ex: Extraction, ocrText: string): Contact {
  const out: Contact = structuredClone(c);
  for (const k of TEXT_FIELDS) if (!out[k].value && ex[k].value) out[k] = withMachine(ex[k]);
  for (const k of MULTI_FIELDS) {
    for (const v of ex[k]) {
      if (out[k].some((x) => x.normalized === v.normalized)) continue;
      out[k].push({
        ...v,
        primary: out[k].length === 0,
        meta: { ...v.meta, machineValue: v.value, reasons: [...(v.meta.reasons ?? []), 'From the back of the card.'] },
      });
    }
  }
  if (!out.linkedin.url && ex.linkedin.url) out.linkedin = { ...out.linkedin, url: ex.linkedin.url, meta: ex.linkedin.meta };
  out.ocrText = [out.ocrText, ocrText].filter(Boolean).join('\n--- back ---\n');
  return out;
}

export function searchText(c: Contact): string {
  return [
    c.name.value,
    c.credentials.value,
    c.company.value,
    c.title.value,
    c.address.value,
    ...c.emails.map((e) => e.value),
    ...c.phones.map((p) => `${p.value} ${p.normalized} ${p.normalized.replace(/^\+/, '')}`),
    ...c.websites.map((w) => w.value),
    c.linkedin.url,
    c.event,
    c.tags.join(' '),
    c.notes,
    c.status,
  ]
    .join(' \n ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Recompute the normalized keys (used for search and duplicate detection) from the visible values. */
export function normalizeContact(c: Contact): Contact {
  for (const e of c.emails) e.normalized = normalizeEmail(e.value);
  for (const p of c.phones) p.normalized = normalizePhone(p.value.replace(/\s*(?:ext\.?|x)\s*\d{1,5}$/i, ''));
  for (const w of c.websites) w.normalized = normalizeWebsite(w.value);
  for (const k of MULTI_FIELDS) {
    c[k] = c[k].filter((v) => v.value.trim());
    if (c[k].length && !c[k].some((v) => v.primary)) c[k][0].primary = true;
  }
  c.tags = [...new Set(c.tags.map((t) => t.trim()).filter(Boolean))];
  return c;
}

// ---------- persistence ----------

interface Row {
  id: string;
  state: string;
  data: string;
  revision: number;
}

export function getContact(id: string): Contact | null {
  const r = openDb().prepare('SELECT id, state, data, revision FROM contacts WHERE id = ?').get(id) as Row | undefined;
  return r ? parseRow(r) : null;
}

function parseRow(r: Row): Contact {
  const c = JSON.parse(r.data) as Contact;
  c.state = r.state as Contact['state'];
  c.revision = r.revision;
  // forward compatibility for records created before a field existed
  c.credentials ??= emptyField();
  c.mergedFrom ??= [];
  return c;
}

export class ConflictError extends Error {
  current: Contact;
  constructor(current: Contact) {
    super('This contact was changed somewhere else (another device or tab). Reload to see the latest version.');
    this.current = current;
  }
}

/** Insert or update. When expectedRevision is given, refuse to overwrite a newer version. */
export function putContact(c: Contact, expectedRevision?: number): Contact {
  return tx(() => {
    const d = openDb();
    const existing = d.prepare('SELECT id, state, data, revision FROM contacts WHERE id = ?').get(c.id) as Row | undefined;
    if (existing && expectedRevision !== undefined && existing.revision !== expectedRevision) throw new ConflictError(parseRow(existing));
    const next: Contact = normalizeContact({ ...c, updatedAt: now(), revision: (existing?.revision ?? 0) + 1 });
    if (next.state === 'saved' && !next.savedAt) next.savedAt = now();
    d.prepare(
      `INSERT INTO contacts(id, state, data, search, batch_id, created_at, updated_at, saved_at, revision)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state=excluded.state, data=excluded.data, search=excluded.search, batch_id=excluded.batch_id,
         updated_at=excluded.updated_at, saved_at=excluded.saved_at, revision=excluded.revision`,
    ).run(next.id, next.state, JSON.stringify(next), searchText(next), next.batchId, next.createdAt, next.updatedAt, next.savedAt, next.revision);
    return next;
  });
}

export function deleteContact(id: string) {
  tx(() => {
    const d = openDb();
    d.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    d.prepare('UPDATE cards SET contact_id = NULL WHERE contact_id = ?').run(id);
    d.prepare(
      "UPDATE batch_items SET contact_id = NULL, status = CASE WHEN status IN ('ready','needs_attention') THEN 'skipped' ELSE status END WHERE contact_id = ?",
    ).run(id);
  });
}

export interface ListQuery {
  state?: string; // saved | draft | skipped | all
  q?: string;
  event?: string;
  status?: string;
  tag?: string;
  followUp?: 'due' | 'upcoming' | 'any';
  sort?: 'recent' | 'name' | 'company' | 'followup';
  ids?: string[];
  batchId?: string;
}

export function listContacts(q: ListQuery = {}): Contact[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.ids?.length) {
    where.push(`id IN (${q.ids.map(() => '?').join(',')})`);
    params.push(...q.ids);
  }
  if (q.state && q.state !== 'all') {
    where.push('state = ?');
    params.push(q.state);
  }
  if (q.batchId) {
    where.push('batch_id = ?');
    params.push(q.batchId);
  }
  const terms = (q.q ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of terms) {
    where.push("search LIKE ? ESCAPE '\\'");
    params.push(`%${t.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
  }
  const rows = openDb()
    .prepare(`SELECT id, state, data, revision FROM contacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`)
    .all(...params) as unknown as Row[];
  let list = rows.map(parseRow);
  if (q.event) list = list.filter((c) => c.event === q.event);
  if (q.status) list = list.filter((c) => c.status === q.status);
  if (q.tag) list = list.filter((c) => c.tags.includes(q.tag!));
  const today = new Date().toISOString().slice(0, 10);
  if (q.followUp === 'due') list = list.filter((c) => c.followUp && c.followUp <= today);
  if (q.followUp === 'upcoming') list = list.filter((c) => c.followUp && c.followUp > today);
  if (q.followUp === 'any') list = list.filter((c) => c.followUp);
  const by = (f: (c: Contact) => string) => (a: Contact, b: Contact) => f(a).localeCompare(f(b), undefined, { sensitivity: 'base' });
  if (q.sort === 'name') list.sort(by((c) => c.name.value || '￿'));
  if (q.sort === 'company') list.sort(by((c) => c.company.value || '￿'));
  if (q.sort === 'followup') list.sort(by((c) => c.followUp || '9999'));
  return list;
}

export function facets() {
  const saved = listContacts({ state: 'saved' });
  const events = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const c of saved) {
    if (c.event) events.set(c.event, (events.get(c.event) ?? 0) + 1);
    for (const t of c.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  const today = new Date().toISOString().slice(0, 10);
  return {
    events: [...events].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    tags: [...tags].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    followUps: {
      due: saved.filter((c) => c.followUp && c.followUp <= today).length,
      upcoming: saved.filter((c) => c.followUp && c.followUp > today).length,
    },
  };
}

// ---------- duplicates ----------

export interface DuplicateMatch {
  id: string;
  state: Contact['state'];
  name: string;
  company: string;
  reasons: string[];
  strength: 'strong' | 'possible';
}

/** Possible duplicates of `c` among saved contacts and current drafts. Never merges anything by itself. */
export function findDuplicates(c: Contact, pool?: Contact[]): DuplicateMatch[] {
  const others = (pool ?? listContacts({ state: 'all' })).filter((o) => o.id !== c.id && o.state !== 'skipped');
  const emails = new Set(c.emails.map((e) => normalizeEmail(e.value)).filter(Boolean));
  const phones = new Set(c.phones.map((p) => phoneMatchKey(p.value)).filter(Boolean));
  const nm = normalizeName(c.name.value);
  const co = normalizeName(c.company.value);
  const out: DuplicateMatch[] = [];
  for (const o of others) {
    const reasons: string[] = [];
    const sharedEmail = o.emails.find((e) => emails.has(normalizeEmail(e.value)));
    if (sharedEmail) reasons.push(`same e-mail (${sharedEmail.value})`);
    const sharedPhone = o.phones.find((p) => phones.has(phoneMatchKey(p.value)));
    if (sharedPhone) reasons.push(`same phone (${sharedPhone.value})`);
    const onm = normalizeName(o.name.value);
    if (nm && onm && nm === onm) {
      if (co && normalizeName(o.company.value) === co) reasons.push('same name and company');
      else reasons.push('same name');
    }
    if (!reasons.length) continue;
    // A shared general number/e-mail (e.g. a company switchboard) alone is weak evidence.
    const strong = reasons.some((r) => r.startsWith('same e-mail') || r === 'same name and company') || (reasons.length >= 2 && !!nm);
    out.push({ id: o.id, state: o.state, name: o.name.value, company: o.company.value, reasons, strength: strong ? 'strong' : 'possible' });
  }
  return out.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'strong' ? -1 : 1));
}

/** Merge `other` into `primary` using per-field choices; multi-value fields are unioned. Returns the merged contact. */
export function mergeContacts(
  primary: Contact,
  other: Contact,
  choose: Partial<Record<(typeof TEXT_FIELDS)[number] | 'event' | 'notes' | 'followUp' | 'status', 'primary' | 'other'>>,
): Contact {
  const m: Contact = structuredClone(primary);
  for (const k of TEXT_FIELDS) {
    if (choose[k] === 'other' || (!m[k].value && other[k].value)) m[k] = structuredClone(other[k]);
  }
  for (const k of ['event', 'followUp', 'status'] as const)
    if (choose[k] === 'other' || (!m[k] && other[k])) (m as unknown as Record<string, unknown>)[k] = other[k];
  if (choose.notes === 'other') m.notes = other.notes;
  else if (other.notes && !m.notes.includes(other.notes)) m.notes = [m.notes, other.notes].filter(Boolean).join('\n\n');
  for (const k of MULTI_FIELDS) {
    for (const v of other[k]) if (!m[k].some((x) => x.normalized === v.normalized)) m[k].push({ ...v, primary: false });
  }
  if (!m.linkedin.url && other.linkedin.url) m.linkedin = structuredClone(other.linkedin);
  m.tags = [...new Set([...m.tags, ...other.tags])];
  m.cardIds = [...new Set([...m.cardIds, ...other.cardIds])];
  m.mergedFrom = [...new Set([...m.mergedFrom, other.id, ...other.mergedFrom])];
  m.ocrText = [m.ocrText, other.ocrText].filter(Boolean).join('\n---\n');
  return m;
}

/** Mark a field as user-approved when its value differs from the machine suggestion. */
export function markUserEdits(prev: Contact | null, next: Contact): Contact {
  const out = structuredClone(next);
  for (const k of TEXT_FIELDS) {
    const before = prev?.[k];
    const f = out[k];
    if (!before) continue;
    if (f.value !== before.value) {
      f.meta = {
        ...f.meta,
        state: 'user_corrected',
        source: 'user',
        machineValue: before.meta.machineValue ?? before.value,
        reasons: undefined,
        alternatives: f.meta.alternatives,
      };
    }
  }
  for (const k of MULTI_FIELDS) {
    const prevItems = new Map((prev?.[k] ?? []).map((v) => [v.id, v]));
    for (const v of out[k]) {
      const p = prevItems.get(v.id);
      if (!p) {
        if (v.meta.source !== 'qr' && v.meta.source !== 'ocr') v.meta = { ...v.meta, state: 'user_corrected', source: 'user' };
        else if (!prev) continue;
        else v.meta = { ...v.meta, state: 'user_corrected', source: 'user' };
      } else if (p.value !== v.value || p.label !== v.label) {
        v.meta = { ...v.meta, state: 'user_corrected', source: 'user', machineValue: p.meta.machineValue ?? p.value, reasons: undefined };
      }
    }
    // remember machine values the user removed, so a later rescan does not bring them back
    const kept = new Set(out[k].map((v) => v.id));
    const removed = (prev?.[k] ?? []).filter((v) => !kept.has(v.id) && v.meta.source !== 'user').map((v) => v.normalized);
    if (removed.length) {
      const rm = ((out as unknown as { removedMachine?: Record<string, string[]> }).removedMachine ??= {});
      rm[k] = [...new Set([...(rm[k] ?? []), ...removed])];
    }
  }
  return out;
}

/** Explicitly approve a field as-is (clears its review flag without changing the value). */
export function approveField(c: Contact, field: string, itemId?: string): Contact {
  const out = structuredClone(c);
  const approve = (m: FieldMeta): FieldMeta => ({
    ...m,
    state: 'user_corrected',
    source: m.source === 'ocr' || m.source === 'qr' ? m.source : 'user',
    reasons: undefined,
  });
  if ((TEXT_FIELDS as readonly string[]).includes(field)) {
    const f = out[field as (typeof TEXT_FIELDS)[number]];
    f.meta = approve(f.meta);
  } else if ((MULTI_FIELDS as readonly string[]).includes(field)) {
    for (const v of out[field as (typeof MULTI_FIELDS)[number]]) if (!itemId || v.id === itemId) v.meta = approve(v.meta);
  }
  return out;
}

/** Which fields still need a look. Blank optional fields are not problems. */
export function attentionList(c: Contact): string[] {
  const out: string[] = [];
  for (const k of TEXT_FIELDS) if (c[k].meta.state === 'needs_review') out.push(k);
  for (const k of MULTI_FIELDS) if (c[k].some((v) => v.meta.state === 'needs_review')) out.push(k);
  if (c.linkedin.meta.state === 'needs_review') out.push('linkedin');
  if (!c.name.value && !c.company.value) out.push('name');
  if (!c.emails.length && !c.phones.length) out.push('contact details');
  return [...new Set(out)];
}

// Layout-aware field extraction: OCR lines (with boxes and alternative readings) -> structured contact fields.
// Never invents values: everything returned is traceable to printed text or a QR code on the card. When the
// evidence is ambiguous the field is returned with state "needs_review" and the specific reason.
import type { Box, FieldMeta, MultiValue, OcrLineDTO, TextField } from '../../shared/types.ts';
import { dictionaryWords } from '../recognition/consensus.ts';
import {
  ADDRESS_WORDS_RE,
  COMPANY_SUFFIX_RE,
  COUNTRIES_RE,
  GENERIC_EMAIL_LOCALS,
  NON_NAME_WORDS,
  POSTCODE_RES,
  TITLE_MODIFIERS,
  TITLE_WORDS,
  cityStateLine,
  hasKnownTld,
  isCredentialToken,
  isValidEmailSyntax,
  normalizeEmail,
  normalizePhone,
  normalizeWebsite,
  phoneLabel,
  splitCredentials,
} from './patterns.ts';

export const EXTRACTOR_VERSION = 'layout-2.0.0';

export interface ExtractInput {
  lines: OcrLineDTO[];
  qr: string[];
  width: number;
  height: number;
  /** Working-image pixels per photo pixel (from recognition). Lets us warn when print was tiny in the photo. */
  scale?: number;
}

let currentScale = 0;

export interface Extraction {
  name: TextField;
  credentials: TextField;
  company: TextField;
  title: TextField;
  address: TextField;
  emails: MultiValue[];
  phones: MultiValue[];
  websites: MultiValue[];
  linkedin: { url: string; meta: FieldMeta };
  otherText: string[];
  roles: Record<string, string>; // lineId -> role, for evidence highlighting
  version: string;
}

const LOW_CONF = 0.85;

interface Segment {
  lineIds: string[];
  text: string;
  box: Box;
  conf: number;
  disputed: boolean;
  alternatives: string[];
  /** Part of a "|" / bullet list (service lists, taglines): never a name or company on its own. */
  isList: boolean;
  /** Number of printed rows this segment spans (stacked words joined = 2). */
  rows?: number;
}

const lineH = (s: Segment) => s.box.h / (s.rows ?? 1);

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const lettersOnly = (s: string) => fold(s).replace(/[^a-z0-9]/g, '');

let idCounter = 0;
const vid = (p: string) => `${p}${Date.now().toString(36)}${(++idCounter).toString(36)}`;

function unionBox(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w)),
    b = Math.max(...boxes.map((bb) => bb.y + bb.h));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(r - x), h: Math.round(b - y) };
}

function notFound(): TextField {
  return { value: '', meta: { state: 'not_found', source: 'ocr' } };
}

// ---------- contact item detection ----------

const EMAIL_FIND = /[A-Za-z0-9][A-Za-z0-9._%+'-]*\s?@\s?[A-Za-z0-9-]+(?:\s?\.\s?[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
const URL_FIND = /\b(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+(?:\/[^\s|,;]*)?/g;
const PHONE_FIND = /(?:\+|\b00)?\(?\d[\d\s().\-\/]{4,}\d(?:\s*(?:ext\.?|x)\s*\d{1,5})?/gi;
const TRAILING_LABEL_RE =
  /(?<=^|\s)(e-?mail|email|mail|e|tel|telephone|t|phone|ph|p|mobile|mob|m|m2|cell|c|fax|f|direct|dir|d|office|o|main|web|website|w|url|whatsapp|wa|h|home|24\s?hr|24\/7)\s*[:.]?\s*$/i;
// Only strip a leading label when it is clearly a label ("Tel:", "Email.") or stands alone.
const LEADING_LABEL_RE = /^(e-?mail|email|tel|telephone|phone|ph|mobile|mob|cell|fax|direct|office|main|web|website|url)\b\s*(?:[:.]\s*|$)/i;

export function findEmails(text: string): { value: string; start: number; end: number }[] {
  const out: { value: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(EMAIL_FIND)) {
    const raw = m[0];
    const value = raw.replace(/\s+/g, '').replace(/[.,;:]+$/, '');
    if (isValidEmailSyntax(value)) out.push({ value, start: m.index!, end: m.index! + raw.length });
  }
  return out;
}

export function findUrls(text: string): { value: string; start: number; end: number }[] {
  const out: { value: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(URL_FIND)) {
    const raw = m[0].replace(/[.,;:]+$/, '');
    const host = raw.replace(/^https?:\/\//i, '').split('/')[0];
    const explicit = /^(https?:\/\/|www\.)/i.test(raw) || /linkedin\.com/i.test(raw);
    if (!explicit && !hasKnownTld(host)) continue;
    if (!/[a-z]{2,}/i.test(host.replace(/^www\./i, '').split('.')[0])) continue;
    if (host.split('.').some((p) => p.length === 0) || /^([a-z]\.)+[a-z]?$/i.test(host)) continue;
    // "Ph.D", "P.E", "Inc.com"-like fragments: require a 2+ letter label before the TLD.
    if (host.split('.').length === 2 && host.split('.')[0].length < 2) continue;
    out.push({ value: raw, start: m.index!, end: m.index! + raw.length });
  }
  return out;
}

export interface PhoneHit {
  value: string;
  start: number;
  end: number;
  label: string | null;
}

/** Phone numbers in a line of text. `addressLike` lines only yield labelled or 10+ digit numbers. */
export function findPhones(text: string, addressLike = false): PhoneHit[] {
  // Parenthesised labels "(M)", "(M2)", "(O)", "(F)" and "0:"/"0." misreads of "O:" become plain labels.
  const t = text
    .replace(/\((M2?|O|0|F|T|C|D|P|H|W)\)/gi, (_, l: string) => ` ${l === '0' ? 'O' : l.replace(/\d/, '')}: `)
    .replace(/(^|\s)0([:.])\s*(?=[(+\d])/g, '$1O$2 ');
  const out: PhoneHit[] = [];
  for (const m of t.matchAll(PHONE_FIND)) {
    let raw = m[0].replace(/[\s\-\/.(]+$/, '');
    if (raw.endsWith(')') && !raw.includes('(')) raw = raw.slice(0, -1);
    const digits = raw.replace(/\D/g, '');
    const before = t.slice(0, m.index!);
    if (/#\s*$|\bno\.?\s*$|\blic(ense)?\.?\s*#?\s*$/i.test(before)) continue; // licence / registration numbers
    const labelWord = before.match(/([A-Za-z]+\d?)\.?\s*[:.]?\s*$/)?.[1];
    // Labels printed after the number ("929.555.0174 Direct") count too, but only full words.
    const after = t.slice(m.index! + m[0].length).match(/^\s*\(?(mobile|mob|cell|direct|office|main|fax|work|home|whatsapp)\b/i)?.[1];
    const label = phoneLabel(labelWord?.replace(/\d$/, '')) ?? (/24\s?hr\s*[:.]?\s*$/i.test(before) ? 'office' : null) ?? phoneLabel(after);
    const core = raw.replace(/\s*(?:ext\.?|x)\s*\d{1,5}$/i, '').replace(/\D/g, '');
    const min = label ? 6 : 7;
    if (core.length < min || core.length > 15) continue;
    if (/^\d{5}-\d{4}$/.test(raw.trim())) continue; // US ZIP+4
    if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(raw.trim())) continue; // dates
    if (!label && /^\d{4,6}$/.test(raw.trim())) continue;
    if (addressLike && !label && core.length < 10) continue;
    void digits;
    out.push({ value: raw.trim(), start: m.index!, end: m.index! + m[0].length, label });
  }
  return out;
}

function phoneKey(v: string) {
  const ext = v.match(/(?:ext\.?|x)\s*(\d{1,5})$/i)?.[1] ?? '';
  return normalizePhone(v.replace(/\s*(?:ext\.?|x)\s*\d{1,5}$/i, '')) + (ext ? `x${ext}` : '');
}

// ---------- scoring helpers ----------

function words(s: string): string[] {
  return s.split(/[\s,]+/).filter(Boolean);
}

const C_SUITE = /\b(ceo|cto|cfo|coo|cmo|cio|ciso|cso|cdo|cro|cpo|cco|cao|chro|cno|vp|svp|evp|avp|md|gm)\b/i;

function titleScore(s: string): number {
  const ws = words(s.toLowerCase().replace(/[&/|\-–]/g, ' '));
  let score = 0;
  for (const w of ws) {
    const clean = w.replace(/[^a-z\-.]/g, '');
    if (TITLE_WORDS.has(clean) || TITLE_WORDS.has(clean.replace(/s$/, ''))) score += 2;
    else if (TITLE_MODIFIERS.has(clean)) score += 0.4;
  }
  if (C_SUITE.test(s)) score += 2.5;
  if (/\d/.test(s)) score -= 2;
  if (ws.length > 7) score -= 1.5;
  // Taglines speak to the reader ("Your trusted ... partner").
  if (/\b(your|our|we|you|us)\b/i.test(s)) score -= 3;
  return score;
}

function domainLabels(domains: string[]): string[] {
  const labels = new Set<string>();
  for (const d of domains) {
    const host = normalizeWebsite(d).split('/')[0];
    const parts = host.split('.');
    let core = parts.slice(0, -1);
    if (core.length > 1 && /^(co|com|org|net|ac|gov)$/.test(core[core.length - 1])) core = core.slice(0, -1);
    const main = core[core.length - 1];
    if (main && !/^(gmail|googlemail|yahoo|hotmail|outlook|icloud|me|live|aol|proton|protonmail|msn|mail|gmx|qq|163|yandex|comcast|verizon|att)$/.test(main))
      labels.add(main.replace(/-/g, ''));
  }
  return [...labels];
}

/** Letters appear in order in the label, starting with its first letter ("GBC" in "greenbanyanconsulting"). */
function acronymOf(acr: string, label: string): boolean {
  const a = acr.toLowerCase();
  if (a.length < 2 || a.length > 5 || a[0] !== label[0]) return false;
  let i = 0;
  for (const ch of label) if (ch === a[i]) i++;
  return i === a.length;
}

/** 0..1: how much of the domain label is spelled by the segment's words. */
const unconfuse = (s: string) => s.replace(/[l1|]/g, 'i').replace(/0/g, 'o').replace(/rn/g, 'm');

function domainMatch(s: string, rawLabels: string[]): number {
  const labels = rawLabels.map(unconfuse);
  const ws = words(fold(s))
    .map((w) => unconfuse(w.replace(/[^a-z0-9]/g, '')))
    .filter((w) => w.length > 0);
  if (!ws.length) return 0;
  let best = 0;
  for (const label of labels) {
    if (label.length < 2) continue;
    let covered = 0,
      used = 0;
    for (const w of ws) {
      if (w.length >= 3 && label.includes(w)) {
        covered += w.length;
        used++;
      } else if (w.length >= 4 && label.includes(w.slice(0, 4))) {
        covered += 4;
        used++;
      }
    }
    const joined = ws.join('');
    if (joined.length >= 3 && label.includes(joined)) covered = Math.max(covered, joined.length);
    let frac = Math.min(1, covered / label.length);
    const wordFrac = used / ws.length;
    let score = frac * 0.7 + wordFrac * 0.3 * (frac > 0 ? 1 : 0);
    if (ws.length === 1 && /^[A-Z0-9]{2,5}$/.test(s.trim()) && acronymOf(ws[0], label)) score = Math.max(score, 0.6);
    // initials of the words spell the label ("Riverside Energy Partners" -> rep)
    const initials = ws.map((w) => w[0]).join('');
    if (initials.length >= 2 && label.startsWith(initials)) score = Math.max(score, 0.5);
    frac = score;
    best = Math.max(best, frac);
  }
  return best;
}

const NAME_TOKEN =
  /^(?:[\p{Lu}][\p{L}'’\-]*\.?|[\p{Lu}]\.?|\([\p{Lu}][\p{L}'’\-]*\)|(?:de|da|del|della|di|van|von|der|den|la|le|du|bin|bint|al|el|ibn|dos|das|ter|ten|y)|[\p{Lu}][\p{Ll}]+[\p{Lu}][\p{L}'’\-]*)$/u;

function nameShape(s: string): number {
  const ws = s.split(/\s+/).filter(Boolean);
  if (/\d|@|\.(com|net|org)\b|[|•]/i.test(s)) return -5;
  if (!ws.length || ws.length > 5) return -2;
  const ok = ws.filter((w) => NAME_TOKEN.test(w.replace(/,$/, ''))).length;
  if (ok < ws.length) return ok === ws.length - 1 && ws.length >= 3 ? 0.5 : -1.5;
  const realWords = ws.filter((w) => w.replace(/[^\p{L}]/gu, '').length >= 2).length;
  // Business vocabulary ("High-end Residential", "Energy Services") is not a person's name.
  const vocab = ws.filter((w) => NON_NAME_WORDS.has(fold(w).replace(/[^a-z]/g, '')) || NON_NAME_WORDS.has(fold(w).split('-')[0])).length;
  if (vocab) return vocab >= Math.ceil(ws.length / 2) ? -3 : -1;
  if (ws.length === 1) return realWords ? 0.2 : -2;
  return realWords >= 1 ? 2 : 0.5;
}

/** How well a name matches personal e-mail local parts (strong evidence). */
function emailNameMatch(name: string, locals: string[]): number {
  const toks = fold(name)
    .split(/[\s\-.'’()]+/)
    .map((t) => t.replace(/[^a-z]/g, ''))
    .filter(Boolean);
  if (!toks.length) return 0;
  let best = 0;
  for (const local of locals) {
    const l = local.toLowerCase().replace(/\d+/g, '');
    const parts = l.split(/[._\-+]+/).filter(Boolean);
    const flat = l.replace(/[^a-z]/g, '');
    let s = 0;
    for (const t of toks) if (t.length >= 3 && (parts.includes(t) || flat.includes(t))) s += 2;
    const initials = toks.map((t) => t[0]).join('');
    const first = toks[0],
      last = toks[toks.length - 1];
    if (
      toks.length >= 2 &&
      (flat === first[0] + last || flat === first + last[0] || flat === initials || flat === first + last || flat === first[0] + toks[1]?.[0] + last)
    )
      s += 2.5;
    if (toks.length >= 2 && flat.length >= 2 && (flat === initials || flat === initials.slice(0, -1))) s += 1.5;
    best = Math.max(best, s);
  }
  return Math.min(best, 4.5);
}

function addressScore(s: string): number {
  let score = 0;
  if ((s.match(/\b[A-Z]{2}\b/g) ?? []).length >= 4) return -2; // "AL, AZ, CO, CT, ..." service-area lists
  const hasDigit = /\d/.test(s);
  if (ADDRESS_WORDS_RE.test(s)) score += hasDigit ? 2 : 1;
  if (POSTCODE_RES.some((re) => re.test(s)) || /[A-Z]{2}\s?\d{5}(-\d{4})?\b/.test(s)) score += 1.5;
  if (COUNTRIES_RE.test(s)) score += 1.5;
  if (cityStateLine(s)) score += 2;
  if (/^\d+[A-Za-z]?(-\d+)?\s+\p{L}/u.test(s)) score += 1;
  if (/,/.test(s) && hasDigit) score += 0.5;
  if (titleScore(s) >= 2) score -= 2;
  if (words(s).length <= 1 && !hasDigit) score -= 1;
  return score;
}

function verticalNeighbours(a: Box, b: Box, slack = 1.1): boolean {
  const gap = b.y - (a.y + a.h);
  const h = Math.min(a.h, b.h);
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const leftAligned = Math.abs(a.x - b.x) < h * 1.2;
  const rightAligned = Math.abs(a.x + a.w - (b.x + b.w)) < h * 1.2;
  const centred = Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < h * 1.5;
  return gap > -h * 0.75 && gap < h * slack && (xOverlap > 0 || leftAligned) && (leftAligned || rightAligned || centred);
}

/** b is directly above or below the block (union box), allowing overlapping detection boxes. */
function stackedOn(block: Box, b: Box, slack = 1.1): boolean {
  return verticalNeighbours(block, b, slack) || verticalNeighbours(b, block, slack);
}

function sameRow(a: Box, b: Box): boolean {
  const ca = a.y + a.h / 2,
    cb = b.y + b.h / 2;
  return Math.abs(ca - cb) < 0.3 * Math.min(a.h, b.h);
}

const SMALL_PRINT = 'The print is very small in this photo — check it, or rescan with a closer photo.';

/** Height of the text box in the ORIGINAL photo, in pixels. Below ~22 px, letters are only a few pixels tall. */
function smallPrint(segs: Segment[]): string | null {
  if (!(currentScale > 0) || !segs.length) return null;
  const srcH = Math.min(...segs.map((s) => s.box.h)) / currentScale;
  const conf = Math.min(...segs.map((s) => s.conf));
  return srcH < 17 || (srcH < 22 && conf < 0.95) ? SMALL_PRINT : null;
}

function meta(segs: Segment[], extra: Partial<FieldMeta> = {}): FieldMeta {
  const reasons: string[] = [...(extra.reasons ?? [])];
  const conf = segs.length ? Math.min(...segs.map((s) => s.conf)) : undefined;
  let state: FieldMeta['state'] = extra.state ?? 'extracted';
  const disputed = segs.filter((s) => s.disputed);
  if (disputed.length) {
    state = 'needs_review';
    for (const d of disputed) {
      const alts = d.alternatives.filter((a) => a !== d.text);
      reasons.push(
        alts.length ? `The two recognition models read this differently (also: “${alts.slice(0, 2).join('” / “')}”).` : 'The recognition models disagreed.',
      );
    }
  }
  if (conf !== undefined && conf < LOW_CONF) {
    state = 'needs_review';
    reasons.push('Low recognition confidence — check against the photo.');
  }
  const small = smallPrint(segs);
  if (small) {
    state = 'needs_review';
    reasons.push(small);
  }
  return {
    source: 'ocr',
    confidence: conf !== undefined ? Number(conf.toFixed(3)) : undefined,
    lineIds: [...new Set(segs.flatMap((s) => s.lineIds))],
    box: segs.length ? unionBox(segs.map((s) => s.box)) : undefined,
    ...extra,
    state,
    reasons: reasons.length ? [...new Set(reasons)] : undefined,
  };
}

// ---------- QR payloads ----------

interface QrData {
  name?: string;
  org?: string;
  title?: string;
  emails: string[];
  phones: { value: string; label: string }[];
  urls: string[];
  address?: string;
}

export function parseQr(payload: string): QrData {
  const d: QrData = { emails: [], phones: [], urls: [] };
  const text = payload.replace(/\r\n[ \t]/g, '').replace(/\r/g, '');
  const unesc = (v: string) =>
    v
      .replace(/\\n/gi, ', ')
      .replace(/\\([,;:\\])/g, '$1')
      .trim();
  if (/^BEGIN:VCARD/i.test(text)) {
    for (const line of text.split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).toUpperCase();
      const val = line.slice(idx + 1);
      const prop = key.split(';')[0].replace(/^ITEM\d+\./, '');
      if (!unesc(val).replace(/[;,\s]/g, '')) continue;
      if (prop === 'FN') d.name = unesc(val);
      else if (prop === 'N' && !d.name) {
        const [last, first, middle] = val.split(';').map(unesc);
        d.name = [first, middle, last].filter(Boolean).join(' ');
      } else if (prop === 'ORG') d.org = unesc(val.split(';').filter(Boolean).join(' '));
      else if (prop === 'TITLE') d.title = unesc(val);
      else if (prop === 'EMAIL') d.emails.push(unesc(val));
      else if (prop === 'TEL') {
        const t = key.toLowerCase();
        const label = /cell|mobile/.test(t) ? 'mobile' : /fax/.test(t) ? 'fax' : /home/.test(t) ? 'home' : 'office';
        d.phones.push({ value: unesc(val).replace(/^tel:/i, ''), label });
      } else if (prop === 'URL') d.urls.push(unesc(val));
      else if (prop === 'ADR') d.address = val.split(';').map(unesc).filter(Boolean).join(', ');
    }
  } else if (/^MECARD:/i.test(text)) {
    for (const part of text.slice(7).split(/(?<!\\);/)) {
      const [k, ...rest] = part.split(':');
      const v = unesc(rest.join(':'));
      if (!v) continue;
      if (k === 'N') d.name = v.includes(',') ? v.split(',').reverse().join(' ').trim() : v;
      else if (k === 'ORG') d.org = v;
      else if (k === 'TEL') d.phones.push({ value: v, label: 'phone' });
      else if (k === 'EMAIL') d.emails.push(v);
      else if (k === 'URL') d.urls.push(v);
      else if (k === 'ADR') d.address = v;
    }
  } else if (/^mailto:/i.test(text)) d.emails.push(text.slice(7).split('?')[0]);
  else if (/^tel:/i.test(text)) d.phones.push({ value: text.slice(4), label: 'phone' });
  else if (/^(https?:\/\/|www\.)/i.test(text.trim())) d.urls.push(text.trim());
  d.emails = d.emails.filter(isValidEmailSyntax);
  return d;
}

const LINKEDIN_PROFILE_RE = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%\p{L}]+\/?/iu;

export function canonicalLinkedIn(url: string): string {
  const m = url.match(LINKEDIN_PROFILE_RE);
  if (!m) return '';
  const slug = m[0].replace(/\/$/, '').split('/in/')[1];
  return `https://www.linkedin.com/in/${slug}`;
}

// ---------- evidence helpers ----------

function similarity(a: string, b: string): number {
  const x = a.toLowerCase(),
    y = b.toLowerCase();
  if (!x.length || !y.length) return 0;
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...new Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
  return 1 - dp[x.length][y.length] / Math.max(x.length, y.length);
}

/**
 * Evidence for a reading: the longest run (4+ chars) of it that is printed on another line of the card.
 * A run must sit inside one printed word, or cover whole words ("WHITFIELD & CRANE" -> "whitfieldcrane");
 * runs that start or end mid-word ("solution|s energy|" -> "senergy") do not count.
 */
function corroboration(value: string, otherText: string): { score: number; word?: string } {
  const wordsList = fold(otherText)
    .split(/[^a-z0-9]+/)
    .map((w) => unconfuse(w))
    .filter(Boolean);
  const joined = wordsList.join('');
  const starts = new Set<number>(),
    ends = new Set<number>();
  let pos = 0;
  for (const w of wordsList) {
    starts.add(pos);
    pos += w.length;
    ends.add(pos);
  }
  const ok = (sub: string) => {
    if (wordsList.some((w) => w.includes(sub))) return true;
    for (let i = joined.indexOf(sub); i >= 0; i = joined.indexOf(sub, i + 1)) if (starts.has(i) && ends.has(i + sub.length)) return true;
    return false;
  };
  const toks = unconfuse(value.toLowerCase())
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[@._\-+/]/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length >= 4);
  let score = 0;
  let word: string | undefined;
  for (const t of toks) {
    let bestSub = '';
    for (let i = 0; i < t.length && t.length - i > bestSub.length; i++)
      for (let j = t.length; j - i >= 4 && j - i > bestSub.length; j--) {
        const sub = t.slice(i, j);
        if (ok(sub)) {
          bestSub = sub;
          break;
        }
      }
    if (bestSub) {
      score += bestSub.length;
      if (!word || bestSub.length > word.length) word = bestSub;
    }
  }
  return { score, word };
}

/** Variants of a token with visually confusable characters swapped (l/1/i/I, 0/o, rn/m). Bounded. */
function confusableVariants(s: string, limit = 64): string[] {
  const swaps: [RegExp, string[]][] = [
    [/[l1iI|]/g, ['l', '1', 'i']],
    [/[0oO]/g, ['0', 'o']],
  ];
  let out = new Set([s]);
  for (const [re, alts] of swaps) {
    const next = new Set<string>();
    for (const v of out) {
      const positions = [...v.matchAll(re)].map((m) => m.index!);
      if (positions.length > 6) {
        next.add(v);
        continue;
      }
      let acc = [v];
      for (const p of positions) {
        const grown: string[] = [];
        for (const a of acc) for (const r of alts) grown.push(a.slice(0, p) + r + a.slice(p + 1));
        acc = [...new Set(grown)].slice(0, limit);
      }
      acc.forEach((x) => next.add(x));
    }
    out = new Set([...next].slice(0, limit));
  }
  for (const v of [...out]) if (v.includes('rn')) out.add(v.replace(/rn/g, 'm'));
  return [...out];
}

interface Voted {
  value: string;
  alternatives: string[];
  disputed: boolean;
  resolvedBy?: string;
}

/**
 * Decide between the candidate values found in each reading of the same line.
 * `key` normalises for comparison, `valid` checks format plausibility.
 */
function vote(
  cands: { value: string; source: string }[],
  key: (v: string) => string,
  valid: (v: string) => boolean,
  otherText: string,
  allowConfusables: boolean,
): Voted | null {
  if (!cands.length) return null;
  const groups = new Map<string, { value: string; source: string }[]>();
  for (const c of cands) groups.set(key(c.value), [...(groups.get(key(c.value)) ?? []), c]);
  const weight = (src: string) => (src.endsWith('-upscaled') ? 0.5 : 1);
  const scored = [...groups.entries()].map(([k, g]) => {
    const votes = g.reduce((s, c) => s + weight(c.source), 0);
    const corr = corroboration(g[0].value, otherText);
    return { k, g, votes, valid: valid(g[0].value), corr };
  });
  // 1. Corroboration by text printed elsewhere on the card is the strongest evidence.
  // 2. Then format validity, then votes.
  scored.sort((a, b) => Number(b.valid) - Number(a.valid) || b.corr.score - a.corr.score || b.votes - a.votes);
  const best = scored[0];
  let value = best.g.sort((a, b) => b.value.replace(/[^\s().\-]/g, '').length - a.value.replace(/[^\s().\-]/g, '').length)[0].value;
  const alternatives = scored
    .slice(1)
    .filter((s) => s.valid)
    .map((s) => s.g[0].value);
  const independent = new Set(best.g.map((c) => c.source.replace(/-upscaled$/, ''))).size;
  let disputed = scored.length > 1 && alternatives.length > 0 && independent < 2;
  let resolvedBy: string | undefined;
  if (disputed && best.corr.score > 0 && scored.slice(1).every((s) => s.corr.score < best.corr.score)) {
    disputed = false;
    resolvedBy = best.corr.word;
  }
  // Confusable characters with corroboration elsewhere on the card ("tidelot" vs website "tideiot").
  if (allowConfusables) {
    const base = corroboration(value, otherText).score;
    let improved: { v: string; score: number; word?: string } | null = null;
    for (const v of confusableVariants(value)) {
      if (v === value || !valid(v)) continue;
      const c = corroboration(v, otherText);
      if (c.score > base + 1 && (!improved || c.score > improved.score)) improved = { v, score: c.score, word: c.word };
    }
    if (improved && !best.corr.score) {
      // Only when nothing on the card supports the current spelling: offer the look-alike variant, flagged.
      alternatives.unshift(improved.v);
      disputed = true;
    }
  }
  return { value, alternatives: [...new Set(alternatives.filter((a) => key(a) !== key(value)))], disputed, resolvedBy };
}

// ---------- main ----------

export function extractFields(input: ExtractInput): Extraction {
  currentScale = input.scale ?? 0;
  const roles: Record<string, string> = {};
  const emailItems: (Voted & { seg: Segment })[] = [];
  const phoneItems: (Voted & { label: string | null; seg: Segment })[] = [];
  const urlItems: (Voted & { seg: Segment })[] = [];
  let linkedinFromCard: { url: string; seg: Segment } | null = null;
  let textSegs: Segment[] = [];

  const lineText = new Map(input.lines.map((l) => [l.id, l.text]));
  const textExcept = (id: string) =>
    input.lines
      .filter((l) => l.id !== id)
      .flatMap((l) => [l.text, ...l.readings.map((r) => r.text)])
      .join(' \n ');

  for (const line of input.lines) {
    const isList =
      (line.text.match(/[|│¦]/g)?.length ?? 0) >= 1 ||
      line.readings.some((r) => /^\s*([•·▪●◆*-]\s*|\.(?=\p{Lu}))\p{L}/u.test(r.text) || (r.text.match(/\s[•·]\s?\p{L}/gu)?.length ?? 0) >= 1);
    let text = line.text
      .replace(/\s*[|│¦•·▪●◆]\s*/g, ' | ')
      .replace(/\s+/g, ' ')
      .trim();
    text = text.replace(/^[^\p{L}\p{N}+(]+/u, '');
    const altTexts = [...new Set(line.readings.map((r) => r.text.trim()).filter((t) => t && t !== line.text))];
    const base: Omit<Segment, 'text'> = { lineIds: [line.id], box: line.box, conf: line.confidence, disputed: line.disputed, alternatives: altTexts, isList };
    const others = textExcept(line.id);
    const sources = [{ text, source: 'chosen' }, ...line.readings.map((r) => ({ text: r.text.replace(/\s*[|•·]\s*/g, ' | '), source: r.source }))];

    // ----- e-mails (voted across readings) -----
    const emails = findEmails(text);
    for (const e of emails) {
      const cands = sources.flatMap((s) =>
        findEmails(s.text)
          .filter((x) => similarity(x.value, e.value) > 0.6)
          .map((x) => ({ value: x.value, source: s.source === 'chosen' ? 'chosen' : s.source })),
      );
      // Readings that see an "@" but produce no valid address (e.g. missing dot) count as weak dissent only.
      const v = vote(
        cands.filter((c) => c.source !== 'chosen').length ? cands.filter((c) => c.source !== 'chosen') : cands,
        normalizeEmail,
        (x) => isValidEmailSyntax(x) && /\.[a-z]{2,24}$/i.test(x),
        others,
        true,
      )!;
      // Any reading that saw an "@" here but spelled something else is dissent, even if it is not a valid address.
      const dissent = line.readings.some((r) => /@/.test(r.text) && !lettersOnly(r.text).includes(lettersOnly(v.value)));
      if (dissent && !v.resolvedBy && !v.disputed) {
        v.disputed = true;
        const other = line.readings.find((r) => /@/.test(r.text) && !lettersOnly(r.text).includes(lettersOnly(v.value)));
        if (other) v.alternatives = [...v.alternatives, (other.text.match(/\S*@\S*/)?.[0] ?? other.text).replace(/^[^A-Za-z0-9]+/, '')];
      }
      emailItems.push({ ...v, seg: { ...base, text: v.value } });
    }
    // An e-mail missing in the chosen reading but present in another reading (e.g. a dropped dot).
    if (!emails.length && /@/.test(line.readings.map((r) => r.text).join(' '))) {
      const cands = line.readings.flatMap((r) => findEmails(r.text).map((x) => ({ value: x.value, source: r.source })));
      if (cands.length) {
        const v = vote(cands, normalizeEmail, (x) => isValidEmailSyntax(x), others, true)!;
        const onlyOne = new Set(cands.map((c) => c.source.replace(/-upscaled$/, ''))).size < 2;
        emailItems.push({ ...v, disputed: v.disputed || (onlyOne && !v.resolvedBy), seg: { ...base, text: v.value } });
      }
    }
    let rest = text;
    for (const e of [...emails].reverse()) rest = rest.slice(0, e.start) + ' | ' + rest.slice(e.end);
    if (!emails.length && /@/.test(rest)) rest = rest.replace(/\S*@\S*/g, ' | ');

    // ----- websites / LinkedIn -----
    const urls = findUrls(rest);
    for (const u of urls) {
      const cands = sources.flatMap((s) => {
        let rt = s.text;
        for (const e of findEmails(rt).reverse()) rt = rt.slice(0, e.start) + ' ' + rt.slice(e.end);
        return findUrls(rt)
          .filter((x) => similarity(x.value, u.value) > 0.6)
          .map((x) => ({ value: x.value, source: s.source }));
      });
      const real = cands.filter((c) => c.source !== 'chosen');
      const v = vote(real.length ? real : cands, normalizeWebsite, (x) => hasKnownTld(normalizeWebsite(x).split('/')[0]), others, true)!;
      const seg: Segment = { ...base, text: v.value };
      if (LINKEDIN_PROFILE_RE.test(v.value)) linkedinFromCard ??= { url: canonicalLinkedIn(v.value), seg };
      else urlItems.push({ ...v, seg });
    }
    for (const u of [...urls].reverse()) rest = rest.slice(0, u.start) + ' | ' + rest.slice(u.end);

    // ----- phones (voted across readings, compared by digits) -----
    const addrLike = addressScore(rest) >= 2;
    const phones = findPhones(rest, addrLike);
    const readingPhones = line.readings.map((r) => ({ source: r.source, hits: findPhones(r.text, addrLike) }));
    for (const p of phones) {
      const k = phoneKey(p.value);
      const cands = [{ value: p.value, source: 'chosen' }];
      for (const rp of readingPhones) {
        const close = rp.hits.map((h) => h.value).sort((a, b) => similarity(phoneKey(b), k) - similarity(phoneKey(a), k))[0];
        if (close && similarity(phoneKey(close), k) > 0.6) cands.push({ value: close, source: rp.source });
      }
      const real = cands.filter((c) => c.source !== 'chosen');
      const v = vote(real.length ? real : cands, phoneKey, (x) => phoneKey(x).replace(/\D/g, '').length >= 7, '', false)!;
      phoneItems.push({ ...v, label: p.label, seg: { ...base, text: v.value } });
    }
    for (const p of [...phones].reverse()) rest = rest.slice(0, p.start) + ' | ' + rest.slice(p.end);

    if (emails.length || urls.length || phones.length) roles[line.id] = 'contact';

    // ----- remaining text pieces (labels removed) -----
    const pieces = rest.split('|');
    for (let piece of pieces) {
      piece = piece.trim();
      // letter-spaced words: "T H E" -> "THE"
      if (/^(\p{L} ){2,}\p{L}$/u.test(piece)) piece = piece.replace(/ /g, '');
      else piece = piece.replace(TRAILING_LABEL_RE, '');
      piece = piece
        .replace(LEADING_LABEL_RE, '')
        .replace(/^\s*[:\-–,]\s*/, '')
        .replace(/\s*[:\-–,]\s*$/, '')
        .trim();
      if (piece.replace(/[^\p{L}]/gu, '').length < 2) continue;
      if (/^(mobile|office|direct|cell|fax|main|tel|phone|email)$/i.test(piece)) continue;
      textSegs.push({ ...base, text: piece, isList: base.isList || pieces.filter((x) => x.replace(/[^\p{L}]/gu, '').length >= 2).length >= 3 });
    }
  }

  // Drop faint specks/handwriting fragments: very low confidence, short.
  textSegs = textSegs.filter((s) => !(s.conf < 0.7 && s.text.length <= 4));

  // ----- same-row merge: words of one line split by the detector ("Claudia" + "Fernandez", "spring" + "bank") -----
  textSegs.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  for (let changed = true; changed;) {
    changed = false;
    outer: for (const a of textSegs)
      for (const b of textSegs) {
        if (a === b || a.isList || b.isList) continue;
        if (!sameRow(a.box, b.box) || b.box.x <= a.box.x) continue;
        const h = Math.min(a.box.h, b.box.h);
        if (Math.min(a.box.h, b.box.h) / Math.max(a.box.h, b.box.h) < 0.7) continue;
        const gap = b.box.x - (a.box.x + a.box.w);
        if (gap > h * 0.5) continue;
        if (words(a.text).length + words(b.text).length > 5) continue;
        // An acronym logo beside its wordmark ("SIR" + "SetItRight") is not one phrase.
        const acr = (x: string) => /^[A-Z0-9]{2,5}$/.test(x);
        if ((acr(a.text) && /\p{Ll}/u.test(b.text)) || (acr(b.text) && /\p{Ll}/u.test(a.text))) continue;
        const merged: Segment = {
          lineIds: [...a.lineIds, ...b.lineIds],
          text: `${a.text} ${b.text}`,
          box: unionBox([a.box, b.box]),
          conf: Math.min(a.conf, b.conf),
          disputed: a.disputed || b.disputed,
          alternatives: [],
          isList: false,
        };
        textSegs = textSegs.filter((s) => s !== a && s !== b);
        textSegs.push(merged);
        changed = true;
        break outer;
      }
  }

  // ----- address -----
  const preLocals = emailItems.map((e) => e.value.split('@')[0]).filter((l) => !GENERIC_EMAIL_LOCALS.test(l));
  const addrScore = new Map(
    textSegs.map((s) => [s, (s.isList && !cityStateLine(s.text)) || emailNameMatch(splitCredentials(s.text).name, preLocals) >= 2 ? -1 : addressScore(s.text)]),
  );
  const addrLines = new Set(textSegs.filter((s) => addrScore.get(s)! >= 2));
  for (let grew = true; grew;) {
    grew = false;
    for (const s of textSegs) {
      if (addrLines.has(s) || addrScore.get(s)! < 1 || titleScore(s.text) >= 2) continue;
      if (
        [...addrLines].some(
          (a) =>
            stackedOn(a.box, s.box) ||
            a.lineIds.some((id) => s.lineIds.includes(id)) ||
            (sameRow(a.box, s.box) && Math.abs(a.box.x + a.box.w - s.box.x) < s.box.h * 3),
        )
      ) {
        addrLines.add(s);
        grew = true;
      }
    }
  }
  const sortedAddr = [...addrLines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const blocks: Segment[][] = [];
  for (const s of sortedAddr) {
    const blk = blocks.find((b) => {
      const ub = unionBox(b.map((x) => x.box));
      return (
        stackedOn(ub, s.box) ||
        b.some((x) => x.lineIds.some((id) => s.lineIds.includes(id)) || (sameRow(x.box, s.box) && Math.abs(x.box.x + x.box.w - s.box.x) < s.box.h * 3))
      );
    });
    if (blk) blk.push(s);
    else blocks.push([s]);
  }
  const blockScore = (b: Segment[]) => b.reduce((a, s) => a + addrScore.get(s)!, 0);
  blocks.sort((a, b) => blockScore(b) - blockScore(a));
  const addrBlock = (blocks[0] ?? []).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const usedAddr = new Set(addrBlock);
  for (const b of blocks.slice(1)) if (blockScore(b) >= 3) for (const s of b) usedAddr.add(s);

  // ----- name / title / company -----
  const emailLocals = emailItems.map((e) => e.value.split('@')[0]).filter((l) => !GENERIC_EMAIL_LOCALS.test(l));
  const labels = domainLabels([...emailItems.map((e) => e.value.split('@')[1]), ...urlItems.map((u) => u.value)]);
  let pool = textSegs.filter((s) => !usedAddr.has(s) || /[A-Z]{2,}\s+(Inc|LLC|Ltd)\.?$/.test(s.text));
  const heights = input.lines.map((l) => l.box.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 1;

  // Stacked single-word name candidates ("MILO" / "KASPER", "Anya" / "Volkova").
  const singles = pool.filter((s) => !s.isList && /^[\p{Lu}][\p{L}'’\-]+$/u.test(s.text) && nameShape(s.text) >= 0);
  for (const a of singles)
    for (const b of singles) {
      if (a === b || b.box.y <= a.box.y) continue;
      if (Math.min(a.box.h, b.box.h) / Math.max(a.box.h, b.box.h) < 0.75) continue;
      if (!verticalNeighbours(a.box, b.box, 0.9) || Math.abs(a.box.x - b.box.x) > Math.min(a.box.h, b.box.h) * 1.2) continue;
      pool.push({
        lineIds: [...a.lineIds, ...b.lineIds],
        text: `${a.text} ${b.text}`,
        box: unionBox([a.box, b.box]),
        conf: Math.min(a.conf, b.conf),
        disputed: a.disputed || b.disputed,
        alternatives: [],
        isList: false,
        rows: 2,
      });
    }

  const scoreSeg = (s: Segment) => {
    const { name: bare } = splitCredentials(s.text);
    const t = titleScore(s.text);
    const dm = domainMatch(s.text, labels);
    const suffix = COMPANY_SUFFIX_RE.test(s.text) ? 1 : 0;
    const rel = lineH(s) / medianH;
    const shape = nameShape(bare);
    const em = emailNameMatch(bare, emailLocals);
    const initials = /(^|\s)\p{Lu}\.(\s|$)/u.test(bare) ? 0.6 : 0;
    let name = shape + em + initials + (rel > 1.15 ? 0.8 : rel < 0.85 ? -0.5 : 0) - (t >= 2 ? 2.5 : 0) - suffix * 2;
    name -= shape >= 2 ? Math.min(1, dm * 1.2) : dm > 0.5 ? 2.5 : dm * 2;
    if (/^[\p{Ll}]/u.test(bare)) name -= 1.5;
    if (s.isList) name -= 4;
    if (s.conf < 0.8) name -= 1;
    let company = suffix * 2 + dm * 4 + (rel > 1.2 ? 0.5 : 0) - (t >= 2 ? 1.5 : 0) - (em >= 2 ? 3 : 0) - (s.isList ? 3 : 0);
    // Wordmark: one or two capitalised words in a large font.
    if (
      rel > 1.3 &&
      words(s.text).length <= 2 &&
      /^[\p{Lu}0-9&][\p{L}0-9&'’.-]*( [\p{Lu}0-9&][\p{L}0-9&'’.-]*)?$/u.test(s.text) &&
      shapeIsNotPerson(s.text, emailLocals)
    )
      company += 1;
    if (words(s.text).length > 6) company -= 2;
    // Sentence-like taglines ("Essential building systems — flagged, funded, fixed.")
    const lowerWords = words(s.text).filter((w) => /^\p{Ll}/u.test(w)).length;
    if (lowerWords >= 2 && lowerWords >= words(s.text).length / 2) company -= 2.5;
    if (/\b(your|our|we)\b/i.test(s.text)) company -= 3;
    if (s.conf < 0.8) company -= 1;
    return { s, t: s.isList ? t - 3 : t, name, company, em, dm };
  };
  const scored = pool.map(scoreSeg);

  const titleCand = scored.filter((x) => x.t >= 2 && x.em < 2).sort((a, b) => b.t - a.t);
  for (const x of scored)
    if (
      titleCand
        .slice(0, 3)
        .some((tc) => tc.s !== x.s && !overlaps(tc.s, x.s) && (verticalNeighbours(x.s.box, tc.s.box, 1.6) || verticalNeighbours(tc.s.box, x.s.box, 1.6)))
    )
      x.name += 1.2;
  const nameCand = scored.filter((x) => x.name >= 1.5).sort((a, b) => b.name - a.name);
  const nameSeg = nameCand[0];

  // Title: prefer one next to the chosen name.
  let titleSegs: Segment[] = [];
  const titleOptions = titleCand
    .filter((c) => !nameSeg || !overlaps(c.s, nameSeg.s))
    .map((c) => ({ c, near: nameSeg && (verticalNeighbours(nameSeg.s.box, c.s.box, 2.5) || verticalNeighbours(c.s.box, nameSeg.s.box, 2.5)) ? 1.5 : 0 }))
    .sort((a, b) => b.c.t + b.near - (a.c.t + a.near));
  const titleBest = titleOptions[0]?.c;
  if (titleBest) {
    titleSegs = [titleBest.s];
    const free = (x: (typeof scored)[number]) =>
      !titleSegs.includes(x.s) && (!nameSeg || !overlaps(x.s, nameSeg.s)) && x.dm < 0.4 && x.em < 1 && !x.s.isList && !usedAddr.has(x.s);
    // continuation below ("Vice President of" / "Project Development")
    const last = () => titleSegs[titleSegs.length - 1];
    const below = scored.find(
      (x) =>
        free(x) &&
        verticalNeighbours(last().box, x.s.box) &&
        Math.min(x.s.box.h, last().box.h) / Math.max(x.s.box.h, last().box.h) > 0.75 &&
        (x.t >= 0.4 || /[,&\-/]$|\b(of|for|and|to|in|&)$/i.test(last().text) || /^[\p{Ll}&]/u.test(x.s.text)) &&
        !COMPANY_SUFFIX_RE.test(x.s.text),
    );
    if (below) titleSegs.push(below.s);
    // continuation above ("STRATEGIC SALES" / "DIRECTOR")
    const above = scored.find(
      (x) =>
        free(x) &&
        verticalNeighbours(x.s.box, titleSegs[0].box) &&
        Math.min(x.s.box.h, titleSegs[0].box.h) / Math.max(x.s.box.h, titleSegs[0].box.h) > 0.75 &&
        x.t >= 0.4 &&
        x.t < 2 &&
        nameShape(x.s.text) < 2,
    );
    if (above) titleSegs.unshift(above.s);
  }
  const taken = new Set<Segment>([...(nameSeg ? [nameSeg.s] : []), ...titleSegs]);
  const isTaken = (s: Segment) => [...taken].some((t) => overlaps(t, s));

  // Company: best scoring line, then grow into stacked logo lines.
  const compCand = scored.filter((x) => !isTaken(x.s) && (x.company >= 1.5 || (x.dm > 0.3 && x.company > 0.8))).sort((a, b) => b.company - a.company);
  let companySegs: Segment[] = [];
  if (compCand[0]) {
    companySegs = [compCand[0].s];
    const block = () => unionBox(companySegs.map((s) => s.box));
    for (let grew = true; grew && companySegs.length < 4;) {
      grew = false;
      for (const x of scored) {
        if (isTaken(x.s) || companySegs.some((c) => overlaps(c, x.s)) || x.t >= 2 || x.em >= 2 || x.s.isList || usedAddr.has(x.s)) continue;
        if (/\d|@/.test(x.s.text) || words(x.s.text).length > 4) continue;
        const b = block();
        const near = companySegs.find((c) => stackedOn(c.box, x.s.box, 1.2)) ?? (stackedOn(b, x.s.box, 1.2) ? companySegs[0] : undefined);
        if (!near) continue;
        const ratio = Math.min(lineH(near), lineH(x.s)) / Math.max(lineH(near), lineH(x.s));
        const domainWords = x.dm >= 0.3;
        const onlyGeneric = companySegs.every((c) => genericCompanyWords(c.text));
        const logoAbove = x.s.box.y < b.y && words(x.s.text).length === 1 && lineH(x.s) >= lineH(near) * 0.95 && /^[\p{Lu}][\p{Lu}\p{N}&]+$/u.test(x.s.text);
        const cy = x.s.box.y + x.s.box.h / 2;
        const sandwiched = companySegs.some((c) => c.box.y + c.box.h / 2 < cy) && companySegs.some((c) => c.box.y + c.box.h / 2 > cy);
        if (ratio > 0.8 || domainWords || (onlyGeneric && ratio > 0.3) || logoAbove || sandwiched) {
          companySegs.push(x.s);
          grew = true;
        }
      }
    }
    companySegs.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  }

  // ----- build fields -----
  let credentialsField: TextField = notFound();
  const nameField: TextField = nameSeg ? { value: nameSeg.s.text, meta: meta([nameSeg.s]) } : notFound();
  if (nameSeg) {
    const { name, credentials } = splitCredentials(nameSeg.s.text.replace(/\s*,\s*/g, ', ').replace(/,\s*$/, ''));
    nameField.value = name;
    let creds = credentials;
    // credentials wrapped onto the next line ("LEED" / "AP")
    const wrap = textSegs.find((s) => s !== nameSeg.s && verticalNeighbours(nameSeg.s.box, s.box) && s.text.split(/[\s,]+/).every(isCredentialToken));
    if (wrap && creds) {
      creds = `${creds} ${wrap.text}`;
      roles[wrap.lineIds[0]] = 'name';
    }
    if (creds) credentialsField = { value: creds, meta: meta([nameSeg.s]) };
    const reasons = nameField.meta.reasons ?? [];
    const runner = nameCand.find((c) => !overlaps(c.s, nameSeg.s) && !titleSegs.some((t) => overlaps(t, c.s)) && !companySegs.some((t) => overlaps(t, c.s)));
    if (runner && nameSeg.name - runner.name < 0.6 && nameSeg.em < 2) {
      nameField.meta.state = 'needs_review';
      reasons.push(`Not sure which line is the person's name (also possible: “${runner.s.text}”).`);
      nameField.meta.alternatives = [runner.s.text];
    }
    if (/(^|\s)AI(\s|$)/.test(name)) {
      nameField.meta.state = 'needs_review';
      reasons.push('“AI” may be “Al” (capital i and lower-case L look identical in many fonts).');
      nameField.meta.alternatives = [...(nameField.meta.alternatives ?? []), name.replace(/(^|\s)AI(?=\s|$)/g, '$1Al')];
    }
    if (!emailLocals.length && nameSeg.name < 3 && !titleSegs.length) {
      nameField.meta.state = 'needs_review';
      reasons.push('Weak evidence: no matching e-mail or job title next to it.');
    }
    if (nameSeg.s.lineIds.length > 1) reasons.push('Joined from separate words on the card.');
    nameField.meta.reasons = reasons.length ? [...new Set(reasons)] : undefined;
    for (const id of nameSeg.s.lineIds) roles[id] = 'name';
  } else if (pool.length) {
    nameField.meta.reasons = ['No line looked like a person’s name. Some cards (e.g. the back side) show only a company.'];
  }

  const titleField: TextField = titleSegs.length
    ? {
        value: titleSegs
          .map((s) => s.text)
          .join(' ')
          .replace(/\s+/g, ' '),
        meta: meta(titleSegs),
      }
    : notFound();
  titleSegs.forEach((s) => s.lineIds.forEach((id) => (roles[id] = 'title')));

  let companyField: TextField = companySegs.length
    ? { value: companySegs.map((s) => s.text).join(' '), meta: meta(companySegs, companySegs.length > 1 ? { reasons: ['Joined from stacked lines.'] } : {}) }
    : notFound();
  companySegs.forEach((s) => s.lineIds.forEach((id) => (roles[id] = 'company')));
  if (companySegs.length) {
    // l / I confusion corrected with the web domain ("SetltRight" + setitright.com -> "SetItRight").
    const fixed = fixWithDomain(companyField.value, labels);
    if (fixed && fixed !== companyField.value) {
      companyField.meta.alternatives = [companyField.value];
      companyField.meta.reasons = [...(companyField.meta.reasons ?? []), `Corrected a look-alike letter using the web address (${labels.join(', ')}).`];
      companyField.value = fixed;
    }
    if (compCand[0].dm < 0.3 && !COMPANY_SUFFIX_RE.test(companyField.value) && companyField.meta.state === 'extracted') {
      companyField.meta.state = 'needs_review';
      companyField.meta.reasons = [...(companyField.meta.reasons ?? []), 'Chosen by layout only (no company suffix or matching web domain).'];
    }
  }

  const addressField: TextField = addrBlock.length ? { value: joinAddress(addrBlock.map((s) => s.text)), meta: meta(addrBlock) } : notFound();
  addrBlock.forEach((s) => s.lineIds.forEach((id) => (roles[id] = roles[id] === 'contact' ? 'contact' : 'address')));
  if (/\p{Ll}B\p{Ll}/u.test(addressField.value)) {
    addressField.meta.state = 'needs_review';
    addressField.meta.alternatives = [addressField.value.replace(/(\p{Ll})B(\p{Ll})/gu, '$1ß$2')];
    addressField.meta.reasons = [...(addressField.meta.reasons ?? []), 'A capital “B” inside a word may be “ß”.'];
  }

  // E-mails
  const emails: MultiValue[] = [];
  for (const e of emailItems) {
    const n = normalizeEmail(e.value);
    if (emails.some((x) => x.normalized === n)) continue;
    const m = meta([e.seg]);
    // Item-level decision: the line may be "disputed" because of other text on it; judge this address on its own.
    const small = smallPrint([e.seg]);
    m.state = small ? 'needs_review' : 'extracted';
    m.reasons = small ? [small] : undefined;
    if (e.resolvedBy) {
      m.reasons = [...(m.reasons ?? []), `Readings differed; chose the one matching “${e.resolvedBy}” printed elsewhere on the card.`];
      m.alternatives = e.alternatives;
    }
    if (e.disputed) {
      m.state = 'needs_review';
      m.alternatives = e.alternatives;
      m.reasons = [
        ...(m.reasons ?? []),
        e.alternatives.length
          ? `Recognition models disagreed: “${e.value}” vs “${e.alternatives.join('” / “')}”. Check the photo.`
          : 'Only one recognition model found this address. Check the photo.',
      ];
    } else if (e.seg.conf < LOW_CONF) {
      m.state = 'needs_review';
      m.reasons = [...(m.reasons ?? []), 'Low recognition confidence — check against the photo.'];
    }
    const local = e.value.split('@')[0];
    emails.push({ id: vid('e'), value: e.value, normalized: n, label: GENERIC_EMAIL_LOCALS.test(local) ? 'general' : 'work', primary: false, meta: m });
  }

  const phones: MultiValue[] = [];
  for (const p of phoneItems) {
    const n = normalizePhone(p.value.replace(/\s*(?:ext\.?|x)\s*\d{1,5}$/i, ''));
    if (phones.some((x) => phoneKey(x.value) === phoneKey(p.value))) continue;
    const m = meta([p.seg]);
    const small = smallPrint([p.seg]);
    m.state = !p.disputed && p.seg.conf >= LOW_CONF && !small ? 'extracted' : 'needs_review';
    m.reasons = small ? [small] : undefined;
    if (p.disputed) {
      m.alternatives = p.alternatives;
      m.reasons = [...(m.reasons ?? []), `Digits read differently by the two models (${p.alternatives.join(', ')}).`];
    } else if (p.seg.conf < LOW_CONF) m.reasons = [...(m.reasons ?? []), 'Low recognition confidence — check the digits against the photo.'];
    phones.push({ id: vid('p'), value: p.value, normalized: n, label: p.label ?? 'phone', primary: false, meta: m });
  }

  const websites: MultiValue[] = [];
  for (const u of urlItems) {
    const n = normalizeWebsite(u.value);
    if (websites.some((w) => w.normalized === n)) continue;
    if (emails.some((e) => e.normalized.endsWith('@' + n))) {
      /* website equal to e-mail domain is still a website: keep */
    }
    const m = meta([u.seg]);
    const small = smallPrint([u.seg]);
    m.state = !u.disputed && u.seg.conf >= LOW_CONF && !small ? 'extracted' : 'needs_review';
    m.reasons = small ? [small] : undefined;
    if (u.resolvedBy) {
      m.reasons = [...(m.reasons ?? []), `Readings differed; chose the one matching “${u.resolvedBy}” printed elsewhere on the card.`];
      m.alternatives = u.alternatives;
    }
    if (u.disputed) {
      m.alternatives = u.alternatives;
      m.reasons = [`Recognition models disagreed: “${u.value}” vs “${u.alternatives.join('” / “')}”.`];
    }
    websites.push({
      id: vid('w'),
      value: u.value,
      normalized: n,
      label: /linkedin\.com\/company/i.test(u.value) ? 'linkedin-company' : 'website',
      primary: false,
      meta: m,
    });
  }

  // Cross-check: an e-mail domain and a website that differ only by look-alike characters (l/1/i, 0/o, rn/m)
  // cannot both be right. Flag both and offer each other's spelling.
  for (const e of emails) {
    const dom = e.value.split('@')[1].toLowerCase();
    for (const w of websites) {
      const host = w.normalized.split('/')[0];
      if (host === dom || unconfuse(host) !== unconfuse(dom)) continue;
      const local = e.value.split('@')[0];
      e.meta.state = 'needs_review';
      e.meta.alternatives = [...new Set([...(e.meta.alternatives ?? []), `${local}@${host}`])];
      e.meta.reasons = [...(e.meta.reasons ?? []), `The website reads “${host}” — look-alike letters; check which is right.`];
      w.meta.state = 'needs_review';
      w.meta.alternatives = [...new Set([...(w.meta.alternatives ?? []), w.value.replace(host, dom)])];
      w.meta.reasons = [...(w.meta.reasons ?? []), `The e-mail domain reads “${dom}” — look-alike letters; check which is right.`];
    }
  }
  // Text touching the photo border may be cut off.
  const atEdge = (b?: Box) => !!b && (b.x <= 2 || b.y <= 2 || b.x + b.w >= input.width - 2 || b.y + b.h >= input.height - 2);
  for (const f of [nameField, titleField, companyField, addressField, ...emails.map((e) => ({ value: e.value, meta: e.meta })), ...phones, ...websites])
    if (f.value && f.meta.source === 'ocr' && atEdge(f.meta.box)) {
      f.meta.state = 'needs_review';
      f.meta.reasons = [...(f.meta.reasons ?? []), 'This text touches the edge of the photo and may be cut off.'];
    }

  let linkedin = { url: '', meta: { state: 'not_found', source: 'ocr' } as FieldMeta };
  if (linkedinFromCard) linkedin = { url: linkedinFromCard.url, meta: meta([linkedinFromCard.seg], { reasons: ['Printed on the card.'] }) };

  // ----- QR codes -----
  for (const payload of input.qr) {
    const q = parseQr(payload);
    const qrMeta = (reason: string): FieldMeta => ({ state: 'extracted', source: 'qr', reasons: [reason] });
    for (const e of q.emails) {
      const n = normalizeEmail(e);
      const existing = emails.find((x) => x.normalized === n);
      if (existing) {
        existing.meta.reasons = [...(existing.meta.reasons ?? []).filter((r) => !r.startsWith('Only one')), 'Confirmed by the QR code.'];
        existing.meta.state = 'extracted';
      } else {
        const disputedMatch = emails.find((x) => x.meta.alternatives?.some((a) => normalizeEmail(a) === n));
        if (disputedMatch) {
          // The QR code settles a disagreement between printed readings.
          disputedMatch.meta.alternatives = [disputedMatch.value];
          disputedMatch.value = e;
          disputedMatch.normalized = n;
          disputedMatch.meta.state = 'extracted';
          disputedMatch.meta.reasons = ['Readings differed; the QR code on the card confirms this one.'];
        } else emails.push({ id: vid('e'), value: e, normalized: n, label: 'work', primary: false, meta: qrMeta('From the QR code.') });
      }
    }
    for (const p of q.phones) {
      const n = normalizePhone(p.value);
      if (n.replace('+', '').length < 7) continue;
      const tail = n.replace('+', '').slice(-9);
      const existing = phones.find((x) => x.normalized.replace('+', '').endsWith(tail));
      if (existing) {
        if (existing.meta.state === 'needs_review') existing.meta.state = 'extracted';
        existing.meta.reasons = ['Confirmed by the QR code.'];
      } else phones.push({ id: vid('p'), value: p.value, normalized: n, label: p.label, primary: false, meta: qrMeta('From the QR code.') });
    }
    for (const u of q.urls) {
      if (LINKEDIN_PROFILE_RE.test(u)) {
        const c = canonicalLinkedIn(u);
        if (!linkedin.url) linkedin = { url: c, meta: qrMeta('From the QR code.') };
        else if (linkedin.url.toLowerCase() !== c.toLowerCase()) {
          linkedin.meta.state = 'needs_review';
          linkedin.meta.alternatives = [c];
          linkedin.meta.reasons = [...(linkedin.meta.reasons ?? []), `QR code links to a different profile: ${c}`];
        }
      } else {
        const n = normalizeWebsite(u);
        const existing = websites.find((w) => w.normalized === n);
        if (existing) existing.meta.reasons = [...(existing.meta.reasons ?? []), 'Confirmed by the QR code.'];
        // Plain links from a QR code (booking pages, short links) are kept but labelled, not treated as the printed website.
        else
          websites.push({ id: vid('w'), value: u, normalized: n, label: 'qr-link', primary: false, meta: qrMeta('Link stored in the QR code (not printed).') });
      }
    }
    const fill = (field: TextField, v: string | undefined) => {
      if (!v) return;
      if (!field.value) {
        field.value = v;
        field.meta = qrMeta('From the QR code.');
      } else if (lettersOnly(field.value) === lettersOnly(v)) {
        field.meta.reasons = [...(field.meta.reasons ?? []).filter((r) => !r.startsWith('Not sure') && !r.startsWith('Weak')), 'Confirmed by the QR code.'];
        if (field.meta.state === 'needs_review' && !field.meta.reasons.some((r) => r.includes('differently') || r.includes('confidence')))
          field.meta.state = 'extracted';
      } else {
        field.meta.alternatives = [...(field.meta.alternatives ?? []), v];
        field.meta.reasons = [...(field.meta.reasons ?? []), `QR code says “${v}”.`];
        field.meta.state = 'needs_review';
      }
    };
    fill(nameField, q.name);
    fill(companyField, q.org);
    fill(titleField, q.title);
    if (!addressField.value && q.address) fill(addressField, q.address);
  }

  // Primary selection
  if (emails.length) {
    const personal =
      emails.find((e) => e.label === 'work' && nameField.value && emailNameMatch(nameField.value, [e.value.split('@')[0]]) > 0) ??
      emails.find((e) => e.label === 'work') ??
      emails[0];
    personal.primary = true;
  }
  if (phones.length) {
    const order = ['mobile', 'direct', 'office', 'phone', 'home', 'other', 'fax'];
    [...phones].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label))[0].primary = true;
  }
  const printed = websites.find((w) => w.label === 'website');
  if (printed) printed.primary = true;
  void companyField;
  companyField = companyField;

  for (const l of input.lines) if (!roles[l.id]) roles[l.id] = 'other';
  const used = new Set<Segment>([...taken, ...companySegs, ...addrBlock]);
  const otherText = textSegs.filter((s) => ![...used].some((u) => overlaps(u, s))).map((s) => s.text);
  void lineText;

  return {
    name: nameField,
    credentials: credentialsField,
    company: companyField,
    title: titleField,
    address: addressField,
    emails,
    phones,
    websites,
    linkedin,
    otherText,
    roles,
    version: EXTRACTOR_VERSION,
  };
}

function shapeIsNotPerson(text: string, locals: string[]) {
  return emailNameMatch(text, locals) < 2;
}

function overlaps(a: Segment, b: Segment) {
  return a === b || a.lineIds.some((id) => b.lineIds.includes(id));
}

function genericCompanyWords(s: string) {
  return words(s).every((w) => COMPANY_SUFFIX_RE.test(w) || /^(the|and|&|of)$/i.test(w));
}

function joinAddress(parts: string[]): string {
  return parts
    .map((p) => p.replace(/[,\s]+$/, '').trim())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+,/g, ',');
}

/** Swap l/I/1 look-alikes in a company name only when that makes it spell a web-domain label exactly. */
function fixWithDomain(value: string, labels: string[]): string | null {
  // Token by token, so "FIG FlipltGreen" can still fix its second word.
  const toks = value.split(/(\s+)/);
  let any = false;
  const out = toks.map((t) => {
    if (/^\s+$/.test(t) || !t) return t;
    const f = fixToken(t, labels);
    if (f && f !== t) {
      any = true;
      return f;
    }
    return t;
  });
  if (any) return out.join('');
  return fixToken(value, labels);
}

function fixToken(value: string, labels: string[]): string | null {
  const flat = value.replace(/\s+/g, '');
  for (const label of labels) {
    if (flat.length !== label.length) continue;
    let out = '';
    let changed = false;
    for (let i = 0; i < flat.length; i++) {
      const c = flat[i],
        want = label[i];
      if (c.toLowerCase() === want) out += c;
      else if (/[lI1|]/.test(c) && want === 'i') {
        out += /\p{Ll}/u.test(flat[i - 1] ?? '') && /\p{Ll}/u.test(flat[i + 1] ?? '') ? 'I' : c === 'l' ? 'I' : 'i';
        changed = true;
      } else if (/[I1|]/.test(c) && want === 'l') {
        out += 'l';
        changed = true;
      } else if (/[0]/.test(c) && want === 'o') {
        out += 'o';
        changed = true;
      } else return null;
    }
    if (changed) {
      // re-insert the original spaces
      let k = 0;
      return value.replace(/\S/g, () => out[k++]);
    }
  }
  return null;
}

void dictionaryWords;

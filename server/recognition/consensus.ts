// Combines independent readings of one text line into a single best reading.
// Pure functions (no I/O except the lazily-loaded English word list) so they can be unit-tested.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface Reading {
  text: string;
  confidence: number;
  source: string;
}

/** Text normalisation applied to every reading: compatibility forms (full-width brackets etc.) and × -> x. */
export function cleanText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/×/g, 'x')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fold case, spacing and diacritics so equivalent readings compare equal. */
export function foldReading(s: string) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toLowerCase();
}

let words: Set<string> | null = null;
export function englishWords(): Set<string> {
  if (words) return words;
  try {
    // word-list only exports its index; resolve that and read the list next to it.
    let main: string;
    try {
      main = fileURLToPath(import.meta.resolve('word-list'));
    } catch {
      main = createRequire(import.meta.url).resolve('word-list'); // test runners without import.meta.resolve
    }
    words = new Set(readFileSync(path.join(path.dirname(main), 'words.txt'), 'utf8').split('\n'));
  } catch (e) {
    console.warn('[buz-cards] English word list unavailable; reading consensus will not use it.', (e as Error).message);
    words = new Set();
  }
  return words;
}

/** Number of words (3+ letters) found in the English word list. */
export function dictionaryWords(s: string): number {
  const dict = englishWords();
  // E-mail addresses and domains are not prose ("tideiot.corn" must not win because "corn" is a word).
  return s
    .replace(/\S*(@|\w\.\w)\S*/g, ' ')
    .split(/[^A-Za-z]+/)
    .filter((t) => t.length >= 3)
    .filter((t) => {
      const l = t.toLowerCase();
      return dict.has(l) || (l.endsWith('s') && dict.has(l.slice(0, -1)));
    }).length;
}

/** Fraction of ordinary lower-case words (3+ letters) found in the English word list. */
export function dictionaryScore(s: string): number {
  const dict = englishWords();
  if (!dict.size) return 0;
  const toks = s
    .split(/[^A-Za-z]+/)
    .filter((t) => t.length >= 3)
    .map((t) => t.toLowerCase());
  if (!toks.length) return 0;
  return toks.filter((t) => dict.has(t) || (t.endsWith('s') && dict.has(t.slice(0, -1)))).length / toks.length;
}

/**
 * Merge spacing from readings whose non-space characters are identical.
 * One model often drops spaces ("NY11106") where another keeps them ("NY 11106").
 * Spaces are never inserted next to "@" or "." (would break e-mail addresses / domains).
 */
export function unionSpaces(texts: string[]): string {
  const base = texts[0];
  const chars = base.replace(/\s+/g, '');
  const spaceAfter = new Array(chars.length).fill(false);
  for (const t of texts) {
    if (t.replace(/\s+/g, '') !== chars) continue;
    let k = -1;
    for (const ch of t) {
      if (/\s/.test(ch)) {
        if (k >= 0) spaceAfter[k] = true;
      } else k++;
    }
  }
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    out += chars[i];
    const next = chars[i + 1];
    // never split "name@host" or "domain.com"; "J. R." style initials may keep their spaces
    const domainDot = chars[i] === '.' && /[a-z0-9]/.test(next ?? '');
    if (spaceAfter[i] && next !== undefined && chars[i] !== '@' && !domainDot && !/[@.,;:)]/.test(next)) out += ' ';
  }
  // Inside an e-mail-like token never keep spaces.
  return out.replace(/(\S+)\s+@\s*(\S+)/g, '$1@$2');
}

const LATIN_OK = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]*$/u;

/**
 * True when `longer` equals `shorter` plus 1-2 inserted letters that sit next to an "f"
 * (fi / fl / ff ligatures, which the multilingual model tends to swallow: "Offcer" vs "Officer").
 */
export function ligatureRecovery(shorter: string, longer: string): boolean {
  const a = shorter.replace(/\s+/g, ''),
    b = longer.replace(/\s+/g, '');
  if (b.length - a.length < 1 || b.length - a.length > 2) return false;
  let i = 0,
    j = 0,
    inserted = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // inserted char in b
    if (!/[ilf]/i.test(b[j]) || !(/f/i.test(b[j - 1] ?? '') || /f/i.test(b[j + 1] ?? ''))) return false;
    inserted++;
    j++;
  }
  return i === a.length && inserted >= 1;
}

export interface Consensus {
  text: string;
  confidence: number;
  disputed: boolean;
}

/**
 * Choose the reading for a line.
 * - readings[0] is the primary model, readings[1] the secondary model, readings[2] (optional) the primary model
 *   on an upscaled crop (not independent of [0], so it counts half).
 */
export function chooseReading(readings: Reading[], primaryName: string): Consensus {
  const rs = readings.map((r) => ({ ...r, text: cleanText(r.text) })).filter((r) => r.text);
  if (!rs.length) return { text: '', confidence: 0, disputed: false };
  const weight = (r: Reading) => (r.source.endsWith('-upscaled') ? 0.5 : 1);

  // Ligature recovery: if one reading is another plus letters around "f", trust the longer one.
  for (const a of rs)
    for (const b of rs)
      if (a !== b && ligatureRecovery(foldReading(a.text), foldReading(b.text))) {
        a.text = b.text; // adopt the recovered spelling
      }

  const groups = new Map<string, typeof rs>();
  for (const r of rs) {
    const k = foldReading(r.text);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const score = (g: typeof rs) => {
    const votes = g.reduce((s, r) => s + weight(r), 0);
    const conf = Math.max(...g.map((r) => r.confidence));
    const latin = LATIN_OK.test(g[0].text) ? 0 : -0.6;
    // Each additional real English word is strong evidence against a misread ("Solurion" vs "Solution").
    const dict = dictionaryWords(g[0].text);
    return votes + conf * 0.3 + latin + dict;
  };
  const ranked = [...groups.values()].sort((a, b) => score(b) - score(a));
  const top = ranked[0];
  // Prefer the spelling that carries diacritics (only the multilingual model can produce them).
  const withMarks = top.find((r) => /[^\x00-\x7f]/.test(r.text) && LATIN_OK.test(r.text));
  const ordered = [...(withMarks ? [withMarks] : []), ...top.filter((r) => r.source === primaryName), ...top];
  const text = unionSpaces([ordered[0].text, ...top.map((r) => r.text)]);
  // Disagreement on letters/digits only; punctuation-only differences ("(908)" vs "908") are not disputes.
  const alnum = (t: string) => foldReading(t).replace(/[^\p{L}\p{N}@]/gu, '');
  const agreeing = rs.filter((r) => alnum(r.text) === alnum(top[0].text));
  const independentSources = new Set(agreeing.map((r) => r.source.replace(/-upscaled$/, '')));
  const disputed = rs.some((r) => alnum(r.text) !== alnum(top[0].text)) && independentSources.size < 2;
  const confidence = Math.max(...top.map((r) => r.confidence));
  return { text, confidence, disputed };
}

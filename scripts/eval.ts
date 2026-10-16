// Accuracy evaluation: runs the real pipeline on a folder of card photos and compares the FIRST automatic
// result (before any manual correction) with human-verified ground truth.
//
//   node scripts/eval.ts --dir private-eval                      (uses private-eval/ground-truth.json)
//   node scripts/eval.ts --synthetic                             (public synthetic fixtures)
//
// Ground truth format: [{ "file": "IMG_0001.jpg", "name": "...", "company": "...", "title": "...",
//   "emails": ["..."], "phones": ["..."], "websites": ["..."], "linkedin": "", "address": "",
//   "illegible": ["emails"]  // optional: fields that are printed but not legible in this photo
// }]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { recognizeCard, ENGINE_VERSION } from '../server/recognition/engine.ts';
import { extractFields } from '../server/extraction/fields.ts';
import { normalizePhone, normalizeWebsite } from '../server/extraction/patterns.ts';

type OneOf = string | string[];
interface Truth {
  file: string;
  name?: OneOf;
  company?: OneOf;
  title?: OneOf;
  noName?: boolean;
  emails?: string[];
  phones?: string[];
  websites?: string[];
  linkedin?: string;
  address?: OneOf;
  illegible?: string[];
}
const anyOf = (v: OneOf | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const args = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..');
let dir: string, truths: Truth[];
if (args.includes('--synthetic')) {
  dir = path.join(root, 'tests/fixtures/synthetic/photos');
  const cards = JSON.parse(await readFile(path.join(root, 'tests/fixtures/synthetic/cards.json'), 'utf8'));
  truths = cards.map((c: { id: string; truth: Omit<Truth, 'file'> }) => ({ file: `${c.id}.jpg`, ...c.truth }));
} else {
  dir = path.resolve(args[args.indexOf('--dir') + 1] ?? 'private-eval');
  truths = JSON.parse(await readFile(path.join(dir, 'ground-truth.json'), 'utf8'));
}
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
if (only) truths = truths.filter((t) => t.file.includes(only));

const normText = (s = '') =>
  s
    .normalize('NFC')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s*([-/|])\s*/g, '$1')
    .trim()
    .toLowerCase();
// Digits only (country prefix kept as printed) plus extension; spacing and punctuation are formatting.
const phoneKey = (s: string) => {
  const ext = s.match(/(?:ext\.?|x)\s*(\d{1,5})\s*$/i)?.[1];
  return normalizePhone(s.replace(/\s*(?:ext\.?|x)\s*\d{1,5}\s*$/i, '')).replace(/^\+/, '') + (ext ? 'x' + ext : '');
};

const tally = {
  cards: 0,
  emails: { truth: 0, predicted: 0, correct: 0 },
  phones: { truth: 0, predicted: 0, correct: 0 },
  websites: { truth: 0, predicted: 0, correct: 0 },
  name: { total: 0, correct: 0, flagged: 0 },
  company: { total: 0, correct: 0, partial: 0 },
  title: { total: 0, correct: 0 },
  address: { total: 0, correct: 0 },
  perfectCards: 0,
  cardsNeedingCorrection: 0,
  cardDetected: 0,
  silent: { emails: 0, phones: 0, names: 0, flaggedWrong: 0 },
  ms: [] as number[],
  failures: 0,
};
const rows: string[] = [];

for (const t of truths) {
  tally.cards++;
  const started = Date.now();
  let ex;
  let page;
  try {
    // OCR cache (keyed by file + engine version) so extraction changes can be evaluated quickly.
    const cacheFile = path.join(dir, '.cache', `${t.file}.${ENGINE_VERSION}.json`);
    const cached = !args.includes('--fresh') ? await readFile(cacheFile, 'utf8').catch(() => null) : null;
    if (cached) page = JSON.parse(cached);
    else {
      const buf = new Uint8Array(await readFile(path.join(dir, t.file)));
      const r = await recognizeCard(buf);
      page = r.page;
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify(page));
    }
    ex = extractFields({ lines: page.lines, qr: page.qr, width: page.width, height: page.height, scale: page.card.scale });
  } catch (e) {
    tally.failures++;
    tally.cardsNeedingCorrection++;
    rows.push(`### ${t.file}\nFAILED: ${(e as Error).message}\n`);
    continue;
  }
  const ms = Date.now() - started;
  tally.ms.push(ms);
  if (page.card.detected) tally.cardDetected++;
  const problems: string[] = [];
  const illegible = new Set(t.illegible ?? []);

  const cmpSet = (kind: 'emails' | 'phones' | 'websites', truthVals: string[] = [], pred: string[], key: (s: string) => string) => {
    const tk = new Set(truthVals.map(key));
    const pk = new Set(pred.map(key));
    if (!illegible.has(kind)) tally[kind].truth += tk.size;
    tally[kind].predicted += pk.size;
    let correct = 0;
    for (const k of pk) if (tk.has(k)) correct++;
    tally[kind].correct += correct;
    const missing = [...tk].filter((k) => !pk.has(k));
    const extra = [...pk].filter((k) => !tk.has(k));
    if (missing.length || extra.length) problems.push(`${kind}: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
  };
  cmpSet(
    'emails',
    t.emails,
    ex.emails.map((e) => e.value),
    (s) => s.toLowerCase(),
  );
  // Silent errors: a wrong value that was NOT flagged for review (the dangerous kind).
  const tEmails = new Set((t.emails ?? []).map((x) => x.toLowerCase()));
  for (const e of ex.emails) if (!tEmails.has(e.value.toLowerCase())) e.meta.state === 'needs_review' ? tally.silent.flaggedWrong++ : tally.silent.emails++;
  const tPhones = new Set((t.phones ?? []).map(phoneKey));
  for (const p of ex.phones) if (!tPhones.has(phoneKey(p.value))) p.meta.state === 'needs_review' ? tally.silent.flaggedWrong++ : tally.silent.phones++;
  if (t.name && !anyOf(t.name).some((n) => normText(ex.name.value) === normText(n)))
    ex.name.meta.state === 'needs_review' ? tally.silent.flaggedWrong++ : tally.silent.names++;
  cmpSet(
    'phones',
    t.phones,
    ex.phones.map((p) => p.value),
    phoneKey,
  );
  cmpSet(
    'websites',
    t.websites,
    ex.websites.filter((w) => w.label !== 'qr-link').map((w) => w.value),
    normalizeWebsite,
  );

  if (t.name) {
    tally.name.total++;
    if (anyOf(t.name).some((n) => normText(ex.name.value) === normText(n))) tally.name.correct++;
    else problems.push(`name: got “${ex.name.value}” [${ex.name.meta.state}] expected “${anyOf(t.name)[0]}”`);
    if (ex.name.meta.state === 'needs_review') tally.name.flagged++;
  }
  if (t.noName && ex.name.value) problems.push(`name: none printed, but got “${ex.name.value}” [${ex.name.meta.state}]`);
  if (t.company) {
    tally.company.total++;
    const a = normText(ex.company.value);
    if (anyOf(t.company).some((c) => normText(c) === a)) tally.company.correct++;
    else {
      if (a && anyOf(t.company).some((c) => normText(c).includes(a) || a.includes(normText(c)))) tally.company.partial++;
      problems.push(`company: got “${ex.company.value}” [${ex.company.meta.state}] expected “${anyOf(t.company)[0]}”`);
    }
  }
  if (t.title) {
    tally.title.total++;
    if (anyOf(t.title).some((x) => normText(ex.title.value) === normText(x))) tally.title.correct++;
    else problems.push(`title: got “${ex.title.value}” [${ex.title.meta.state}] expected “${anyOf(t.title)[0]}”`);
  }
  if (t.address) {
    tally.address.total++;
    const strip = (s: string) => normText(s).replace(/[^a-z0-9#]/g, '');
    if (anyOf(t.address).some((a) => strip(ex.address.value) === strip(a))) tally.address.correct++;
    else problems.push(`address: got “${ex.address.value}” expected “${anyOf(t.address)[0]}”`);
  }
  if (t.linkedin) {
    const want = t.linkedin
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, '')
      .replace(/\/$/, '');
    const got = ex.linkedin.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '');
    if (want !== got) problems.push(`linkedin: got “${ex.linkedin.url}” expected “${t.linkedin}”`);
  }
  if (!problems.length) tally.perfectCards++;
  else tally.cardsNeedingCorrection++;
  rows.push(
    `### ${t.file} — ${problems.length ? 'needs correction' : 'all fields correct'} (${ms} ms, card ${page.card.detected ? page.card.method : 'not detected'})\n` +
      (problems.length ? problems.map((p) => `- ${p}`).join('\n') + '\n' : '') +
      `<details><summary>OCR lines</summary>\n\n${page.lines.map((l: { disputed: boolean; text: string }) => `- ${l.disputed ? '⚠ ' : ''}${l.text}`).join('\n')}\n</details>\n`,
  );
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}% (${a}/${b})` : 'n/a');
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const summary = [
  `# Evaluation — ${path.basename(dir)} (${new Date().toISOString()})`,
  '',
  `First automatic result, before manual correction. Cards: ${tally.cards}. Processing failures: ${tally.failures}.`,
  '',
  '| Measure | Result |',
  '| --- | --- |',
  `| Email precision | ${pct(tally.emails.correct, tally.emails.predicted)} |`,
  `| Email recall (legible) | ${pct(tally.emails.correct, tally.emails.truth)} |`,
  `| Phone precision | ${pct(tally.phones.correct, tally.phones.predicted)} |`,
  `| Phone recall | ${pct(tally.phones.correct, tally.phones.truth)} |`,
  `| Website recall | ${pct(tally.websites.correct, tally.websites.truth)} |`,
  `| Name exact | ${pct(tally.name.correct, tally.name.total)} (flagged for review: ${tally.name.flagged}) |`,
  `| Company exact | ${pct(tally.company.correct, tally.company.total)} (partial: ${tally.company.partial}) |`,
  `| Position exact | ${pct(tally.title.correct, tally.title.total)} |`,
  `| Address exact (punctuation-insensitive) | ${pct(tally.address.correct, tally.address.total)} |`,
  `| Cards with every field correct | ${pct(tally.perfectCards, tally.cards)} |`,
  `| Cards needing any correction | ${pct(tally.cardsNeedingCorrection, tally.cards)} |`,
  `| Card outline detected | ${pct(tally.cardDetected, tally.cards)} |`,
  `| Wrong but NOT flagged (silent) | e-mails ${tally.silent.emails}, phones ${tally.silent.phones}, names ${tally.silent.names} |`,
  `| Wrong and flagged for review | ${tally.silent.flaggedWrong} |`,
  `| Median time per card | ${med(tally.ms)} ms (this machine) |`,
  '',
  ...rows,
].join('\n');
const outDir = path.join(dir, 'reports');
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await writeFile(path.join(outDir, `eval-${stamp}.md`), summary);
console.log(summary.split('\n').slice(0, 20).join('\n'));
console.log(
  '\n' +
    rows
      .filter((r) => r.includes('needs correction') || r.includes('FAILED'))
      .map((r) => r.split('<details>')[0])
      .join('\n'),
);
console.log(`Full report: ${path.join(outDir, `eval-${stamp}.md`)}`);

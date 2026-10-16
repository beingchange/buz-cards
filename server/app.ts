// HTTP API + static web app.
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { randomInt, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Contact, ServerInfo } from '../shared/types.ts';
import { dataDir, getSetting, openDb, setSetting } from './db.ts';
import {
  ConflictError,
  applyBackExtraction,
  applyExtraction,
  approveField,
  attentionList,
  blankContact,
  deleteContact,
  facets,
  findDuplicates,
  getContact,
  listContacts,
  markUserEdits,
  mergeContacts,
  putContact,
  type ListQuery,
} from './contacts.ts';
import { getCard, getCardOcr, linkCard, originalPath, processCard, processedPath, storeOriginal, thumbPath } from './cards.ts';
import {
  LIMITS,
  LimitError,
  addItem,
  createBatch,
  discardBatch,
  getBatch,
  kick,
  listBatches,
  markItemByContact,
  onQueueChange,
  queueState,
  rereadBatch,
  retryItem,
  updateBatch,
} from './batches.ts';
import { buildWorkbook, exportSummary, toVCards } from './exports.ts';
import { applyRestore, createBackup, previewRestore } from './backup.ts';
import { extractFields } from './extraction/fields.ts';
import { engineStatus } from './recognition/pool.ts';
import { ENGINE_VERSION } from './recognition/version.ts';
import { linkedinProvider, manualSearchUrls, searchLinkedIn, SearchError } from './linkedin.ts';
import { canonicalLinkedIn } from './extraction/fields.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;

export function lanUrls(port: number, https = false): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`${https ? 'https' : 'http'}://${a.address}:${port}`);
  return out;
}

// ---------- access code for devices other than this computer ----------

export function accessCode(): string {
  let code = process.env.BUZ_ACCESS_CODE || getSetting('access_code');
  if (!code) {
    code = String(randomInt(100000, 999999));
    setSetting('access_code', code);
  }
  return code;
}

const isLoopback = (req: Request) => {
  if (process.env.BUZ_TRUST_LOOPBACK === '0') return false; // tests: treat this computer like a phone
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

function cookie(req: Request, name: string) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function codeOk(given: string | null) {
  if (!given) return false;
  const a = Buffer.from(given),
    b = Buffer.from(accessCode());
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAccess(req: Request, res: Response, next: NextFunction) {
  if (process.env.BUZ_REQUIRE_CODE === '0' || isLoopback(req)) return next();
  if (codeOk(cookie(req, 'buz_access')) || codeOk(String(req.headers['x-access-code'] ?? ''))) return next();
  res.status(401).json({ error: 'Enter the access code shown on the computer running Buz Cards.', code: 'access_code_required' });
}

// ---------- helpers ----------

const ah = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

function httpError(status: number, message: string, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

function listQueryFrom(q: Record<string, unknown>): ListQuery {
  const s = (k: string) => (typeof q[k] === 'string' && q[k] ? (q[k] as string) : undefined);
  return {
    state: s('state') ?? 'saved',
    q: s('q'),
    event: s('event'),
    status: s('status'),
    tag: s('tag'),
    followUp: s('followUp') as ListQuery['followUp'],
    sort: s('sort') as ListQuery['sort'],
    batchId: s('batchId'),
    ids: s('ids')?.split(',').filter(Boolean),
  };
}

function exportSet(q: Record<string, unknown>): { contacts: Contact[]; scope: string } {
  const scope = String(q.scope ?? 'all');
  const includeDrafts = q.includeDrafts === '1';
  const state = includeDrafts ? 'all' : 'saved';
  if (scope === 'selected') {
    const ids = String(q.ids ?? '')
      .split(',')
      .filter(Boolean);
    if (!ids.length) throw httpError(400, 'No contacts selected.');
    const list = listContacts({ state, ids }).filter((c) => c.state !== 'skipped');
    return { contacts: list, scope: `Selected contacts (${list.length})${includeDrafts ? ', including unreviewed drafts' : ', saved only'}` };
  }
  if (scope === 'filtered') {
    const lq = { ...listQueryFrom(q), state };
    const list = listContacts(lq).filter((c) => c.state !== 'skipped');
    const desc = [lq.q && `search “${lq.q}”`, lq.event && `event “${lq.event}”`, lq.status && `status ${lq.status}`, lq.tag && `tag “${lq.tag}”`]
      .filter(Boolean)
      .join(', ');
    return { contacts: list, scope: `Filtered view${desc ? ` (${desc})` : ''}${includeDrafts ? ', including unreviewed drafts' : ', saved only'}` };
  }
  const list = listContacts({ state, sort: 'recent' }).filter((c) => c.state !== 'skipped');
  return { contacts: list, scope: includeDrafts ? 'All contacts including unreviewed drafts' : 'All saved contacts' };
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

function contactPayload(c: Contact) {
  return { contact: c, attention: attentionList(c), duplicates: findDuplicates(c) };
}

// ---------- app ----------

export function createApp(opts: { port?: number; https?: boolean } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Login with the access code (sets an HttpOnly cookie for this browser).
  app.post('/api/access', express.json({ limit: '4kb' }), (req, res) => {
    const code = String(req.body?.code ?? '').trim();
    if (!codeOk(code))
      return res.status(401).json({ error: 'That code is not right. It is shown on the computer running Buz Cards (Settings, or the terminal window).' });
    res.setHeader(
      'Set-Cookie',
      `buz_access=${encodeURIComponent(code)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 365}${opts.https ? '; Secure' : ''}`,
    );
    res.json({ ok: true });
  });
  app.get('/api/access', (req, res) =>
    res.json({ required: !(process.env.BUZ_REQUIRE_CODE === '0' || isLoopback(req) || codeOk(cookie(req, 'buz_access'))), loopback: isLoopback(req) }),
  );

  app.use('/api', requireAccess);
  app.use('/api', express.json({ limit: '5mb' }));

  app.get('/api/info', (req, res) => {
    const d = openDb();
    const count = (sql: string) => (d.prepare(sql).get() as { n: number }).n;
    const st = engineStatus();
    const info: ServerInfo & { accessCode?: string; queue: ReturnType<typeof queueState>; manualLinkedIn: boolean } = {
      version: VERSION,
      engine: ENGINE_VERSION,
      processing: 'local-computer',
      storagePath: dataDir(),
      limits: LIMITS,
      lanUrls: opts.port ? lanUrls(opts.port, opts.https) : [],
      https: !!opts.https,
      linkedinSearch: { available: !!linkedinProvider(), provider: linkedinProvider() },
      modelStatus: st.state,
      modelError: st.error,
      counts: {
        saved: count("SELECT COUNT(*) AS n FROM contacts WHERE state = 'saved'"),
        drafts: count("SELECT COUNT(*) AS n FROM contacts WHERE state = 'draft'"),
        queued: count("SELECT COUNT(*) AS n FROM batch_items WHERE status IN ('queued','processing')"),
      },
      queue: queueState(),
      manualLinkedIn: true,
    };
    // The code is only revealed to the computer itself (so you can type it on your phone).
    if (isLoopback(req)) info.accessCode = accessCode();
    res.json(info);
  });

  // Live updates (Server-Sent Events): batch progress without polling.
  app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: {}\n\n`);
    const off = onQueueChange(() => res.write(`event: queue\ndata: ${JSON.stringify(queueState())}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      off();
      clearInterval(ping);
    });
  });

  // ----- contacts -----
  app.get('/api/contacts', (req, res) => {
    const list = listContacts(listQueryFrom(req.query as Record<string, unknown>));
    res.json({ contacts: list.map((c) => ({ ...c, attention: attentionList(c) })) });
  });
  app.get('/api/facets', (_req, res) => res.json(facets()));

  app.post('/api/contacts', (req, res) => {
    const body = (req.body?.contact ?? {}) as Partial<Contact>;
    const c = blankContact({ ...body, id: blankContact().id, state: body.state === 'saved' ? 'saved' : 'draft', revision: 0 });
    for (const k of ['name', 'credentials', 'company', 'title', 'address'] as const) if (c[k].value) c[k].meta = { state: 'user_corrected', source: 'user' };
    for (const k of ['emails', 'phones', 'websites'] as const) for (const v of c[k]) v.meta = { state: 'user_corrected', source: 'user' };
    res.status(201).json(contactPayload(putContact(c)));
  });

  app.get('/api/contacts/:id', (req, res) => {
    const c = getContact(String(req.params.id));
    if (!c) throw httpError(404, 'Contact not found.');
    res.json(contactPayload(c));
  });

  app.put('/api/contacts/:id', (req, res) => {
    const prev = getContact(String(req.params.id));
    if (!prev) throw httpError(404, 'Contact not found.');
    const incoming = req.body?.contact as Contact;
    if (!incoming || incoming.id !== prev.id) throw httpError(400, 'Invalid contact.');
    const next = markUserEdits(prev, { ...incoming, state: prev.state, cardIds: prev.cardIds, batchId: prev.batchId, createdAt: prev.createdAt });
    res.json(contactPayload(putContact(next, Number(req.body.revision ?? incoming.revision))));
  });

  app.post('/api/contacts/:id/approve', (req, res) => {
    const c = getContact(String(req.params.id));
    if (!c) throw httpError(404, 'Contact not found.');
    res.json(contactPayload(putContact(approveField(c, String(req.body?.field ?? ''), req.body?.itemId), Number(req.body?.revision ?? c.revision))));
  });

  app.post('/api/contacts/:id/save', (req, res) => {
    const prev = getContact(String(req.params.id));
    if (!prev) throw httpError(404, 'Contact not found.');
    let next = prev;
    if (req.body?.contact)
      next = markUserEdits(prev, { ...(req.body.contact as Contact), cardIds: prev.cardIds, batchId: prev.batchId, createdAt: prev.createdAt });
    next = { ...next, state: 'saved' };
    const saved = putContact(next, Number(req.body?.revision ?? prev.revision));
    markItemByContact(saved.id, 'saved');
    res.json(contactPayload(saved));
  });

  app.post('/api/contacts/save-many', (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const results = ids.map((id) => {
      const c = getContact(id);
      if (!c) return { id, ok: false, error: 'not found' };
      if (c.state === 'saved') return { id, ok: true, already: true };
      const saved = putContact({ ...c, state: 'saved' }, c.revision);
      markItemByContact(id, 'saved');
      return { id, ok: true, attention: attentionList(saved) };
    });
    res.json({ results });
  });

  app.post('/api/contacts/:id/skip', (req, res) => {
    const c = getContact(String(req.params.id));
    if (!c) throw httpError(404, 'Contact not found.');
    if (c.state === 'saved') throw httpError(409, 'This contact is already saved. Delete it instead if you no longer want it.');
    putContact({ ...c, state: 'skipped' });
    markItemByContact(c.id, 'skipped');
    res.json({ ok: true });
  });

  app.post('/api/contacts/:id/unskip', (req, res) => {
    const c = getContact(String(req.params.id));
    if (!c) throw httpError(404, 'Contact not found.');
    const next = putContact({ ...c, state: 'draft' });
    markItemByContact(c.id, attentionList(next).length ? 'needs_attention' : 'ready');
    res.json(contactPayload(next));
  });

  app.delete('/api/contacts/:id', (req, res) => {
    deleteContact(String(req.params.id));
    res.json({ ok: true });
  });

  app.get('/api/contacts/:id/duplicates', (req, res) => {
    const c = getContact(String(req.params.id));
    if (!c) throw httpError(404, 'Contact not found.');
    res.json({ duplicates: findDuplicates(c) });
  });

  app.post('/api/contacts/merge', (req, res) => {
    const a = getContact(String(req.body?.primaryId)),
      b = getContact(String(req.body?.otherId));
    if (!a || !b) throw httpError(404, 'Contact not found.');
    const merged = mergeContacts(a, b, req.body?.choose ?? {});
    const saved = putContact(merged, a.revision);
    for (const cid of b.cardIds) linkCard(cid, saved.id);
    openDb()
      .prepare('UPDATE batch_items SET contact_id = ?, status = ? WHERE contact_id = ?')
      .run(saved.id, saved.state === 'saved' ? 'saved' : 'skipped', b.id);
    openDb().prepare('DELETE FROM contacts WHERE id = ?').run(b.id);
    res.json(contactPayload(saved));
  });

  // Re-read a card (optionally rotated / cropped). Manual corrections are kept.
  app.post(
    '/api/contacts/:id/rescan',
    ah(async (req, res) => {
      const c = getContact(String(req.params.id));
      if (!c) throw httpError(404, 'Contact not found.');
      const cardId = String(req.body?.cardId ?? c.cardIds[0] ?? '');
      if (!cardId) throw httpError(409, 'This contact has no card image to read.');
      const page = await processCard(cardId, { rotation: req.body?.rotation, crop: req.body?.crop });
      const ex = extractFields({ lines: page.lines, qr: page.qr, width: page.width, height: page.height, scale: page.card.scale });
      const fresh = getContact(c.id)!;
      const next = applyExtraction(fresh, ex, page.lines.map((l) => l.text).join('\n'));
      const saved = putContact(next);
      if (saved.state !== 'saved') markItemByContact(saved.id, attentionList(saved).length ? 'needs_attention' : 'ready');
      res.json(contactPayload(saved));
    }),
  );

  // Attach the back of the card and merge what it adds.
  app.post(
    '/api/contacts/:id/back',
    express.raw({ type: () => true, limit: LIMITS.maxFileBytes }),
    ah(async (req, res) => {
      const c = getContact(String(req.params.id));
      if (!c) throw httpError(404, 'Contact not found.');
      const buf = new Uint8Array(req.body as Buffer);
      const card = await storeOriginal(buf, decodeURIComponent(String(req.headers['x-file-name'] ?? 'back.jpg')), 'back');
      linkCard(card.id, c.id, 'back');
      const page = await processCard(card.id);
      const ex = extractFields({ lines: page.lines, qr: page.qr, width: page.width, height: page.height, scale: page.card.scale });
      const fresh = getContact(c.id)!;
      const next = applyBackExtraction({ ...fresh, cardIds: [...fresh.cardIds, card.id] }, ex, page.lines.map((l) => l.text).join('\n'));
      res.json(contactPayload(putContact(next)));
    }),
  );

  // ----- LinkedIn -----
  app.get('/api/contacts/:id/linkedin/manual', (req, res) => {
    const c = getContact(String(req.params.id));
    if (!c) throw httpError(404, 'Contact not found.');
    res.json(manualSearchUrls(c.name.value, c.company.value));
  });
  app.post(
    '/api/contacts/:id/linkedin/search',
    ah(async (req, res) => {
      const c = getContact(String(req.params.id));
      if (!c) throw httpError(404, 'Contact not found.');
      const candidates = await searchLinkedIn(c.name.value, c.company.value);
      const next = putContact({ ...c, linkedin: { ...c.linkedin, candidates, searchedAt: new Date().toISOString() } });
      res.json({ ...contactPayload(next), candidates });
    }),
  );
  app.post('/api/contacts/:id/linkedin/confirm', (req, res) => {
    const c = getContact(String(req.params.id));
    if (!c) throw httpError(404, 'Contact not found.');
    const url = canonicalLinkedIn(String(req.body?.url ?? ''));
    if (req.body?.url && !url) throw httpError(400, 'That is not a LinkedIn profile link (linkedin.com/in/…).');
    const fromCandidates = c.linkedin.candidates.some((x) => canonicalLinkedIn(x.url).toLowerCase() === url.toLowerCase());
    const next = putContact({
      ...c,
      linkedin: {
        ...c.linkedin,
        url,
        meta: url
          ? { state: fromCandidates ? 'enriched' : 'user_corrected', source: fromCandidates ? 'enrichment' : 'user', reasons: ['Confirmed by you.'] }
          : { state: 'not_found', source: 'user' },
      },
    });
    res.json(contactPayload(next));
  });

  // ----- card images & recognition evidence -----
  app.get(
    '/api/cards/:id/image',
    ah(async (req, res) => {
      const card = getCard(String(req.params.id));
      if (!card) throw httpError(404, 'Image not found.');
      const variant = String(req.query.variant ?? 'processed');
      let file: string | null = null;
      if (variant === 'original') file = await originalPath(card.id);
      else if (variant === 'thumb') file = existsSync(thumbPath(card.id)) ? thumbPath(card.id) : null;
      if (!file && existsSync(processedPath(card.id))) file = processedPath(card.id);
      if (!file) file = await originalPath(card.id);
      if (!file) throw httpError(404, 'Image file missing.');
      res.setHeader('Cache-Control', 'private, max-age=60');
      if (req.query.download === '1')
        res.setHeader('Content-Disposition', `attachment; filename="${card.originalName.replace(/[^\w.\- ]/g, '_') || 'card.jpg'}"`);
      res.type(path.extname(file));
      createReadStream(file).pipe(res);
    }),
  );
  app.get('/api/cards/:id', (req, res) => {
    const card = getCard(String(req.params.id));
    if (!card) throw httpError(404, 'Image not found.');
    const ocr = getCardOcr(card.id);
    res.json({ card, ocr });
  });

  // ----- batches -----
  app.get('/api/batches', (req, res) => res.json({ batches: listBatches({ active: req.query.active === '1' }), limits: LIMITS }));
  app.post('/api/batches', (req, res) => {
    const b = createBatch({
      label: req.body?.label,
      event: req.body?.event,
      tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
      kind: req.body?.kind === 'single' ? 'single' : 'batch',
    });
    res.status(201).json({ batch: b });
  });
  app.get('/api/batches/:id', (req, res) => {
    const b = getBatch(String(req.params.id));
    if (!b) throw httpError(404, 'Batch not found.');
    const contacts = listContacts({ state: 'all', batchId: b.id });
    res.json({ batch: b, contacts: contacts.map((c) => ({ ...c, attention: attentionList(c), duplicates: findDuplicates(c) })), queue: queueState() });
  });
  app.patch('/api/batches/:id', (req, res) => {
    const b = updateBatch(String(req.params.id), req.body ?? {});
    if (!b) throw httpError(404, 'Batch not found.');
    res.json({ batch: b });
  });
  app.post(
    '/api/batches/:id/items',
    express.raw({ type: () => true, limit: LIMITS.maxFileBytes + 1024 }),
    ah(async (req, res) => {
      const clientKey = String(req.headers['x-client-key'] ?? '');
      if (!/^[\w-]{6,80}$/.test(clientKey)) throw httpError(400, 'Missing upload key.');
      const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'image'));
      const position = Number(req.headers['x-position'] ?? 0);
      const buf = new Uint8Array(req.body as Buffer);
      if (!buf.byteLength) throw httpError(400, 'The file is empty.');
      const item = await addItem(String(req.params.id), clientKey, name, buf, position);
      res.status(201).json({ item });
    }),
  );
  app.post('/api/batches/:id/items/:itemId/retry', (req, res) => res.json({ batch: retryItem(String(req.params.id), String(req.params.itemId)) }));
  app.post('/api/batches/:id/reread', (req, res) => res.json({ batch: rereadBatch(String(req.params.id)) }));
  app.post(
    '/api/batches/:id/discard',
    ah(async (req, res) => res.json(await discardBatch(String(req.params.id)))),
  );

  // ----- exports -----
  app.get('/api/export/summary', (req, res) => {
    const { contacts, scope } = exportSet(req.query as Record<string, unknown>);
    const drafts = listContacts({ state: 'draft' }).length;
    res.json({ scope, ...exportSummary(contacts), draftsInApp: drafts });
  });
  app.get(
    '/api/export.xlsx',
    ah(async (req, res) => {
      const { contacts, scope } = exportSet(req.query as Record<string, unknown>);
      const buf = await buildWorkbook(contacts, { scope });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="buz-cards-${stamp()}.xlsx"`);
      res.setHeader('X-Export-Count', String(contacts.length));
      res.send(buf);
    }),
  );
  app.get('/api/export.vcf', (req, res) => {
    const { contacts } = exportSet(req.query as Record<string, unknown>);
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="buz-cards-${stamp()}.vcf"`);
    res.setHeader('X-Export-Count', String(contacts.length));
    res.send(toVCards(contacts));
  });

  // ----- backup / restore -----
  app.get(
    '/api/backup.zip',
    ah(async (req, res) => {
      const buf = await createBackup({ includeImages: req.query.images !== '0' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="buz-cards-backup-${stamp()}.zip"`);
      res.send(buf);
    }),
  );
  app.post(
    '/api/restore/preview',
    express.raw({ type: () => true, limit: '2gb' }),
    ah(async (req, res) => {
      try {
        res.json(await previewRestore(new Uint8Array(req.body as Buffer)));
      } catch (e) {
        throw httpError(400, (e as Error).message, 'invalid_backup'); // the file is the problem, not the server
      }
    }),
  );
  app.post(
    '/api/restore/apply',
    ah(async (req, res) => res.json(await applyRestore(String(req.body?.token ?? ''), req.body?.policy))),
  );

  app.use('/api', (_req, _res, next) => next(httpError(404, 'Unknown API endpoint.')));

  // ----- web app -----
  const dist = path.join(ROOT, 'dist');
  if (existsSync(dist)) {
    app.use(
      express.static(dist, {
        index: false,
        setHeaders(res, file) {
          // Never cache the app shell or service worker, so updates (incl. new recognition) always reach users.
          if (/index\.html$|sw\.js$|manifest\.webmanifest$|registerSW\.js$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
          else if (/\/assets\//.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => res.type('text').send('Buz Cards API is running. Build the web app with "npm run build" (or use "npm run dev").'));
  }

  // ----- errors -----
  app.use((err: Error & { status?: number; code?: string; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (err instanceof ConflictError) return res.status(409).json({ error: err.message, code: 'conflict', current: err.current });
    if (err instanceof LimitError) return res.status(413).json({ error: err.message, code: 'limit' });
    if (err instanceof SearchError) return res.status(err.status).json({ error: err.message, code: 'search' });
    if (err.type === 'entity.too.large')
      return res.status(413).json({ error: `File too large (limit ${LIMITS.maxFileBytes / 1024 / 1024} MB).`, code: 'limit' });
    const status = err.status ?? (err.code === 'ENOSPC' ? 507 : 500);
    const message = err.code === 'ENOSPC' ? 'The computer’s disk is full. Free some space; nothing was lost.' : err.message || 'Unexpected error';
    if (status >= 500) console.error('[buz-cards]', err);
    res.status(status).json({ error: message, code: err.code ?? 'error' });
  });

  return app;
}

export { kick };

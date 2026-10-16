import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, X, Check, Search, ExternalLink, Trash2, FilePlus2 } from 'lucide-react';
import { api, ApiError, getContact, putContact, type ContactPayload, type Duplicate } from '../api';
import { go } from '../App';
import { CardViewer } from '../components/CardViewer';
import type { Box, CardImage, Contact, FieldMeta, MultiValue, OcrLineDTO, TextField } from '../../shared/types';
import { ACCEPT_ATTR, randomId } from '../util';

type TextKey = 'name' | 'credentials' | 'title' | 'company' | 'address';
type MultiKey = 'emails' | 'phones' | 'websites';

const TEXT_LABELS: Record<TextKey, string> = { name: 'Name', credentials: 'Credentials', title: 'Position', company: 'Company', address: 'Address' };
const MULTI_LABELS: Record<MultiKey, string> = { emails: 'Email', phones: 'Phone', websites: 'Website' };
const LABEL_OPTIONS: Record<MultiKey, [string, string][]> = {
  emails: [
    ['work', 'Work'],
    ['general', 'General'],
    ['personal', 'Personal'],
    ['other', 'Other'],
  ],
  phones: [
    ['mobile', 'Mobile'],
    ['office', 'Office'],
    ['direct', 'Direct'],
    ['phone', 'Phone'],
    ['fax', 'Fax'],
    ['home', 'Home'],
    ['other', 'Other'],
  ],
  websites: [
    ['website', 'Website'],
    ['qr-link', 'QR link'],
    ['linkedin-company', 'LinkedIn page'],
    ['other', 'Other'],
  ],
};
const INPUT_TYPE: Record<MultiKey, string> = { emails: 'email', phones: 'tel', websites: 'url' };

function isCheck(m: FieldMeta) {
  return m.state === 'needs_review';
}

/** Editing a value clears its warnings immediately (the server records it as a user correction). */
function edited(m: FieldMeta, value: string): FieldMeta {
  return { ...m, state: 'user_corrected', source: 'user', machineValue: m.machineValue ?? (m.source === 'user' ? undefined : value), reasons: undefined };
}

export function ReviewScreen({ id, from, onChanged }: { id: string; from?: string; onChanged: () => void }) {
  const [data, setData] = useState<ContactPayload | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [cards, setCards] = useState<CardImage[]>([]);
  const [lines, setLines] = useState<OcrLineDTO[]>([]);
  const [focus, setFocus] = useState<Box | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [facets, setFacets] = useState<{ events: { name: string }[]; tags: { name: string }[] }>({ events: [], tags: [] });
  const [dismissedDupes, setDismissedDupes] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState<Duplicate | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const version = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Contact | null>(null);
  const backRef = useRef<HTMLInputElement>(null);

  const loadCards = useCallback(async (c: Contact) => {
    const list = await Promise.all(
      c.cardIds.map((cid) => api<{ card: CardImage; ocr: { lines: OcrLineDTO[] } | null }>(`/api/cards/${cid}`).catch(() => null)),
    );
    const ok = list.filter(Boolean) as { card: CardImage; ocr: { lines: OcrLineDTO[] } | null }[];
    ok.sort((a, b) => (a.card.side === 'front' ? -1 : 1) - (b.card.side === 'front' ? -1 : 1));
    setCards(ok.map((x) => x.card));
    setLines(ok.find((x) => x.card.side === 'front')?.ocr?.lines ?? ok[0]?.ocr?.lines ?? []);
  }, []);

  const apply = useCallback(
    (p: ContactPayload) => {
      setData(p);
      setContact(p.contact);
      latest.current = p.contact;
      void loadCards(p.contact);
    },
    [loadCards],
  );

  useEffect(() => {
    setData(null);
    setContact(null);
    getContact(id)
      .then(apply)
      .catch((e) => setError(e.message));
    api<{ events: { name: string }[]; tags: { name: string }[] }>('/api/facets')
      .then(setFacets)
      .catch(() => undefined);
  }, [id, apply]);

  // ----- autosave -----
  const flush = useCallback(async (): Promise<void> => {
    // One save at a time: wait for a save already in progress, then send what changed since.
    while (inFlight.current) await inFlight.current;
    const run = doFlush();
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savedVersion = useRef(0);
  const doFlush = async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const c = latest.current;
    if (!c || c.revision === undefined) return;
    const sentVersion = version.current;
    if (sentVersion === savedVersion.current) return; // nothing new to save
    setSaving('saving');
    try {
      const p = await putContact(c);
      setData(p);
      if (version.current === sentVersion) {
        // The server drops blank rows; keep rows the user just added and has not typed into yet.
        const merged = structuredClone(p.contact);
        for (const k of ['emails', 'phones', 'websites'] as const) merged[k] = [...merged[k], ...c[k].filter((v) => !v.value.trim())];
        setContact(merged);
        latest.current = merged;
        savedVersion.current = sentVersion;
      } else {
        // more edits happened meanwhile: keep them, adopt the new revision
        latest.current = { ...latest.current!, revision: p.contact.revision };
        setContact(latest.current);
        schedule();
      }
      setSaving('saved');
    } catch (e) {
      setSaving('error');
      if (e instanceof ApiError && e.code === 'conflict')
        setError('This contact was changed on another device. Reload to see the latest version (your last edit was not saved).');
      else setError((e as Error).message);
    }
  };

  function schedule() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 900);
  }

  function update(fn: (c: Contact) => Contact) {
    if (!latest.current) return;
    const next = fn(structuredClone(latest.current));
    version.current++;
    latest.current = next;
    setContact(next);
    setSaving('idle');
    schedule();
  }

  useEffect(
    () => () => {
      if (saveTimer.current) void flush();
    },
    [flush],
  );

  if (error && !contact)
    return (
      <main className="page">
        <div className="notice error">{error}</div>
      </main>
    );
  if (!contact || !data) return <main className="page empty">Loading…</main>;

  const isDraft = contact.state !== 'saved';
  const dupes = data.duplicates.filter((d) => !dismissedDupes.has(d.id));

  async function rescan(opts: { cardId: string; rotation?: number; crop?: Box }) {
    await flush();
    setBusy(true);
    setToast('Reading the card again…');
    try {
      const p = await api<ContactPayload>(`/api/contacts/${contact!.id}/rescan`, { method: 'POST', json: opts });
      apply(p);
      setToast('Read again. Fields you edited were kept.');
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addBack(f: File | undefined) {
    if (!f) return;
    await flush();
    setBusy(true);
    setToast('Reading the back of the card…');
    try {
      const res = await fetch(`/api/contacts/${contact!.id}/back`, {
        method: 'POST',
        body: f,
        headers: { 'X-File-Name': encodeURIComponent(f.name) },
        credentials: 'same-origin',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      apply(body);
      setToast('Back added. New details from it are marked.');
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function nextInBatch() {
    if (!contact!.batchId) return go('/batches');
    try {
      const r = await api<{ batch: { items: { status: string; contactId: string | null }[] } }>(`/api/batches/${contact!.batchId}`);
      const next = r.batch.items.find((i) => ['ready', 'needs_attention'].includes(i.status) && i.contactId && i.contactId !== contact!.id);
      go(next ? `/contact/${next.contactId}?from=batch` : `/batch/${contact!.batchId}`);
    } catch {
      go('/batches');
    }
  }

  async function save() {
    setBusy(true);
    try {
      await flush(); // pending edits first, so the save uses the latest revision
      await api(`/api/contacts/${contact!.id}/save`, { method: 'POST', json: { revision: latest.current!.revision } });
      onChanged();
      await nextInBatch();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    await flush();
    await api(`/api/contacts/${contact!.id}/skip`, { method: 'POST', json: {} }).catch((e) => setToast(e.message));
    onChanged();
    await nextInBatch();
  }

  const textField = (k: TextKey, opts: { multiline?: boolean; hideIfEmpty?: boolean } = {}) => {
    const f: TextField = contact[k];
    if (opts.hideIfEmpty && !f.value && f.meta.state === 'not_found') return null;
    const check = isCheck(f.meta);
    const set = (v: string) => update((c) => ({ ...c, [k]: { value: v, meta: edited(c[k].meta, c[k].value) } }));
    return (
      <div className={`f ${check ? 'f-check' : ''}`} key={k}>
        <div className="f-head">
          <label htmlFor={`f-${k}`}>{TEXT_LABELS[k]}</label>
          <StateChip meta={f.meta} empty={!f.value} />
        </div>
        {opts.multiline ? (
          <textarea
            id={`f-${k}`}
            value={f.value}
            rows={2}
            onFocus={() => setFocus(f.meta.box ?? null)}
            onChange={(e) => set(e.target.value)}
            onBlur={() => void flush()}
          />
        ) : (
          <input
            id={`f-${k}`}
            type="text"
            value={f.value}
            autoComplete="off"
            onFocus={() => setFocus(f.meta.box ?? null)}
            onChange={(e) => set(e.target.value)}
            onBlur={() => void flush()}
          />
        )}
        {check && (
          <Why
            meta={f.meta}
            current={f.value}
            onUse={set}
            onApprove={() => update((c) => ({ ...c, [k]: { ...c[k], meta: { ...c[k].meta, state: 'user_corrected', reasons: undefined } } }))}
          />
        )}
      </div>
    );
  };

  const multiField = (k: MultiKey) => {
    const items: MultiValue[] = contact[k];
    const setItem = (id: string, patch: Partial<MultiValue>) =>
      update((c) => ({
        ...c,
        [k]: c[k].map((v) =>
          v.id === id ? { ...v, ...patch, meta: patch.value !== undefined || patch.label !== undefined ? edited(v.meta, v.value) : v.meta } : v,
        ),
      }));
    return (
      <div className={`f ${items.some((v) => isCheck(v.meta)) ? 'f-check' : ''}`} key={k}>
        <div className="f-head">
          <label>
            {MULTI_LABELS[k]}
            {items.length > 1 ? 's' : ''}
          </label>
          {!items.length && <StateChip meta={{ state: 'not_found', source: 'ocr' }} empty />}
        </div>
        {items.map((v) => (
          <div key={v.id} className="stack multi-item" style={{ gap: 6 }}>
            <div className="multi-row">
              <input
                type={INPUT_TYPE[k]}
                inputMode={k === 'phones' ? 'tel' : k === 'emails' ? 'email' : 'url'}
                value={v.value}
                aria-label={MULTI_LABELS[k]}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                onFocus={() => setFocus(v.meta.box ?? null)}
                onChange={(e) => setItem(v.id, { value: e.target.value })}
                onBlur={() => void flush()}
              />
            </div>
            <div className="multi-meta">
              <select value={v.label} aria-label="Type" onChange={(e) => setItem(v.id, { label: e.target.value })}>
                {LABEL_OPTIONS[k].map(([val, text]) => (
                  <option key={val} value={val}>
                    {text}
                  </option>
                ))}
              </select>
              {items.length > 1 && k !== 'websites' && (
                <label className="primary-toggle">
                  <input
                    type="radio"
                    name={`primary-${k}`}
                    checked={v.primary}
                    onChange={() => update((c) => ({ ...c, [k]: c[k].map((x) => ({ ...x, primary: x.id === v.id })) }))}
                  />{' '}
                  Primary
                </label>
              )}
              <span className="spacer" />
              <StateChip meta={v.meta} empty={false} />
              <button
                className="icon-btn"
                style={{ width: 38, height: 38 }}
                aria-label={`Remove ${v.value}`}
                onClick={() => update((c) => ({ ...c, [k]: c[k].filter((x) => x.id !== v.id) }))}
              >
                <X size={16} />
              </button>
            </div>
            {isCheck(v.meta) && (
              <Why
                meta={v.meta}
                current={v.value}
                onUse={(val) => setItem(v.id, { value: val })}
                onApprove={() =>
                  update((c) => ({
                    ...c,
                    [k]: c[k].map((x) => (x.id === v.id ? { ...x, meta: { ...x.meta, state: 'user_corrected', reasons: undefined } } : x)),
                  }))
                }
              />
            )}
          </div>
        ))}
        <button
          className="btn quiet small"
          style={{ justifySelf: 'start' }}
          onClick={() =>
            update((c) => ({
              ...c,
              [k]: [
                ...c[k],
                {
                  id: `n${randomId()}`,
                  value: '',
                  normalized: '',
                  label: LABEL_OPTIONS[k][0][0],
                  primary: c[k].length === 0,
                  meta: { state: 'user_corrected', source: 'user' },
                },
              ],
            }))
          }
        >
          <Plus size={16} /> Add {MULTI_LABELS[k].toLowerCase()}
        </button>
      </div>
    );
  };

  return (
    <>
      <header className="topbar">
        <button
          className="icon-btn"
          aria-label="Back"
          onClick={() =>
            void flush().then(() =>
              from === 'batch' && contact.batchId ? go(`/batch/${contact.batchId}`) : history.length > 1 ? history.back() : go('/contacts'),
            )
          }
        >
          <ArrowLeft size={20} />
        </button>
        <h1>{contact.name.value || contact.company.value || (isDraft ? 'New card' : 'Contact')}</h1>
        <span className="tiny" aria-live="polite">
          {saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : saving === 'error' ? 'Not saved' : ''}
        </span>
      </header>
      <main className="page">
        {error && (
          <div className="notice error" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
        <div className="review">
          <div className="viewer-wrap">
            <CardViewer cards={cards} focus={focus} busy={busy} onRescan={rescan} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn small" disabled={busy || !cards.length} onClick={() => backRef.current?.click()}>
                <FilePlus2 size={16} /> {cards.some((c) => c.side === 'back') ? 'Replace back' : 'Add back of card'}
              </button>
              <input
                ref={backRef}
                className="visually-hidden"
                type="file"
                accept={ACCEPT_ATTR}
                capture="environment"
                onChange={(e) => void addBack(e.target.files?.[0]).finally(() => (e.target.value = ''))}
              />
            </div>
            {lines.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary className="small muted">All text read from the card ({lines.length} lines)</summary>
                <ul className="small" style={{ paddingLeft: 18 }}>
                  {lines.map((l) => (
                    <li key={l.id}>
                      <button
                        className="btn quiet small"
                        style={{ padding: 0, minHeight: 30, whiteSpace: 'normal', textAlign: 'left' }}
                        onClick={() => setFocus(l.box)}
                      >
                        {l.text}
                      </button>
                      {l.disputed && <span className="pill amber">uncertain</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          <div className="stack">
            {isDraft && (
              <div className={data.attention.length ? 'notice warn' : 'notice ok'}>
                {data.attention.length
                  ? `Check ${data.attention.length === 1 ? 'this field' : 'these'}: ${data.attention.join(', ')}. Everything else was read without warnings.`
                  : 'Read without warnings. Glance over it and save.'}
                {contact.state === 'skipped' && ' (This card was skipped.)'}
              </div>
            )}
            {dupes.length > 0 && (
              <div className="dupes">
                {dupes.slice(0, 3).map((d) => (
                  <div key={d.id} className="stack" style={{ gap: 6 }}>
                    <div>
                      <strong>{d.strength === 'strong' ? 'Probably already in your contacts' : 'Possibly already in your contacts'}:</strong>{' '}
                      {d.name || d.company || 'a contact'}
                      {d.company && d.name ? ` (${d.company})` : ''} — {d.reasons.join(', ')}
                      {d.state !== 'saved' && ' (unsaved card)'}
                    </div>
                    <div className="row">
                      <button className="btn small" onClick={() => setMerging(d)}>
                        Merge…
                      </button>
                      <a className="btn small" href={`#/contact/${d.id}`}>
                        View
                      </a>
                      <button className="btn small quiet" onClick={() => setDismissedDupes(new Set([...dismissedDupes, d.id]))}>
                        Keep separate
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <section className="fields" aria-label="Card details">
              {textField('name')}
              {textField('credentials', { hideIfEmpty: true })}
              {textField('title')}
              {textField('company')}
              {multiField('emails')}
              {multiField('phones')}
              {multiField('websites')}
              {textField('address', { multiline: true })}
              <LinkedInField contact={contact} onApply={apply} onLocal={(c) => update(() => c)} />
            </section>

            <section className="panel stack" aria-label="Your notes">
              <label className="field">
                Event / where you met
                <input
                  type="text"
                  list="events"
                  value={contact.event}
                  onChange={(e) => update((c) => ({ ...c, event: e.target.value }))}
                  onBlur={() => void flush()}
                />
                <datalist id="events">
                  {facets.events.map((e) => (
                    <option key={e.name} value={e.name} />
                  ))}
                </datalist>
              </label>
              <label className="field">
                Tags (comma separated)
                <input
                  type="text"
                  defaultValue={contact.tags.join(', ')}
                  key={contact.id + contact.tags.join('|')}
                  onBlur={(e) => {
                    update((c) => ({
                      ...c,
                      tags: e.target.value
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    }));
                    void flush();
                  }}
                />
              </label>
              <div className="filters">
                <label className="field">
                  Status
                  <select value={contact.status} onChange={(e) => update((c) => ({ ...c, status: e.target.value as Contact['status'] }))}>
                    <option value="new">New</option>
                    <option value="follow_up">Follow up</option>
                    <option value="connected">Connected</option>
                  </select>
                </label>
                <label className="field">
                  Follow up on
                  <input type="date" value={contact.followUp} onChange={(e) => update((c) => ({ ...c, followUp: e.target.value }))} />
                </label>
              </div>
              <label className="field">
                Notes
                <textarea
                  value={contact.notes}
                  onChange={(e) => update((c) => ({ ...c, notes: e.target.value }))}
                  onBlur={() => void flush()}
                  placeholder="What did you talk about?"
                />
              </label>
            </section>

            <div className="sticky-actions">
              {isDraft ? (
                <>
                  <button className="btn primary" disabled={busy} onClick={save} style={{ flex: 1 }}>
                    <Check size={18} /> Save contact{from === 'batch' ? ' & next' : ''}
                  </button>
                  {contact.state !== 'skipped' ? (
                    <button className="btn" disabled={busy} onClick={skip}>
                      Skip card
                    </button>
                  ) : (
                    <button className="btn" onClick={() => api<ContactPayload>(`/api/contacts/${contact.id}/unskip`, { method: 'POST', json: {} }).then(apply)}>
                      Un-skip
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="small muted" style={{ flex: 1, alignSelf: 'center' }}>
                    Saved contact. Changes save automatically.
                  </span>
                  <button className="btn danger" onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={16} /> Delete
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </main>

      {merging && (
        <MergeSheet
          current={contact}
          other={merging}
          onClose={() => setMerging(null)}
          onMerged={(id) => {
            onChanged();
            go(`/contact/${id}`);
          }}
        />
      )}
      {confirmDelete && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true">
          <div className="sheet stack">
            <h2>Delete {contact.name.value || 'this contact'}?</h2>
            <p>The contact is removed from Buz Cards. Files you already exported are not affected.</p>
            <div className="row">
              <button
                className="btn danger"
                onClick={async () => {
                  await api(`/api/contacts/${contact.id}`, { method: 'DELETE' });
                  onChanged();
                  go('/contacts');
                }}
              >
                Delete
              </button>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div key={toast} className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </>
  );
}

function StateChip({ meta, empty }: { meta: FieldMeta; empty: boolean }) {
  if (meta.state === 'needs_review') return <span className="pill amber">Check</span>;
  if (meta.state === 'user_corrected') return <span className="pill teal">{meta.source === 'user' ? 'Edited' : 'Confirmed'}</span>;
  if (meta.state === 'enriched') return <span className="pill teal">Confirmed match</span>;
  if (meta.source === 'qr' && !empty) return <span className="pill green">From QR code</span>;
  if (empty || meta.state === 'not_found') return <span className="tiny">Not found on card</span>;
  return null;
}

function Why({ meta, current, onUse, onApprove }: { meta: FieldMeta; current: string; onUse: (v: string) => void; onApprove: () => void }) {
  const alts = (meta.alternatives ?? []).filter((a) => a && a !== current);
  return (
    <div className="why">
      {meta.reasons?.length ? (
        <ul>
          {meta.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      <div className="alt">
        {alts.map((a) => (
          <button key={a} className="btn" onClick={() => onUse(a)}>
            Use “{a}”
          </button>
        ))}
        <button className="btn" onClick={onApprove}>
          <Check size={14} /> Looks right
        </button>
      </div>
    </div>
  );
}

function LinkedInField({ contact, onApply, onLocal }: { contact: Contact; onApply: (p: ContactPayload) => void; onLocal: (c: Contact) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [manual, setManual] = useState<{ linkedin: string; web: string } | null>(null);
  const li = contact.linkedin;
  useEffect(() => {
    api<{ linkedin: string; web: string }>(`/api/contacts/${contact.id}/linkedin/manual`)
      .then(setManual)
      .catch(() => undefined);
  }, [contact.id, contact.name.value, contact.company.value]);

  async function confirm(url: string) {
    setBusy(true);
    try {
      onApply(await api<ContactPayload>(`/api/contacts/${contact.id}/linkedin/confirm`, { method: 'POST', json: { url } }));
      setPaste('');
      setMsg(null);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function search() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<ContactPayload & { candidates: unknown[] }>(`/api/contacts/${contact.id}/linkedin/search`, { method: 'POST', json: {} });
      onApply(r);
      if (!r.candidates.length) setMsg('No matching LinkedIn profiles found. Try the manual search.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  void onLocal;
  return (
    <div className={`f ${li.meta.state === 'needs_review' ? 'f-check' : ''}`}>
      <div className="f-head">
        <label>LinkedIn</label>
        {li.url && <StateChip meta={li.meta} empty={false} />}
      </div>
      {li.url ? (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <a href={li.url} target="_blank" rel="noreferrer noopener" style={{ wordBreak: 'break-all' }}>
            {li.url.replace(/^https:\/\/www\./, '')}
          </a>
          <button className="btn small quiet" onClick={() => confirm('')}>
            Remove
          </button>
        </div>
      ) : (
        <>
          <div className="row">
            <button
              className="btn small"
              disabled={busy || !contact.name.value}
              onClick={search}
              title="Uses the optional search API configured on the computer"
            >
              <Search size={14} /> Find profile
            </button>
            {manual && (
              <>
                <a className="btn small quiet" href={manual.linkedin} target="_blank" rel="noreferrer noopener">
                  Search on LinkedIn <ExternalLink size={14} />
                </a>
                <a className="btn small quiet" href={manual.web} target="_blank" rel="noreferrer noopener">
                  Web search <ExternalLink size={14} />
                </a>
              </>
            )}
          </div>
          {li.candidates.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="tiny">Possible matches (not confirmed). Open one to check, then confirm the right person:</div>
              {li.candidates.map((c) => (
                <div key={c.url} className="panel" style={{ padding: 10 }}>
                  <a href={c.url} target="_blank" rel="noreferrer noopener" className="small" style={{ fontWeight: 600 }}>
                    {c.title}
                  </a>
                  <div className="tiny">{c.snippet}</div>
                  <button className="btn small" style={{ marginTop: 6 }} disabled={busy} onClick={() => confirm(c.url)}>
                    This is them
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="multi-row" style={{ gridTemplateColumns: '1fr auto' }}>
            <input type="url" placeholder="Paste a linkedin.com/in/… link" value={paste} onChange={(e) => setPaste(e.target.value)} autoCapitalize="off" />
            <button className="btn small" disabled={!paste || busy} onClick={() => confirm(paste)}>
              Use link
            </button>
          </div>
        </>
      )}
      {msg && (
        <div className="small" style={{ color: 'var(--amber)' }}>
          {msg}
        </div>
      )}
    </div>
  );
}

function MergeSheet({ current, other, onClose, onMerged }: { current: Contact; other: Duplicate; onClose: () => void; onMerged: (id: string) => void }) {
  const [target, setTarget] = useState<Contact | null>(null);
  const [choose, setChoose] = useState<Record<string, 'primary' | 'other'>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getContact(other.id)
      .then((p) => setTarget(p.contact))
      .catch((e) => setErr(e.message));
  }, [other.id]);
  // The existing (saved) contact is kept as the primary record; this card's details are added to it.
  const keys: TextKey[] = ['name', 'credentials', 'title', 'company', 'address'];
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true">
      <div className="sheet stack">
        <h2>Merge into {other.name || other.company || 'existing contact'}</h2>
        {err && <div className="notice error">{err}</div>}
        {target && (
          <>
            <p className="small muted">E-mails, phones, websites, tags and notes from both are kept. Where the two differ, choose which value to keep:</p>
            {keys
              .filter((k) => current[k].value && target[k].value && current[k].value !== target[k].value)
              .map((k) => (
                <fieldset key={k} className="panel" style={{ padding: 10 }}>
                  <legend className="small" style={{ fontWeight: 700 }}>
                    {TEXT_LABELS[k]}
                  </legend>
                  <label className="row small">
                    <input type="radio" name={k} checked={(choose[k] ?? 'primary') === 'primary'} onChange={() => setChoose({ ...choose, [k]: 'primary' })} />{' '}
                    {target[k].value} (existing)
                  </label>
                  <label className="row small">
                    <input type="radio" name={k} checked={choose[k] === 'other'} onChange={() => setChoose({ ...choose, [k]: 'other' })} /> {current[k].value}{' '}
                    (this card)
                  </label>
                </fieldset>
              ))}
            <div className="row">
              <button
                className="btn primary"
                onClick={async () => {
                  try {
                    const r = await api<ContactPayload>('/api/contacts/merge', { method: 'POST', json: { primaryId: target.id, otherId: current.id, choose } });
                    onMerged(r.contact.id);
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              >
                Merge
              </button>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

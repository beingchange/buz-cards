import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Pause, Play, RotateCcw, Trash2, RefreshCw, Check } from 'lucide-react';
import { api, getBatch, type ContactWithMeta, type Info } from '../api';
import { go } from '../App';
import { serverIdFor, status as outboxStatus, subscribe, type OutboxStatus } from '../outbox';
import type { Batch, BatchItem, BatchItemStatus } from '../../shared/types';
import { formatDuration, relativeDate } from '../util';

const STATUS: Record<BatchItemStatus, { text: string; cls: string }> = {
  queued: { text: 'Queued', cls: '' },
  processing: { text: 'Reading…', cls: 'teal' },
  ready: { text: 'Ready to save', cls: 'green' },
  needs_attention: { text: 'Check fields', cls: 'amber' },
  saved: { text: 'Saved', cls: 'green' },
  skipped: { text: 'Skipped', cls: '' },
  failed: { text: 'Failed', cls: 'red' },
};

export function BatchesScreen() {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ batches: Batch[] }>('/api/batches')
      .then((r) => setBatches(r.batches))
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <header className="topbar">
        <h1>Review</h1>
      </header>
      <main className="page">
        {error && <div className="notice error">{error}</div>}
        {batches && !batches.length && (
          <div className="empty">
            Nothing to review yet. <a href="#/">Scan a card</a> or choose photos from your gallery.
          </div>
        )}
        {batches && batches.length > 0 && (
          <div className="list">
            {batches.map((b) => {
              const c = countItems(b.items);
              return (
                <a key={b.id} href={`#/batch/${b.id}`} className="list-item no-check cover" style={{ gridTemplateColumns: '1fr auto' }}>
                  <div className="main">
                    <div className="title">{b.label || (b.kind === 'single' ? 'Single scan' : 'Batch')}</div>
                    <div className="sub">
                      {relativeDate(b.createdAt)} · {b.items.length} photo{b.items.length === 1 ? '' : 's'} · {c.saved} saved
                      {c.toReview ? ` · ${c.toReview} to review` : ''}
                      {c.working ? ` · ${c.working} reading` : ''}
                      {c.failed ? ` · ${c.failed} failed` : ''}
                    </div>
                  </div>
                  {c.toReview + c.working + c.failed > 0 ? <span className="pill amber">Open</span> : <span className="pill green">Done</span>}
                </a>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}

function countItems(items: BatchItem[]) {
  const n = (s: BatchItemStatus[]) => items.filter((i) => s.includes(i.status)).length;
  return {
    saved: n(['saved']),
    toReview: n(['ready', 'needs_attention']),
    working: n(['queued', 'processing']),
    failed: n(['failed']),
    skipped: n(['skipped']),
  };
}

export function BatchScreen({ id, info }: { id: string; info: Info | null }) {
  const localId = id.startsWith('l-') ? id.slice(2) : null;
  const [serverId, setServerId] = useState<string | null>(localId ? null : id);
  const [upload, setUpload] = useState<OutboxStatus | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [contacts, setContacts] = useState<ContactWithMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<null | 'discard' | 'save'>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Local (still uploading) batch: follow the outbox until the server batch exists.
  useEffect(() => {
    if (!localId) return;
    const check = async () => {
      setUpload(await outboxStatus(localId));
      const sid = await serverIdFor(localId);
      if (sid) setServerId(sid);
    };
    void check();
    return subscribe(() => void check());
  }, [localId]);

  const load = useCallback(async () => {
    if (!serverId) return;
    try {
      const r = await getBatch(serverId);
      setBatch(r.batch);
      setContacts(r.contacts);
      setError(null);
      // A single scan goes straight to its review screen once it has been read.
      if (r.batch.kind === 'single' && r.batch.items.length === 1) {
        const it = r.batch.items[0];
        if (['ready', 'needs_attention'].includes(it.status) && it.contactId && (!upload || upload.pending === 0)) go(`/contact/${it.contactId}?from=batch`);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [serverId, upload]);

  useEffect(() => {
    void load();
    if (!serverId) return;
    // Live progress via Server-Sent Events, with polling as a fallback.
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/events');
      es.addEventListener('queue', () => void load());
    } catch {
      /* ignore */
    }
    const t = setInterval(load, 4000);
    return () => {
      es?.close();
      clearInterval(t);
    };
  }, [serverId, load]);

  const byId = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const counts = batch ? countItems(batch.items) : null;
  const done = batch ? batch.items.filter((i) => i.durationMs && i.status !== 'queued' && i.status !== 'processing') : [];
  const avg = done.length >= 2 ? done.reduce((a, i) => a + (i.durationMs ?? 0), 0) / done.length : null;
  const current = batch?.items.find((i) => i.status === 'processing');
  const remaining = counts ? counts.working : 0;

  async function act(path: string, body?: unknown) {
    try {
      await api(path, { method: 'POST', json: body ?? {} });
      await load();
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  async function saveSelected() {
    const ids = [...selected];
    try {
      const r = await api<{ results: { id: string; ok: boolean }[] }>('/api/contacts/save-many', { method: 'POST', json: { ids } });
      setToast(`Saved ${r.results.filter((x) => x.ok).length} contact${ids.length === 1 ? '' : 's'}.`);
      setSelected(new Set());
      setConfirm(null);
      await load();
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  const reviewable = batch?.items.filter((i) => ['ready', 'needs_attention'].includes(i.status) && i.contactId) ?? [];
  const nextToReview = reviewable[0];

  return (
    <>
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={() => go('/batches')}>
          <ArrowLeft size={20} />
        </button>
        <h1>{batch?.label || (batch?.kind === 'single' ? 'Single scan' : 'Batch')}</h1>
      </header>
      <main className="page stack">
        {error && <div className="notice error">{error}</div>}
        {upload && (upload.pending > 0 || upload.rejected.length > 0) && (
          <div className={upload.lastError ? 'notice warn' : 'notice'}>
            <div>
              Uploading photo {Math.min(upload.uploaded + 1, upload.total)} of {upload.total} to the computer…
            </div>
            <div className="progress" style={{ marginTop: 8 }}>
              <div style={{ width: `${(100 * upload.uploaded) / Math.max(1, upload.total)}%` }} />
            </div>
            {upload.lastError && <div style={{ marginTop: 6 }}>{upload.lastError}</div>}
            {upload.rejected.map((f) => (
              <div key={f.key} className="small" style={{ marginTop: 6 }}>
                Not accepted: {f.name} — {f.error}
              </div>
            ))}
          </div>
        )}
        {batch && counts && (
          <section className="panel stack">
            <div className="counts">
              <span>
                <b>{counts.saved}</b> saved
              </span>
              <span>
                <b>{counts.toReview}</b> to review
              </span>
              <span>
                <b>{counts.working}</b> waiting
              </span>
              {counts.failed > 0 && (
                <span>
                  <b>{counts.failed}</b> failed
                </span>
              )}
              {counts.skipped > 0 && (
                <span>
                  <b>{counts.skipped}</b> skipped
                </span>
              )}
            </div>
            <div className="progress" aria-label="Progress">
              <div style={{ width: `${(100 * (batch.items.length - counts.working)) / Math.max(1, batch.items.length)}%` }} />
            </div>
            <div className="small muted">
              {batch.paused
                ? 'Paused. Cards already read stay available.'
                : current
                  ? `Reading ${current.fileName}${avg && remaining > 1 ? ` · about ${formatDuration(avg * remaining)} left (measured)` : ''}`
                  : remaining
                    ? 'Waiting for the reader…'
                    : upload && upload.pending > 0
                      ? `${upload.pending} photo${upload.pending === 1 ? ' is' : 's are'} still uploading from this device…`
                      : 'All photos have been read.'}
              {batch.event && ` · Event: ${batch.event}`}
            </div>
            <div className="row">
              {nextToReview && (
                <a className="btn primary" href={`#/contact/${nextToReview.contactId}?from=batch`}>
                  Review next card
                </a>
              )}
              {remaining > 0 &&
                (batch.paused ? (
                  <button className="btn" onClick={() => api(`/api/batches/${batch.id}`, { method: 'PATCH', json: { paused: false } }).then(load)}>
                    <Play size={16} /> Resume
                  </button>
                ) : (
                  <button className="btn" onClick={() => api(`/api/batches/${batch.id}`, { method: 'PATCH', json: { paused: true } }).then(load)}>
                    <Pause size={16} /> Pause
                  </button>
                ))}
              {reviewable.length > 0 && (
                <button
                  className="btn"
                  title="Read unsaved cards again with the current recognition engine; your edits are kept"
                  onClick={() => act(`/api/batches/${batch.id}/reread`)}
                >
                  <RefreshCw size={16} /> Re-read unsaved
                </button>
              )}
              <button className="btn quiet" onClick={() => setConfirm('discard')}>
                <Trash2 size={16} /> Discard unsaved
              </button>
            </div>
            {info && <p className="tiny">Processing continues on the computer if this phone locks or you close the page. Come back any time.</p>}
          </section>
        )}

        {batch && (
          <>
            <div className="toolbar">
              <label className="row small" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  className="check"
                  checked={reviewable.length > 0 && reviewable.every((i) => selected.has(i.contactId!))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(reviewable.map((i) => i.contactId!)) : new Set())}
                  disabled={!reviewable.length}
                />
                Select all unsaved
              </label>
              <button className="btn small primary" disabled={!selected.size} onClick={() => setConfirm('save')}>
                <Check size={16} /> Save selected ({selected.size})
              </button>
            </div>
            <div className="list">
              {batch.items.map((it) => {
                const c = it.contactId ? byId.get(it.contactId) : undefined;
                const st = STATUS[it.status];
                const canSelect = ['ready', 'needs_attention'].includes(it.status) && !!it.contactId;
                const email = c?.emails.find((e) => e.primary)?.value;
                return (
                  <div key={it.id} className="list-item">
                    <input
                      type="checkbox"
                      className="check"
                      aria-label={`Select ${c?.name.value || it.fileName}`}
                      disabled={!canSelect}
                      checked={!!it.contactId && selected.has(it.contactId)}
                      onChange={(e) => {
                        const s = new Set(selected);
                        if (e.target.checked) s.add(it.contactId!);
                        else s.delete(it.contactId!);
                        setSelected(s);
                      }}
                    />
                    {it.cardId ? (
                      <img className="thumb" alt="" loading="lazy" src={`/api/cards/${it.cardId}/image?variant=thumb&v=${it.updatedAt}`} />
                    ) : (
                      <div className="thumb" />
                    )}
                    <a className="main cover" href={it.contactId && c ? `#/contact/${it.contactId}?from=batch` : undefined}>
                      <div className="title">{c ? c.name.value || c.company.value || 'No name found' : it.fileName}</div>
                      <div className="sub">
                        {it.status === 'failed'
                          ? it.error
                          : c
                            ? [c.company.value, email].filter(Boolean).join(' · ') || 'Open to check'
                            : it.status === 'queued'
                              ? `#${it.position} in line`
                              : ''}
                      </div>
                      {c && c.attention.length > 0 && it.status !== 'saved' && <div className="tiny">Check: {c.attention.join(', ')}</div>}
                      {c?.duplicates?.some((d) => d.strength === 'strong') && (
                        <div className="tiny" style={{ color: 'var(--amber)' }}>
                          Possible duplicate of {c.duplicates.find((d) => d.strength === 'strong')!.name || 'another contact'}
                        </div>
                      )}
                    </a>
                    <div className="stack" style={{ justifyItems: 'end', gap: 6 }}>
                      <span className={`pill ${st.cls}`}>{st.text}</span>
                      {it.status === 'failed' && it.cardId && (
                        <button className="btn small" onClick={() => act(`/api/batches/${batch.id}/items/${it.id}/retry`)}>
                          <RotateCcw size={14} /> Retry
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {counts && counts.working === 0 && counts.toReview === 0 && !(upload && upload.pending > 0) && (
              <div className="notice ok">
                This batch is finished. <a href="#/">Start another batch</a> or <a href="#/contacts">export your contacts</a>.
              </div>
            )}
          </>
        )}
        {!batch && !error && <div className="empty">Preparing…</div>}
      </main>

      {confirm === 'save' && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true">
          <div className="sheet stack">
            <h2>
              Save {selected.size} contact{selected.size === 1 ? '' : 's'}?
            </h2>
            {(() => {
              const flagged = [...selected].filter((id) => (byId.get(id)?.attention.length ?? 0) > 0);
              return flagged.length ? (
                <div className="notice warn">
                  {flagged.length} of them still have fields marked “check” (
                  {flagged
                    .map((id) => byId.get(id)?.name.value || 'unnamed')
                    .slice(0, 4)
                    .join(', ')}
                  {flagged.length > 4 ? '…' : ''}). They will be saved as they are and stay marked “unverified” in exports.
                </div>
              ) : (
                <p className="muted">All selected cards were read without warnings.</p>
              );
            })()}
            <div className="row">
              <button className="btn primary" onClick={saveSelected}>
                Save {selected.size}
              </button>
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {confirm === 'discard' && batch && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true">
          <div className="sheet stack">
            <h2>Discard unsaved cards?</h2>
            <p>
              {batch.items.filter((i) => i.status !== 'saved').length} unsaved photo(s) and their drafts will be deleted. The {counts?.saved ?? 0} contact(s)
              already saved from this batch are kept.
            </p>
            <div className="row">
              <button
                className="btn danger"
                onClick={async () => {
                  await api(`/api/batches/${batch.id}/discard`, { method: 'POST', json: {} });
                  go('/batches');
                }}
              >
                Discard unsaved
              </button>
              <button className="btn" onClick={() => setConfirm(null)}>
                Keep them
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

import { useEffect, useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { api, queryString, type ContactWithMeta, type Info } from '../api';
import { today } from '../util';

interface Facets {
  events: { name: string; count: number }[];
  tags: { name: string; count: number }[];
  followUps: { due: number; upcoming: number };
}

export function ContactsScreen({ info }: { info: Info | null }) {
  const [q, setQ] = useState('');
  const [event, setEvent] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [sort, setSort] = useState('recent');
  const [list, setList] = useState<ContactWithMeta[] | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters = useMemo(() => ({ q, event, status, tag, followUp, sort }), [q, event, status, tag, followUp, sort]);
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ contacts: ContactWithMeta[] }>(`/api/contacts${queryString({ state: 'saved', ...filters })}`)
        .then((r) => {
          setList(r.contacts);
          setError(null);
        })
        .catch((e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [filters]);
  useEffect(() => {
    api<Facets>('/api/facets')
      .then(setFacets)
      .catch(() => undefined);
  }, []);

  const filtered = !!(q || event || status || tag || followUp);
  const t = today();
  return (
    <>
      <header className="topbar">
        <h1>
          Contacts{' '}
          {list ? (
            <span className="muted small">
              ({list.length}
              {filtered ? ' shown' : ''})
            </span>
          ) : null}
        </h1>
        <button className="btn small primary" onClick={() => setExporting(true)}>
          <Download size={16} /> Export
        </button>
      </header>
      <main className="page">
        {(info?.counts.drafts ?? 0) > 0 && (
          <div className="notice warn" style={{ marginBottom: 12 }}>
            {info!.counts.drafts} scanned card{info!.counts.drafts === 1 ? ' is' : 's are'} not saved yet and {info!.counts.drafts === 1 ? 'is' : 'are'} not
            listed here. <a href="#/batches">Review them</a>.
          </div>
        )}
        {facets && facets.followUps.due > 0 && (
          <button
            className="notice warn"
            style={{ width: '100%', textAlign: 'left', border: '1px solid var(--amber-line)', cursor: 'pointer', marginBottom: 12 }}
            onClick={() => setFollowUp('due')}
          >
            {facets.followUps.due} follow-up{facets.followUps.due === 1 ? ' is' : 's are'} due or overdue. Show them.
          </button>
        )}
        <div className="stack">
          <label className="row" style={{ position: 'relative' }}>
            <Search size={18} style={{ position: 'absolute', left: 12, color: 'var(--ink-3)' }} aria-hidden />
            <input
              type="search"
              placeholder="Search name, company, email, phone, notes…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ paddingLeft: 38 }}
              aria-label="Search contacts"
            />
          </label>
          <div className="filters">
            <select value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Event">
              <option value="">All events</option>
              {facets?.events.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name} ({e.count})
                </option>
              ))}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">Any status</option>
              <option value="new">New</option>
              <option value="follow_up">Follow up</option>
              <option value="connected">Connected</option>
            </select>
            <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
              <option value="">Any tag</option>
              {facets?.tags.map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name} ({x.count})
                </option>
              ))}
            </select>
            <select value={followUp} onChange={(e) => setFollowUp(e.target.value)} aria-label="Follow-up">
              <option value="">Any follow-up</option>
              <option value="due">Due or overdue</option>
              <option value="upcoming">Upcoming</option>
              <option value="any">Has a date</option>
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
              <option value="recent">Newest first</option>
              <option value="name">Name A–Z</option>
              <option value="company">Company A–Z</option>
              <option value="followup">Follow-up date</option>
            </select>
          </div>
          {filtered && (
            <button
              className="btn quiet small"
              style={{ justifySelf: 'start' }}
              onClick={() => {
                setQ('');
                setEvent('');
                setStatus('');
                setTag('');
                setFollowUp('');
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {error && <div className="notice error">{error}</div>}
        {list && list.length > 0 && (
          <div className="toolbar">
            <label className="row small" style={{ gap: 6 }}>
              <input
                type="checkbox"
                className="check"
                checked={list.every((c) => selected.has(c.id))}
                onChange={(e) => setSelected(e.target.checked ? new Set(list.map((c) => c.id)) : new Set())}
              />
              Select all shown
            </label>
            {selected.size > 0 && (
              <>
                <span className="small">{selected.size} selected</span>
                <button className="btn small quiet" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </>
            )}
          </div>
        )}
        {list && list.length === 0 && (
          <div className="empty">{filtered ? 'No contacts match these filters.' : 'No saved contacts yet. Scan a card to start.'}</div>
        )}
        {list && list.length > 0 && (
          <div className="list">
            {list.map((c) => {
              const email = c.emails.find((e) => e.primary) ?? c.emails[0];
              const phone = c.phones.find((p) => p.primary) ?? c.phones[0];
              return (
                <div key={c.id} className="list-item">
                  <input
                    type="checkbox"
                    className="check"
                    aria-label={`Select ${c.name.value}`}
                    checked={selected.has(c.id)}
                    onChange={(e) => {
                      const s = new Set(selected);
                      if (e.target.checked) s.add(c.id);
                      else s.delete(c.id);
                      setSelected(s);
                    }}
                  />
                  {c.cardIds[0] ? (
                    <img className="thumb" alt="" loading="lazy" src={`/api/cards/${c.cardIds[0]}/image?variant=thumb`} />
                  ) : (
                    <div className="thumb" />
                  )}
                  <a className="main cover" href={`#/contact/${c.id}`}>
                    <div className="title">{c.name.value || c.company.value || email?.value || 'Unnamed'}</div>
                    <div className="sub">{[c.title.value, c.company.value].filter(Boolean).join(', ')}</div>
                    <div className="sub">{[email?.value, phone?.value].filter(Boolean).join(' · ') || 'No e-mail or phone'}</div>
                  </a>
                  <div className="stack" style={{ justifyItems: 'end', gap: 4 }}>
                    {c.followUp && (
                      <span className={`pill ${c.followUp <= t ? 'amber' : ''}`}>{c.followUp <= t ? 'Follow up now' : `Follow up ${c.followUp}`}</span>
                    )}
                    {c.status !== 'new' && <span className="pill teal">{c.status === 'follow_up' ? 'Follow up' : 'Connected'}</span>}
                    {c.attention.length > 0 && (
                      <span className="pill amber" title={c.attention.join(', ')}>
                        Unverified
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
      {exporting && <ExportSheet selected={[...selected]} filters={filtered ? filters : null} onClose={() => setExporting(false)} />}
    </>
  );
}

interface Summary {
  scope: string;
  count: number;
  withEmail: number;
  withoutEmail: number;
  withPhone: number;
  withoutPhone: number;
  unverified: number;
  drafts: number;
  draftsInApp: number;
}

function ExportSheet({ selected, filters, onClose }: { selected: string[]; filters: Record<string, string> | null; onClose: () => void }) {
  const [scope, setScope] = useState<'all' | 'filtered' | 'selected'>(selected.length ? 'selected' : filters ? 'filtered' : 'all');
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const params = useMemo(() => {
    const p: Record<string, string> = { scope, includeDrafts: includeDrafts ? '1' : '' };
    if (scope === 'selected') p.ids = selected.join(',');
    if (scope === 'filtered' && filters) Object.assign(p, filters);
    return queryString(p);
  }, [scope, includeDrafts, selected, filters]);
  useEffect(() => {
    setSummary(null);
    api<Summary>(`/api/export/summary${params}`)
      .then((s) => {
        setSummary(s);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, [params]);
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="export-title">
      <div className="sheet stack">
        <h2 id="export-title">Export contacts</h2>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
          <label className="row">
            <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> All saved contacts
          </label>
          <label className="row">
            <input type="radio" checked={scope === 'filtered'} disabled={!filters} onChange={() => setScope('filtered')} /> Current search and filters
          </label>
          <label className="row">
            <input type="radio" checked={scope === 'selected'} disabled={!selected.length} onChange={() => setScope('selected')} /> Selected ({selected.length})
          </label>
          <label className="row small">
            <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} /> Also include unsaved (unreviewed) cards —
            marked “DRAFT” in Excel
          </label>
        </fieldset>
        {err && <div className="notice error">{err}</div>}
        {summary && (
          <div className={summary.withoutEmail || summary.withoutPhone || summary.unverified ? 'notice warn' : 'notice'}>
            <strong>
              {summary.count} contact{summary.count === 1 ? '' : 's'}
            </strong>{' '}
            — {summary.scope}.
            <br />
            {summary.withEmail} with e-mail, <b>{summary.withoutEmail} without</b>. {summary.withPhone} with phone, <b>{summary.withoutPhone} without</b>.
            {summary.unverified > 0 && (
              <>
                <br />
                {summary.unverified} still have fields flagged “check” (shown in the Review state column).
              </>
            )}
            {!includeDrafts && summary.draftsInApp > 0 && (
              <>
                <br />
                {summary.draftsInApp} unsaved card{summary.draftsInApp === 1 ? ' is' : 's are'} not included.
              </>
            )}
          </div>
        )}
        <div className="row">
          <a
            className={`btn primary ${!summary?.count ? 'disabled' : ''}`}
            aria-disabled={!summary?.count}
            href={summary?.count ? `/api/export.xlsx${params}` : undefined}
            download
          >
            <Download size={16} /> Excel (.xlsx)
          </a>
          <a className="btn" aria-disabled={!summary?.count} href={summary?.count ? `/api/export.vcf${params}` : undefined} download>
            <Download size={16} /> Phone contacts (.vcf)
          </a>
        </div>
        <details>
          <summary className="small">How to add the .vcf to your phone</summary>
          <div className="small stack" style={{ marginTop: 8 }}>
            <p style={{ margin: 0 }}>
              <b>iPhone:</b> tap the downloaded .vcf (Files app or Safari downloads) → Share → Contacts, or open it and tap “Add All Contacts”. Contacts with
              several cards are added one by one.
            </p>
            <p style={{ margin: 0 }}>
              <b>Android:</b> open the .vcf from Downloads and choose Contacts, or in the Contacts app use Fix & manage → Import from file. Pick the account
              (e.g. Google) to store them in.
            </p>
            <p style={{ margin: 0 }} className="tiny">
              Importing twice creates duplicates in the phone’s address book; the phone, not Buz Cards, controls that step.
            </p>
          </div>
        </details>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

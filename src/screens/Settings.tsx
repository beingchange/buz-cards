import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { ApiError, type Info } from '../api';

interface Preview {
  token: string;
  kind: 'backup' | 'legacy';
  manifest: { createdAt?: string; counts?: { contacts: number; images: number } };
  total: number;
  newContacts: number;
  sameIdIdentical: number;
  sameIdDifferent: number;
  possibleDuplicates: { incoming: string; existing: string; reasons: string[] }[];
  images: number;
  warnings: string[];
}

export function SettingsScreen({ info, onShowIntro }: { info: Info | null; onShowIntro: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [policy, setPolicy] = useState<'skip' | 'overwrite' | 'copy'>('skip');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function choose(f: File | undefined) {
    if (!f) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/restore/preview', { method: 'POST', body: f, credentials: 'same-origin' });
      const body = await res.json();
      if (!res.ok) throw new ApiError(body.error, res.status);
      setPreview(body);
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await fetch('/api/restore/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: preview.token, policy }),
        credentials: 'same-origin',
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error);
      setMsg({
        kind: 'ok',
        text: `Restored: ${r.added} added, ${r.replaced} replaced, ${r.copied} imported as copies, ${r.skipped} kept as they were. ${r.images} card image(s).`,
      });
      setPreview(null);
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <h1>Settings</h1>
      </header>
      <main className="page stack">
        {info?.accessCode && (
          <section className="panel stack">
            <h2 style={{ margin: 0 }}>Use it on your phone</h2>
            {info.lanUrls.length ? (
              <>
                <p className="small" style={{ margin: 0 }}>
                  On the same Wi-Fi, open one of these on your phone, then enter the access code:
                </p>
                <ul className="small" style={{ margin: 0 }}>
                  {info.lanUrls.map((u) => (
                    <li key={u}>
                      <b>{u}</b>
                    </li>
                  ))}
                </ul>
                <div>
                  Access code: <span className="code">{info.accessCode}</span>
                </div>
                <p className="tiny" style={{ margin: 0 }}>
                  If the phone cannot connect: start Buz Cards with “start-phone” (it listens on the network), allow Node.js through the Windows firewall for
                  private networks, and avoid guest Wi-Fi that isolates devices.
                </p>
              </>
            ) : (
              <p className="small">No network address found. Connect this computer to Wi-Fi or Ethernet.</p>
            )}
          </section>
        )}

        <section className="panel stack">
          <h2 style={{ margin: 0 }}>Backup</h2>
          <p className="small muted" style={{ margin: 0 }}>
            One .zip with all contacts (saved and unsaved), card photos, recognition results and unfinished batches. Keep it on another drive or cloud folder.
            API keys are not included.
          </p>
          <div className="row">
            <a className="btn primary" href="/api/backup.zip" download>
              <Download size={16} /> Download backup
            </a>
            <a className="btn" href="/api/backup.zip?images=0" download>
              Contacts only (small)
            </a>
          </div>
        </section>

        <section className="panel stack">
          <h2 style={{ margin: 0 }}>Restore or import</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Choose a Buz Cards backup (.zip), or a backup .json from the earlier browser-only version. You will see what changes before anything is imported.
            Restoring never deletes contacts you already have.
          </p>
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload size={16} /> Choose backup file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.json,application/zip,application/json"
            className="visually-hidden"
            onChange={(e) => void choose(e.target.files?.[0]).finally(() => (e.target.value = ''))}
          />
          {preview && (
            <div className="notice stack">
              <div>
                <b>{preview.total}</b> contacts in this {preview.kind === 'legacy' ? 'earlier-version backup' : 'backup'}
                {preview.manifest.createdAt ? ` (made ${new Date(preview.manifest.createdAt).toLocaleString()})` : ''}, {preview.images} image file(s).
              </div>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                <li>{preview.newContacts} new</li>
                <li>{preview.sameIdIdentical} already here, identical</li>
                <li>{preview.sameIdDifferent} already here but different</li>
                {preview.possibleDuplicates.length > 0 && (
                  <li>
                    {preview.possibleDuplicates.length} new ones look like existing contacts (e.g. {preview.possibleDuplicates[0].incoming} ↔{' '}
                    {preview.possibleDuplicates[0].existing}: {preview.possibleDuplicates[0].reasons.join(', ')}). They will be imported; check them afterwards.
                  </li>
                )}
              </ul>
              {preview.warnings.map((w) => (
                <div key={w} className="small">
                  {w}
                </div>
              ))}
              {preview.sameIdDifferent > 0 && (
                <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
                  <legend className="small" style={{ fontWeight: 700 }}>
                    For the {preview.sameIdDifferent} that differ:
                  </legend>
                  <label className="row small">
                    <input type="radio" checked={policy === 'skip'} onChange={() => setPolicy('skip')} /> Keep the version in the app (recommended)
                  </label>
                  <label className="row small">
                    <input type="radio" checked={policy === 'overwrite'} onChange={() => setPolicy('overwrite')} /> Replace with the backup version
                  </label>
                  <label className="row small">
                    <input type="radio" checked={policy === 'copy'} onChange={() => setPolicy('copy')} /> Keep both (import as copies)
                  </label>
                </fieldset>
              )}
              <div className="row">
                <button className="btn primary" disabled={busy} onClick={restore}>
                  Import
                </button>
                <button className="btn" onClick={() => setPreview(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {msg && <div className={`notice ${msg.kind === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}
        </section>

        {info && (
          <section className="panel stack">
            <h2 style={{ margin: 0 }}>About this installation</h2>
            <dl className="kv">
              <dt>Processing</dt>
              <dd>On this computer (local). No cloud service.</dd>
              <dt>Recognition</dt>
              <dd>
                {info.engine} — {info.modelStatus === 'ready' ? 'ready' : info.modelStatus}
              </dd>
              <dt>Data folder</dt>
              <dd>{info.storagePath}</dd>
              <dt>Saved / unsaved</dt>
              <dd>
                {info.counts.saved} / {info.counts.drafts}
              </dd>
              <dt>Batch limits</dt>
              <dd>
                {info.limits.maxFiles} photos, {info.limits.maxFileBytes / 1048576} MB each, {info.limits.maxBatchBytes / 1048576} MB per batch
              </dd>
              <dt>LinkedIn</dt>
              <dd>
                {info.linkedinSearch.available ? `Suggestions via ${info.linkedinSearch.provider} (internet)` : 'Manual search links (no API key configured)'}
              </dd>
              <dt>Connection</dt>
              <dd>
                {location.protocol === 'https:' ? 'HTTPS' : 'HTTP'}
                {!window.isSecureContext && ' — works fully online; install-to-home-screen and offline app shell need HTTPS (see README)'}
              </dd>
              <dt>Version</dt>
              <dd>{info.version}</dd>
            </dl>
            <button className="btn quiet small" style={{ justifySelf: 'start' }} onClick={onShowIntro}>
              Show the introduction again
            </button>
          </section>
        )}
      </main>
    </>
  );
}

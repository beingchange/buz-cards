import { useEffect, useRef, useState } from 'react';
import { Camera, Images, PenLine, Upload } from 'lucide-react';
import { api, type Info } from '../api';
import { go } from '../App';
import { allBatches, filesOf, persistent, queueBatch, subscribe } from '../outbox';
import { ACCEPT_ATTR, fileProblem, mb, storageGet, storageSet } from '../util';
import type { Batch } from '../../shared/types';

export function ScanHome({ info }: { info: Info | null }) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File[] | null>(null);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [active, setActive] = useState<Batch[]>([]);

  useEffect(() => {
    const load = async () => {
      let n = 0;
      for (const b of await allBatches()) n += (await filesOf(b.localId)).filter((f) => f.state === 'pending' || f.state === 'uploading').length;
      setPendingUploads(n);
    };
    void load();
    api<{ batches: Batch[] }>('/api/batches?active=1')
      .then((r) => setActive(r.batches))
      .catch(() => undefined);
    return subscribe(() => void load());
  }, []);

  const limits = info?.limits ?? { maxFiles: 25, maxFileBytes: 25 * 1048576, maxBatchBytes: 150 * 1048576 };

  async function single(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    const problem = fileProblem(f, limits.maxFileBytes);
    if (problem) return alert(problem);
    const event = storageGet('buz-last-event') ?? '';
    const b = await queueBatch({ kind: 'single', label: 'Single scan', event, tags: [] }, [f]);
    go(`/batch/l-${b.localId}`);
  }

  return (
    <>
      <header className="topbar">
        <h1>Scan cards</h1>
      </header>
      <main className="page stack">
        <div className="scan-hero">
          <button className="scan-big primary" onClick={() => cameraRef.current?.click()}>
            <span className="ico">
              <Camera size={28} aria-hidden />
            </span>
            <span>
              <strong>Take a photo</strong>
              <span>One card. Fill the frame, avoid glare.</span>
            </span>
          </button>
          <button className="scan-big" onClick={() => galleryRef.current?.click()}>
            <span className="ico">
              <Images size={28} aria-hidden />
            </span>
            <span>
              <strong>Choose from gallery</strong>
              <span>Up to {limits.maxFiles} card photos at once. One card per photo.</span>
            </span>
          </button>
          <button
            className="scan-big"
            onClick={async () => {
              const r = await api<{ contact: { id: string } }>('/api/contacts', { method: 'POST', json: { contact: {} } });
              go(`/contact/${r.contact.id}`);
            }}
          >
            <span className="ico">
              <PenLine size={26} aria-hidden />
            </span>
            <span>
              <strong>Type a contact</strong>
              <span>No card, or no photo.</span>
            </span>
          </button>
        </div>
        {/* capture hint opens the camera on most phones; the browser may still offer the gallery */}
        <input
          ref={cameraRef}
          className="visually-hidden"
          type="file"
          accept={ACCEPT_ATTR}
          capture="environment"
          onChange={(e) => void single(e.target.files).finally(() => (e.target.value = ''))}
        />
        <input
          ref={galleryRef}
          className="visually-hidden"
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          onChange={(e) => {
            const list = [...(e.target.files ?? [])];
            e.target.value = '';
            if (list.length) setPicked(list);
          }}
        />
        {pendingUploads > 0 && (
          <div className="notice">
            <Upload size={16} aria-hidden /> {pendingUploads} photo{pendingUploads === 1 ? '' : 's'} waiting to upload to the computer. They are kept on this{' '}
            {persistent ? 'device' : 'page (private mode: keep this tab open)'} until then.
          </div>
        )}
        {active.length > 0 && (
          <section>
            <h2>In progress</h2>
            <div className="list">
              {active.map((b) => {
                const left = b.items.filter((i) => ['ready', 'needs_attention', 'queued', 'processing'].includes(i.status)).length;
                return (
                  <a key={b.id} href={`#/batch/${b.id}`} className="list-item no-check cover" style={{ gridTemplateColumns: '1fr auto' }}>
                    <div className="main">
                      <div className="title">{b.label || (b.kind === 'single' ? 'Single scan' : 'Batch')}</div>
                      <div className="sub">
                        {b.event ? `${b.event} · ` : ''}
                        {b.items.length} photo{b.items.length === 1 ? '' : 's'}, {left} to review
                      </div>
                    </div>
                    <span className="btn small">Open</span>
                  </a>
                );
              })}
            </div>
          </section>
        )}
        <p className="tiny">
          Photos are read on the computer running Buz Cards{info ? ` (data in ${info.storagePath})` : ''}. Nothing is sent to an online service.
        </p>
      </main>
      {picked && <BulkSheet files={picked} limits={limits} onClose={() => setPicked(null)} />}
    </>
  );
}

function BulkSheet({ files, limits, onClose }: { files: File[]; limits: Info['limits']; onClose: () => void }) {
  const [event, setEvent] = useState(storageGet('buz-last-event') ?? '');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const problems = files.map((f) => fileProblem(f, limits.maxFileBytes)).filter(Boolean) as string[];
  const usable = files.filter((f) => !fileProblem(f, limits.maxFileBytes));
  const total = usable.reduce((a, f) => a + f.size, 0);
  // Split into batches that respect both the count and total-size limits.
  const groups: File[][] = [];
  let cur: File[] = [],
    curBytes = 0;
  for (const f of usable) {
    if (cur.length >= limits.maxFiles || curBytes + f.size > limits.maxBatchBytes) {
      groups.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += f.size;
  }
  if (cur.length) groups.push(cur);

  async function start() {
    setBusy(true);
    storageSet('buz-last-event', event.trim());
    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    let first: string | null = null;
    for (let i = 0; i < groups.length; i++) {
      const label = `${event.trim() || 'Batch'}${groups.length > 1 ? ` (part ${i + 1} of ${groups.length})` : ''}`;
      const b = await queueBatch({ kind: 'batch', label, event: event.trim(), tags: tagList }, groups[i]);
      first ??= b.localId;
    }
    onClose();
    if (first) go(`/batch/l-${first}`);
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="bulk-title">
      <div className="sheet stack">
        <h2 id="bulk-title">
          {usable.length} photo{usable.length === 1 ? '' : 's'} selected ({mb(total)})
        </h2>
        {problems.length > 0 && (
          <div className="notice warn">
            <strong>
              {problems.length} file{problems.length === 1 ? '' : 's'} will not be read:
            </strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {problems.slice(0, 8).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {groups.length > 1 && (
          <div className="notice">
            That is more than one batch allows ({limits.maxFiles} photos / {mb(limits.maxBatchBytes)}). They will be read as {groups.length} batches:{' '}
            {groups.map((g) => g.length).join(' + ')} photos. Nothing is dropped.
          </div>
        )}
        <label className="field">
          Event or place you met them (optional)
          <input type="text" value={event} onChange={(e) => setEvent(e.target.value)} placeholder="e.g. NYC Build Expo 2026" />
        </label>
        <label className="field">
          Tags (optional, comma separated)
          <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. HVAC, follow up" />
        </label>
        <p className="tiny">Each photo is treated as one card. You can attach the back of a card to its contact during review.</p>
        <div className="row">
          <button className="btn primary" disabled={!usable.length || busy} onClick={start}>
            Read {usable.length} card{usable.length === 1 ? '' : 's'}
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

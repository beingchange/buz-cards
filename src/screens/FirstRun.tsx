import type { Info } from '../api';
import { storageSet } from '../util';

export function FirstRun({ info, onClose }: { info: Info; onClose: () => void }) {
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="fr-title">
      <div className="sheet stack">
        <h2 id="fr-title">How Buz Cards works</h2>
        <dl className="kv">
          <dt>Processing</dt>
          <dd>On the computer running Buz Cards. Your phone sends it the photo over your Wi-Fi; no online service is used and there is no account.</dd>
          <dt>Storage</dt>
          <dd>
            One database on that computer: <code style={{ wordBreak: 'break-all' }}>{info.storagePath}</code>. Phone and computer see the same contacts. Nothing
            is stored only on the phone, except photos still waiting to upload.
          </dd>
          <dt>Models</dt>
          <dd>Two text-recognition models (about 25 MB) installed with the app. No downloads while you use it.</dd>
          <dt>Accuracy</dt>
          <dd>Every card gets a review step. Fields the reader is unsure about are marked “Check” with the reason; nothing is invented.</dd>
          <dt>LinkedIn</dt>
          <dd>
            {info.linkedinSearch.available
              ? `Automatic suggestions use ${info.linkedinSearch.provider} (needs internet). You confirm every match.`
              : 'Manual search links. Automatic suggestions need an optional search API key (see README).'}
          </dd>
          <dt>Backups</dt>
          <dd>
            Settings → Download backup saves contacts and card photos to one .zip file. Keep a copy somewhere else: if that computer’s disk fails, the backup is
            your copy.
          </dd>
        </dl>
        <button
          className="btn primary"
          onClick={() => {
            storageSet('buz-first-run-done', '1');
            onClose();
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { api } from '../api';

export function AccessScreen({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <main className="page stack" style={{ maxWidth: 420, paddingTop: 48 }}>
      <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Connect to Buz Cards</h1>
      <p className="muted">
        Enter the 6-digit access code shown on the computer running Buz Cards (in its window, or under Settings when you open Buz Cards on that computer). This
        keeps other people on the same Wi-Fi out of your contacts.
      </p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/api/access', { method: 'POST', json: { code } });
            onDone();
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={12}
          value={code}
          onChange={(e) => setCode(e.target.value.trim())}
          aria-label="Access code"
          style={{ fontSize: '1.6rem', letterSpacing: '0.2em', textAlign: 'center' }}
        />
        {err && <div className="notice error">{err}</div>}
        <button className="btn primary" disabled={code.length < 4}>
          Connect
        </button>
      </form>
    </main>
  );
}

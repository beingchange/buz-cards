// Browser helpers that work on plain-HTTP local-network pages (no secure-context-only APIs required).

/** Random id. crypto.randomUUID needs a secure context; getRandomValues does not. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,.jpg,.jpeg,.png,.webp';

export function fileProblem(f: File, maxBytes: number): string | null {
  const ext = f.name.toLowerCase().split('.').pop() ?? '';
  const okType = ACCEPTED_TYPES.includes(f.type) || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext);
  if (!okType) return `${f.name}: not a JPEG, PNG, WebP or HEIC photo.`;
  if (f.size === 0) return `${f.name}: the file is empty.`;
  if (f.size > maxBytes) return `${f.name}: ${(f.size / 1048576).toFixed(1)} MB is over the ${maxBytes / 1048576} MB limit.`;
  return null;
}

export const mb = (n: number) => `${(n / 1048576).toFixed(n > 10 * 1048576 ? 0 : 1)} MB`;

export function formatDuration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
}

export function relativeDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

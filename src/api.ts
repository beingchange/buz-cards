// Small fetch wrapper: JSON in/out, specific error messages, access-code handling.
import type { Batch, Contact, ServerInfo } from '../shared/types';

export type ContactWithMeta = Contact & { attention: string[]; duplicates?: Duplicate[] };
export interface Duplicate {
  id: string;
  state: Contact['state'];
  name: string;
  company: string;
  reasons: string[];
  strength: 'strong' | 'possible';
}
export interface ContactPayload {
  contact: Contact;
  attention: string[];
  duplicates: Duplicate[];
}
export type Info = ServerInfo & { accessCode?: string; queue: { running: boolean; currentItem: string | null; queued: number } };

export class ApiError extends Error {
  status: number;
  code?: string;
  body: Record<string, unknown>;
  constructor(message: string, status: number, code?: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

let onAccessRequired: (() => void) | null = null;
export function setAccessHandler(fn: () => void) {
  onAccessRequired = fn;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError('Cannot reach the Buz Cards computer. Check that it is on, running Buz Cards, and on the same Wi-Fi.', 0, 'offline');
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    if (res.status === 401 && data.code === 'access_code_required') onAccessRequired?.();
    throw new ApiError(String(data.error ?? `Request failed (${res.status})`), res.status, data.code as string | undefined, data);
  }
  return data as T;
}

export const getInfo = () => api<Info>('/api/info');
export const getBatch = (id: string) => api<{ batch: Batch; contacts: ContactWithMeta[] }>(`/api/batches/${id}`);
export const getContact = (id: string) => api<ContactPayload>(`/api/contacts/${id}`);
export const putContact = (c: Contact) => api<ContactPayload>(`/api/contacts/${c.id}`, { method: 'PUT', json: { contact: c, revision: c.revision } });

export function queryString(params: Record<string, string | undefined | null>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

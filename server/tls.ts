// HTTPS certificate: use your own (e.g. from mkcert) via TLS_CERT/TLS_KEY, otherwise create a self-signed one once.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { dataDir } from './db.ts';

export function ensureCertificate(): { cert: string; key: string; selfSigned: boolean } {
  if (process.env.TLS_CERT && process.env.TLS_KEY) return { cert: process.env.TLS_CERT, key: process.env.TLS_KEY, selfSigned: false };
  const dir = path.join(dataDir(), 'tls');
  const cert = path.join(dir, 'cert.pem'),
    key = path.join(dir, 'key.pem');
  if (!existsSync(cert) || !existsSync(key)) {
    mkdirSync(dir, { recursive: true });
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4')
      .map((a) => ({ type: 7, ip: a!.address }));
    const pems = selfsigned.generate([{ name: 'commonName', value: 'Buz Cards (local)' }], {
      days: 825,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 2, value: os.hostname() }, ...ips] }],
    });
    writeFileSync(cert, pems.cert);
    writeFileSync(key, pems.private, { mode: 0o600 });
  }
  return { cert, key, selfSigned: true };
}

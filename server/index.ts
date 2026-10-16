// Entry point: `npm start`. Serves the web app + API from this computer.
import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { accessCode, createApp, lanUrls } from './app.ts';
import { dataDir, openDb } from './db.ts';
import { kick, recoverInterrupted } from './batches.ts';
import { warmup, shutdown } from './recognition/pool.ts';
import { ensureCertificate } from './tls.ts';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4173);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 4443);
const WANT_HTTPS = process.env.HTTPS === '1' || process.env.HTTPS === 'true';

openDb();
recoverInterrupted();
warmup();

const lan = HOST === '0.0.0.0' || HOST === '::';
const httpServer = http.createServer(createApp({ port: PORT }));
httpServer.requestTimeout = 10 * 60_000;
httpServer.listen(PORT, HOST, () => {
  console.log('\n  Buz Cards is running.');
  console.log(`  On this computer:   http://localhost:${PORT}`);
  if (lan) {
    for (const u of lanUrls(PORT)) console.log(`  On your phone:      ${u}   (same Wi-Fi)`);
    console.log(`  Phone access code:  ${accessCode()}`);
  } else console.log('  Phone access is off (HOST=127.0.0.1). Use start-phone / HOST=0.0.0.0 to allow it.');
  console.log(`  Data folder:        ${dataDir()}`);
  console.log('  Card photos are processed on THIS computer. Nothing is uploaded to the internet.\n');
  kick();
});

if (WANT_HTTPS) {
  const tls = ensureCertificate();
  const httpsServer = https.createServer({ key: readFileSync(tls.key), cert: readFileSync(tls.cert) }, createApp({ port: HTTPS_PORT, https: true }));
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`  HTTPS:              https://localhost:${HTTPS_PORT}`);
    if (lan) for (const u of lanUrls(HTTPS_PORT, true)) console.log(`  HTTPS on phone:     ${u}`);
    if (tls.selfSigned) console.log(`  (Self-signed certificate: your phone will warn once. See README → "HTTPS".)`);
  });
}

function stop() {
  console.log('\nStopping Buz Cards…');
  httpServer.close();
  void shutdown().finally(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
void existsSync;

import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const port = 4199;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  expect: { timeout: 90_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', launchOptions: { args: ['--host-resolver-rules=MAP buzcards.test 127.0.0.1'] } },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 860 } } },
  ],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning server/index.ts --lan',
    url: `http://127.0.0.1:${port}/api/info`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: String(port), BUZ_DATA_DIR: path.join(os.tmpdir(), `buz-e2e-${Date.now()}`), BUZ_ACCESS_CODE: '424242', BUZ_TRUST_LOOPBACK: '0' },
  },
});

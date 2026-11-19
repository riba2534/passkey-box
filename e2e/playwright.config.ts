import { defineConfig } from '@playwright/test';
import { TMP_ROOT } from './support/config.ts';

// Setup is done with project dependencies instead of a single globalSetup, so the RP harness
// can run on its own while the extension suite additionally builds and starts the full stack:
//
//   rp-setup ───────────┬──> harness     (test RP + CDP virtual authenticator only)
//   stack-setup ────────┴──> extension   (test RP + Passkey Box server + extension)
//
// Each setup project has a teardown project that stops its processes by PID.
export default defineConfig({
  testDir: './tests',
  outputDir: `${TMP_ROOT}/test-results`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    channel: 'chromium',
    headless: true,
  },
  projects: [
    { name: 'rp-setup', testMatch: /setup\/rp\.setup\.ts$/, teardown: 'rp-teardown' },
    { name: 'rp-teardown', testMatch: /setup\/rp\.teardown\.ts$/ },
    { name: 'stack-setup', testMatch: /setup\/stack\.setup\.ts$/, teardown: 'stack-teardown' },
    { name: 'stack-teardown', testMatch: /setup\/stack\.teardown\.ts$/ },
    { name: 'harness', testMatch: /rp-harness\.spec\.ts$/, dependencies: ['rp-setup'] },
    { name: 'extension', testMatch: /extension\/.*\.spec\.ts$/, dependencies: ['rp-setup', 'stack-setup'] },
  ],
});

import path from 'node:path';
import { test as setup } from '@playwright/test';
import { E2E_DIR, RP_API_URL, RP_PORT, RP_STATE_FILE, RP_TMP } from '../../support/config.ts';
import { resetService, startService } from '../../support/process.ts';

setup('start the test RP', async () => {
  await resetService(RP_STATE_FILE, RP_TMP);
  const script = path.join('rp', 'server.ts');
  await startService({
    command: process.execPath,
    args: [script],
    cwd: E2E_DIR,
    env: { ...process.env, RP_PORT: String(RP_PORT), RP_HOST: '127.0.0.1' },
    port: RP_PORT,
    portVariable: 'PKB_E2E_RP_PORT',
    logFile: path.join(RP_TMP, 'rp.log'),
    marker: script,
    stateFile: RP_STATE_FILE,
    healthUrl: `${RP_API_URL}/healthz`,
  });
});

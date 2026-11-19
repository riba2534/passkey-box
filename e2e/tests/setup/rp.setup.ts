import fs from 'node:fs';
import path from 'node:path';
import { test as setup } from '@playwright/test';
import { E2E_DIR, RP_API_URL, RP_PORT, RP_STATE_FILE, RP_TMP } from '../../support/config.ts';
import {
  isPortOpen,
  type ProcessInfo,
  readJsonFile,
  startDetached,
  stopProcess,
  waitForHealthy,
  writeJsonFile,
} from '../../support/process.ts';

setup('start the test RP', async () => {
  const stale = readJsonFile<ProcessInfo>(RP_STATE_FILE);
  if (stale) await stopProcess(stale);
  fs.rmSync(RP_TMP, { recursive: true, force: true });
  fs.mkdirSync(RP_TMP, { recursive: true });

  if (await isPortOpen(RP_PORT)) {
    throw new Error(`port ${RP_PORT} is already in use; stop that process or set PKB_E2E_RP_PORT`);
  }

  const logFile = path.join(RP_TMP, 'rp.log');
  const script = path.join('rp', 'server.ts');
  const pid = startDetached(process.execPath, [script], {
    cwd: E2E_DIR,
    env: { ...process.env, RP_PORT: String(RP_PORT), RP_HOST: '127.0.0.1' },
    logFile,
  });
  const info: ProcessInfo = { pid, logFile, marker: script };
  writeJsonFile(RP_STATE_FILE, info);

  try {
    await waitForHealthy(`${RP_API_URL}/healthz`, info);
  } catch (err) {
    await stopProcess(info);
    throw err;
  }
});

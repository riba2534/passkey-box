import fs from 'node:fs';
import { test as teardown } from '@playwright/test';
import { KEEP_TMP, RP_STATE_FILE, RP_TMP } from '../../support/config.ts';
import { type ProcessInfo, readJsonFile, stopProcess } from '../../support/process.ts';

teardown('stop the test RP', async () => {
  const info = readJsonFile<ProcessInfo>(RP_STATE_FILE);
  if (info) await stopProcess(info);
  if (!KEEP_TMP) fs.rmSync(RP_TMP, { recursive: true, force: true });
});

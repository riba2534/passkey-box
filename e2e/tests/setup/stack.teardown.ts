import fs from 'node:fs';
import { test as teardown } from '@playwright/test';
import { KEEP_TMP, STACK_STATE_FILE, STACK_TMP } from '../../support/config.ts';
import { type ProcessInfo, readJsonFile, stopProcess } from '../../support/process.ts';

teardown('stop the Passkey Box server', async () => {
  const info = readJsonFile<ProcessInfo>(STACK_STATE_FILE);
  if (info) await stopProcess(info);
  if (!KEEP_TMP) fs.rmSync(STACK_TMP, { recursive: true, force: true });
});

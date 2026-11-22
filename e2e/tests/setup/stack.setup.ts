// Builds the Passkey Box server and extension, starts the server on a throwaway database
// and creates the test accounts through the admin API.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test as setup } from '@playwright/test';
import {
  EXTENSION_DIR,
  EXTENSION_DIST,
  PREBUILT_EXTENSION_DIR,
  SERVER_DIR,
  SERVER_PORT,
  SERVER_URL,
  STACK_STATE_FILE,
  STACK_TMP,
} from '../../support/config.ts';
import { type Account, PkbApi } from '../../support/pkb-api.ts';
import { resetService, runStep, startService, stopProcess, writeJsonFile } from '../../support/process.ts';
import type { StackState } from '../../support/stack.ts';

const randomPassword = () => randomBytes(18).toString('base64url');

setup('build and start the Passkey Box server and extension', async () => {
  setup.setTimeout(10 * 60_000);
  await resetService(STACK_STATE_FILE, STACK_TMP);

  // CONTRACT §3 and §4.1. The two builds are independent, so they run side by side.
  // PKB_E2E_EXTENSION_DIR skips the extension build and loads that directory instead.
  const serverBin = path.join(STACK_TMP, 'bin', 'passkey-box');
  const extensionDist = PREBUILT_EXTENSION_DIR ?? EXTENSION_DIST;
  await Promise.all([
    runStep('go', ['build', '-o', serverBin, './cmd/passkey-box'], {
      cwd: SERVER_DIR,
      env: { ...process.env, CGO_ENABLED: '0' },
    }),
    PREBUILT_EXTENSION_DIR === undefined
      ? runStep('npm', ['--prefix', EXTENSION_DIR, 'ci'], { cwd: EXTENSION_DIR }).then(() =>
          runStep('npm', ['--prefix', EXTENSION_DIR, 'run', 'build'], { cwd: EXTENSION_DIR }),
        )
      : undefined,
  ]);
  for (const file of ['manifest.json', 'background.js', 'inject.js', 'content.js']) {
    if (!fs.existsSync(path.join(extensionDist, file))) throw new Error(`no ${file} in the extension directory ${extensionDist}`);
  }
  const extensionVersion = (JSON.parse(fs.readFileSync(path.join(extensionDist, 'manifest.json'), 'utf8')) as { version: string }).version;

  const admin: Account = { username: 'e2e-admin', password: randomPassword() };
  const info = await startService({
    command: serverBin,
    cwd: STACK_TMP,
    env: {
      ...process.env,
      PKB_LISTEN: `127.0.0.1:${SERVER_PORT}`,
      PKB_DB: path.join(STACK_TMP, 'data', 'passkey-box.db'),
      PKB_ADMIN_USERNAME: admin.username,
      PKB_ADMIN_PASSWORD: admin.password,
      PKB_ALLOW_REGISTER: 'false',
      PKB_EXTENSION_ZIP: '',
    },
    port: SERVER_PORT,
    portVariable: 'PKB_E2E_SERVER_PORT',
    logFile: path.join(STACK_TMP, 'server.log'),
    marker: serverBin,
    stateFile: STACK_STATE_FILE,
    healthUrl: `${SERVER_URL}/healthz`,
  });

  try {
    const api = new PkbApi(SERVER_URL);
    if (!(await api.me(admin)).is_admin) throw new Error('bootstrap admin is not an admin');

    const create = async (username: string) => {
      const password = randomPassword();
      const user = await api.createUser(admin, { username, password });
      return { id: user.id, username: user.username, password };
    };
    const [a, b] = await Promise.all([create('e2e-user-a'), create('e2e-user-b')]);
    const state: StackState = {
      ...info,
      serverUrl: SERVER_URL,
      extensionDist,
      extensionVersion,
      extensionPrebuilt: PREBUILT_EXTENSION_DIR !== undefined,
      admin,
      users: { a, b },
    };
    writeJsonFile(STACK_STATE_FILE, state);
  } catch (err) {
    await stopProcess(info);
    throw err;
  }
});

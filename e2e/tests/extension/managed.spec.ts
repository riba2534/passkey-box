import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { CHROMIUM_EXECUTABLE_PATH } from '../../support/config.ts';
import { expect, test } from '../../support/extension-fixtures.ts';
import { RpPage } from '../../support/rp.ts';

// A launcher (AnyBrowser) copies the unpacked extension and adds managed-config.json:
// the extension signs in by itself and handles passkeys without any setup or clicks.
test('managed-config.json signs the extension in without any setup', async ({ stack, pkb, headless }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pkb-managed-'));
  const extension = path.join(root, 'PasskeyBox');
  await cp(stack.extensionDist, extension, { recursive: true });
  const { username, password } = stack.users.b;
  await writeFile(path.join(extension, 'managed-config.json'), JSON.stringify({ serverUrl: stack.serverUrl, username, password }));

  const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
    channel: 'chromium',
    executablePath: CHROMIUM_EXECUTABLE_PATH,
    headless,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const rp = new RpPage(context.pages()[0] ?? (await context.newPage()));
    await rp.goto({ requireUV: true });
    await rp.registerOk('managed');
    await rp.login();
    await rp.expectResult('authenticated:managed');

    const [saved] = await pkb.listCredentials(stack.users.b);
    expect(saved?.user_name).toBe('managed');
    expect(await pkb.listCredentials(stack.users.a)).toEqual([]);
    expect(context.pages()).toHaveLength(1);
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});

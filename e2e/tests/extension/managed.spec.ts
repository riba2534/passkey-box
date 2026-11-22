import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, chromium } from '@playwright/test';
import { CHROMIUM_EXECUTABLE_PATH } from '../../support/config.ts';
import { expect, extensionIn, PkbUi, test } from '../../support/extension-fixtures.ts';
import { RpPage } from '../../support/rp.ts';
import type { StackState } from '../../support/stack.ts';

type ManagedProfile = { context: BrowserContext; rp: RpPage; ui: PkbUi };

/** A browser profile that loads its own copy of the extension with managed-config.json, as AnyBrowser prepares it. */
async function launchManaged(stack: StackState, dir: string, managed: Record<string, unknown>, headless: boolean): Promise<ManagedProfile> {
  const extension = path.join(dir, 'PasskeyBox');
  await mkdir(dir, { recursive: true });
  await cp(stack.extensionDist, extension, { recursive: true });
  await writeFile(path.join(extension, 'managed-config.json'), JSON.stringify(managed));
  const context = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
    channel: 'chromium',
    executablePath: CHROMIUM_EXECUTABLE_PATH,
    headless,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, rp: new RpPage(page), ui: new PkbUi(page) };
}

/** The extension's options page in that profile. */
async function openOptions(profile: ManagedProfile, stack: StackState) {
  const extensionId = new URL((await extensionIn(profile.context, stack)).worker.url()).host;
  const options = await profile.context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.locator('[data-setting="autoLoginSingle"]')).toBeVisible();
  return options;
}

// A launcher (AnyBrowser) copies the unpacked extension and adds managed-config.json:
// the extension signs in by itself and handles passkeys without any setup or clicks.
test('managed-config.json signs the extension in without any setup', async ({ stack, pkb, headless }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pkb-managed-'));
  const { username, password } = stack.users.b;
  const { context, rp } = await launchManaged(stack, root, { serverUrl: stack.serverUrl, username, password }, headless);
  try {
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

// AnyBrowser profiles share one Passkey Box account and set autoLogin "owned-only": a profile does not
// sign in as the account another profile registered until the user picks it there once.
test('owned-only: a profile sharing the account asks before using another profile\'s passkey', async ({ stack, pkb, headless }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pkb-owned-only-'));
  const { username, password } = stack.users.a;
  const account = { serverUrl: stack.serverUrl, username, password };
  const profiles: ManagedProfile[] = [];
  const launch = async (name: string, managed: Record<string, unknown>) => {
    const profile = await launchManaged(stack, path.join(root, name), managed, headless);
    profiles.push(profile);
    return profile;
  };
  try {
    const a = await launch('a', { ...account, autoLogin: 'owned-only' });
    await a.rp.goto();
    await a.rp.registerOk('alice');
    await a.rp.login();
    await a.rp.expectResult('authenticated:alice');
    await a.ui.expectNoDialog();
    expect(await pkb.listCredentials(stack.users.a)).toHaveLength(1);

    const b = await launch('b', { ...account, autoLogin: 'owned-only' });
    // The autofill request on page load shows the picker instead of signing in as alice.
    await b.rp.goto({ conditional: true });
    await expect(b.ui.dialog('picker')).toBeVisible();
    await expect(b.ui.pickerAccounts()).toHaveCount(1);
    await expect(b.ui.pickerAccounts()).toContainText('alice');
    await expect(b.ui.dialog('picker')).not.toContainText('本浏览器用过');
    await expect(b.rp.result).toHaveText('pending:conditional');

    // So does the login button; choosing alice there signs in.
    await b.rp.login();
    await expect(b.ui.dialog('picker')).toBeVisible();
    await expect(b.rp.result).toHaveText('pending:login');
    await b.ui.pickerAccounts().filter({ hasText: 'alice' }).click();
    await b.rp.expectResult('authenticated:alice');

    // Chosen once in this profile, alice signs in directly from then on.
    await b.rp.goto({ conditional: true });
    await b.rp.expectResult('authenticated:alice');
    await b.ui.expectNoDialog();
    const options = await openOptions(b, stack);
    await expect(options.locator('.settings-note')).toHaveText(
      '由启动器（如 AnyBrowser）管理：只自动使用在本浏览器 Profile 注册或用过的通行密钥，其他账号先在选择框里选一次。',
    );

    // Without autoLogin, a profile sharing the account signs in with the only passkey, as before.
    const c = await launch('c', account);
    await c.rp.goto();
    await c.rp.login();
    await c.rp.expectResult('authenticated:alice');
    await c.ui.expectNoDialog();
    await expect((await openOptions(c, stack)).locator('.settings-note')).toHaveCount(0);
  } finally {
    await Promise.all(profiles.map((p) => p.context.close()));
    await rm(root, { recursive: true, force: true });
  }
});

// For a profile without an account, AnyBrowser writes only {"autoLogin":"owned-only"}: the extension keeps the
// account it signed in with last time, now under owned-only, and a profile that never had one stays signed out.
test('owned-only without an account: the last account follows the policy, nothing signs in', async ({ stack, headless }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pkb-policy-only-'));
  const { username, password } = stack.users.a;
  const account = { serverUrl: stack.serverUrl, username, password };
  const profiles: ManagedProfile[] = [];
  const launch = async (name: string, managed: Record<string, unknown>) => {
    const profile = await launchManaged(stack, path.join(root, name), managed, headless);
    profiles.push(profile);
    return profile;
  };
  try {
    const a = await launch('a', { ...account, autoLogin: 'owned-only' });
    await a.rp.goto();
    await a.rp.registerOk('alice');

    // B signed in with the shared account before (0.4.0, or an AnyBrowser account removed since).
    const before = await launch('b', account);
    await expect((await openOptions(before, stack)).locator('.status')).toContainText(`已登录 ${username}`);
    await before.context.close();
    const b = await launch('b', { autoLogin: 'owned-only' });
    await b.rp.goto();
    await b.rp.login();
    await expect(b.ui.dialog('picker')).toBeVisible();
    await expect(b.ui.pickerAccounts()).toHaveCount(1);
    await expect(b.rp.result).toHaveText('pending:login');
    await b.ui.action('picker', 'cancel').click();
    await b.rp.expectResult('error:NotAllowedError');
    const options = await openOptions(b, stack);
    await expect(options.locator('.status')).toContainText(`已登录 ${username}`);
    await expect(options.locator('.settings-note')).toBeVisible();

    const c = await launch('c', { autoLogin: 'owned-only' });
    const signedOut = await openOptions(c, stack);
    await expect(signedOut.locator('.status')).toHaveText(/尚未登录/);
    await expect(signedOut.locator('.settings-note')).toBeVisible();
  } finally {
    await Promise.all(profiles.map((p) => p.context.close()));
    await rm(root, { recursive: true, force: true });
  }
});

/** Signs the extension in through the login form on its options page. */
async function signInOnOptions(profile: ManagedProfile, stack: StackState, account: { serverUrl: string; username: string; password: string }) {
  const options = await openOptions(profile, stack);
  await options.locator('#pkb-server-url').fill(account.serverUrl);
  await options.locator('#pkb-username').fill(account.username);
  await options.locator('#pkb-password').fill(account.password);
  await options.locator('form.login-form button[type="submit"]').click();
  await expect(options.locator('.status')).toContainText(`已登录 ${account.username}`);
  await expect(options.locator('.settings-note')).toBeVisible();
  await options.close();
}

// Profiles without a launcher account get only {"autoLogin":"owned-only"}; users who sign in to the same
// account on the options page are kept apart all the same.
test('owned-only policy file: accounts signed in on the options page follow it', async ({ stack, headless }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pkb-policy-manual-'));
  const { username, password } = stack.users.a;
  const account = { serverUrl: stack.serverUrl, username, password };
  const profiles: ManagedProfile[] = [];
  const launch = async (name: string) => {
    const profile = await launchManaged(stack, path.join(root, name), { autoLogin: 'owned-only' }, headless);
    profiles.push(profile);
    await signInOnOptions(profile, stack, account);
    return profile;
  };
  try {
    const a = await launch('a');
    await a.rp.goto();
    await a.rp.registerOk('alice');
    await a.rp.login();
    await a.rp.expectResult('authenticated:alice');
    await a.ui.expectNoDialog();

    const b = await launch('b');
    await b.rp.goto({ conditional: true });
    await expect(b.ui.dialog('picker')).toBeVisible();
    await expect(b.rp.result).toHaveText('pending:conditional');
    await b.rp.login();
    await expect(b.ui.dialog('picker')).toBeVisible();
    await expect(b.ui.pickerAccounts()).toHaveCount(1);
    await expect(b.rp.result).toHaveText('pending:login');
  } finally {
    await Promise.all(profiles.map((p) => p.context.close()));
    await rm(root, { recursive: true, force: true });
  }
});

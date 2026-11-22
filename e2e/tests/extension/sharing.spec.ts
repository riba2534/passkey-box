import { expect, inProfile, type PkbExtension, type Profile, test } from '../../support/extension-fixtures.ts';
import type { Credential, PkbApi, TestUser } from '../../support/pkb-api.ts';
import type { RpPage } from '../../support/rp.ts';
import { extensionSince, type StackState } from '../../support/stack.ts';

// Since 0.6.0 a Passkey Box user can share a passkey with other users or transfer it to them. The
// extension signs in with a passkey shared with its account like with its own and names the owner,
// but sharing needs no consent: a shared passkey only signs in by itself once the user picked it in
// that browser profile. Older extensions get the same credentials and must keep working, so
// assertions on 0.6.0 behaviour only run against an extension that has it.

const brief = (user: TestUser) => ({ id: user.id, username: user.username });

/** The first sign-in with "alice" shared with the profile's user: from 0.6.0 the user picks it once. */
async function chooseSharedAlice(stack: StackState, profile: Profile) {
  await profile.rp.login();
  if (extensionSince(stack, '0.6.0')) {
    await expect(profile.ui.pickerAccounts()).toHaveCount(1);
    await expect(profile.rp.result).toHaveText('pending:login');
    await profile.ui.pickerAccounts().click();
  }
  await profile.rp.expectResult('authenticated:alice');
}

/** The test's own browser profile, signed in as user A, registers "alice" on the RP. */
async function registerAlice({ extension, stack, rp, pkb }: { extension: PkbExtension; stack: StackState; rp: RpPage; pkb: PkbApi }) {
  await extension.configure(stack.users.a);
  await rp.goto();
  await rp.registerOk('alice');
  const saved = await pkb.listCredentials(stack.users.a);
  expect(saved).toHaveLength(1);
  return saved[0] as Credential;
}

test('a passkey shared with another user signs that user in, directly once chosen', async ({ extension, stack, rp, pkb, headless }) => {
  const { a, b } = stack.users;
  const alice = await registerAlice({ extension, stack, rp, pkb });
  const shared = await pkb.share(a, [alice.id], [b.username]);
  expect(shared.results.map((r) => r.status)).toEqual(['shared']);
  expect(await pkb.listCredentials(b)).toEqual([expect.objectContaining({ id: alice.id, access: 'shared', owner: brief(a) })]);

  await inProfile(stack, b, headless, async (bob) => {
    await chooseSharedAlice(stack, bob);
    await bob.rp.page.reload();
    await bob.rp.login();
    await bob.rp.expectResult('authenticated:alice');
    await bob.ui.expectNoDialog();
    // Each use counts for the passkey and for B's share.
    await expect
      .poll(() => pkb.getCredential(a, alice.id))
      .toMatchObject({ use_count: 2, shared_with: [{ user: brief(b), last_used_at: expect.any(String) }] });
  });
});

test('opening a page does not silently sign in with a passkey another user shared', async ({ extension, stack, rp, pkb, headless }) => {
  test.skip(!extensionSince(stack, '0.6.0'), 'extensions before 0.6.0 sign in with a shared passkey like with their own');
  const { a, b } = stack.users;
  const alice = await registerAlice({ extension, stack, rp, pkb });
  await pkb.share(a, [alice.id], [b.username]);

  await inProfile(stack, b, headless, async (bob) => {
    await bob.rp.goto({ conditional: true });
    await expect(bob.ui.dialog('picker')).toBeVisible();
    await expect(bob.ui.pickerAccounts()).toHaveCount(1);
    await expect(bob.ui.pickerAccounts().getByText('共享自 e2e-user-a', { exact: true })).toBeVisible();
    await expect(bob.rp.result).toHaveText('pending:conditional');
    expect((await pkb.getCredential(a, alice.id)).use_count).toBe(0);

    await bob.ui.pickerAccounts().click();
    await bob.rp.expectResult('authenticated:alice');
    // Chosen once in this profile, it signs in as soon as the page opens.
    await bob.rp.goto({ conditional: true });
    await bob.rp.expectResult('authenticated:alice');
    await bob.ui.expectNoDialog();
  });
});

test('next to the user\'s own account, the picker offers the shared one and names its owner', async ({
  extension,
  stack,
  rp,
  pkb,
  headless,
}) => {
  const { a, b } = stack.users;
  const alice = await registerAlice({ extension, stack, rp, pkb });
  await pkb.share(a, [alice.id], [b.username]);
  const labels = extensionSince(stack, '0.6.0');

  await inProfile(
    stack,
    b,
    headless,
    async (bob) => {
      await bob.rp.registerOk('bob');
      await bob.rp.login();
      const accounts = bob.ui.pickerAccounts();
      await expect(accounts).toHaveCount(2);
      const sharedOne = accounts.filter({ hasText: 'alice' });
      const ownOne = accounts.filter({ hasText: 'bob' });
      if (labels) {
        await expect(sharedOne.getByText('共享自 e2e-user-a', { exact: true })).toBeVisible();
        await expect(ownOne).not.toContainText('共享自');
      }
      await sharedOne.click();
      await bob.rp.expectResult('authenticated:alice');

      // Used here now, the shared passkey carries both labels.
      await bob.rp.page.reload();
      await bob.rp.login();
      await expect(accounts).toHaveCount(2);
      if (labels) {
        await expect(sharedOne.getByText('本浏览器用过', { exact: true })).toBeVisible();
        await expect(sharedOne.getByText('共享自 e2e-user-a', { exact: true })).toBeVisible();
      }
      await ownOne.click();
      await bob.rp.expectResult('authenticated:bob');
    },
    { autoLoginSingle: false },
  );
});

test('once the owner revokes the share, the other user no longer finds the passkey', async ({ extension, stack, rp, pkb, headless }) => {
  const { a, b } = stack.users;
  const alice = await registerAlice({ extension, stack, rp, pkb });
  await pkb.share(a, [alice.id], [b.username]);

  await inProfile(stack, b, headless, async (bob) => {
    await chooseSharedAlice(stack, bob);

    const revoked = await pkb.unshare(a, [alice.id], [b.username]);
    expect(revoked.results.map((r) => r.status)).toEqual(['unshared']);
    await bob.rp.page.reload();
    await bob.rp.login();
    await expect(bob.ui.dialog('empty')).toBeVisible();
    await bob.ui.action('empty', 'cancel').click();
    await bob.rp.expectResult('error:NotAllowedError');
  });
  expect(await pkb.listCredentials(b)).toEqual([]);
  expect(await pkb.listCredentials(a)).toEqual([expect.objectContaining({ id: alice.id, access: 'owner', shared_with: [] })]);
});

test('an administrator transfers a passkey: the new owner signs in, the old one no longer can', async ({
  extension,
  stack,
  page,
  rp,
  ui,
  pkb,
  headless,
}) => {
  const { a, b } = stack.users;
  const alice = await registerAlice({ extension, stack, rp, pkb });
  const moved = await pkb.transfer(stack.admin, [alice.id], b.username, { scope: 'admin' });
  expect(moved.results).toEqual([
    expect.objectContaining({ from: brief(a), to: brief(b), status: 'transferred', keep_access: false }),
  ]);
  expect(await pkb.listCredentials(a)).toEqual([]);
  expect(await pkb.listCredentials(b)).toEqual([expect.objectContaining({ id: alice.id, access: 'owner', owner: brief(b) })]);

  // A's profile registered and used it, but it is gone from A's list.
  await page.reload();
  await rp.login();
  await expect(ui.dialog('empty')).toBeVisible();
  await ui.action('empty', 'cancel').click();
  await rp.expectResult('error:NotAllowedError');

  await inProfile(stack, b, headless, async (bob) => {
    await bob.rp.login();
    await bob.rp.expectResult('authenticated:alice');
    await bob.ui.expectNoDialog();
  });
});

test('a transfer with keep_access leaves the old owner signing in with a passkey shared by the new one', async ({
  extension,
  stack,
  page,
  rp,
  ui,
  pkb,
  headless,
}) => {
  const { a, b } = stack.users;
  const alice = await registerAlice({ extension, stack, rp, pkb });
  const moved = await pkb.transfer(stack.admin, [alice.id], b.username, { keepAccess: true, scope: 'admin' });
  expect(moved.results).toEqual([expect.objectContaining({ status: 'transferred', keep_access: true })]);
  expect(await pkb.listCredentials(a)).toEqual([expect.objectContaining({ id: alice.id, access: 'shared', owner: brief(b) })]);

  // A's profile still signs in with it by itself, as before the transfer.
  await page.reload();
  await rp.login();
  await rp.expectResult('authenticated:alice');
  await ui.expectNoDialog();

  // With automatic sign-in off, the picker shows whose passkey it is now.
  await extension.configure(a, { autoLoginSingle: false });
  await page.reload();
  await rp.login();
  await expect(ui.pickerAccounts()).toHaveCount(1);
  if (extensionSince(stack, '0.6.0')) {
    await expect(ui.pickerAccounts().getByText('共享自 e2e-user-b', { exact: true })).toBeVisible();
  }
  await ui.pickerAccounts().click();
  await rp.expectResult('authenticated:alice');

  await inProfile(stack, b, headless, async (bob) => {
    await bob.rp.login();
    await bob.rp.expectResult('authenticated:alice');
  });
});

test('removing a shared passkey in the popup only leaves the share; the owner keeps it', async ({ extension, stack, rp, pkb, headless }) => {
  const { a, b } = stack.users;
  const alice = await registerAlice({ extension, stack, rp, pkb });
  await pkb.share(a, [alice.id], [b.username]);
  const labels = extensionSince(stack, '0.6.0');

  await inProfile(stack, b, headless, async (bob) => {
    const popup = await bob.context.newPage();
    await popup.goto(`chrome-extension://${new URL(bob.extension.worker.url()).host}/popup.html`);
    const row = popup.locator(`[data-credential-id="${alice.id}"]`);
    if (labels) await expect(row.locator('.item-owner')).toHaveText('共享自 e2e-user-a');
    await row.click();
    if (labels) await expect(popup.locator('.field-row').filter({ hasText: '所有者' }).locator('dd')).toHaveText('e2e-user-a');
    // Before 0.6.0 the button reads 删除, but the server only removes B's share either way.
    await popup.getByRole('button', { name: labels ? '移除共享' : '删除', exact: true }).click();
    await expect(popup.locator('.flash')).toHaveText(labels ? '已移除共享' : '已删除通行密钥');
    await expect(row).toHaveCount(0);
  });
  expect(await pkb.listCredentials(b)).toEqual([]);
  expect(await pkb.listCredentials(a)).toEqual([expect.objectContaining({ id: alice.id, access: 'owner', shared_with: [] })]);
});

import { expect, test } from '../../support/extension-fixtures.ts';

test.beforeEach(async ({ extension, stack, rp }) => {
  await extension.configure(stack.users.a);
  await rp.goto();
});

test('one passkey: usernameless login signs in directly without any dialog', async ({ rp, ui, pkb, stack }) => {
  await rp.registerOk('alice');

  await rp.login();
  await rp.expectResult('authenticated:alice');
  await ui.expectNoDialog();
  await expect(ui.toast('signed-in')).toBeVisible();

  // CONTRACT §4.4 step 5: usage is reported after signing.
  await expect.poll(async () => (await pkb.listCredentials(stack.users.a))[0]?.use_count).toBe(1);
});

test('two passkeys: usernameless login shows the picker and signs in with the chosen account', async ({
  rp,
  ui,
  pkb,
  stack,
}) => {
  await rp.registerOk('alice', 'bob');

  await rp.login();
  await expect(ui.dialog('picker')).toBeVisible();
  const accounts = ui.pickerAccounts();
  await expect(accounts).toHaveCount(2);
  await expect(accounts.filter({ hasText: 'alice' })).toHaveCount(1);
  await expect(accounts.filter({ hasText: 'bob' })).toHaveCount(1);
  const shown = await accounts.evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-pkb-credential-id')));
  const saved = (await pkb.listCredentials(stack.users.a)).map((c) => c.id);
  expect(shown.sort()).toEqual(saved.sort());
  await expect(rp.result).toHaveText('pending:login');

  await accounts.filter({ hasText: 'bob' }).click();
  await rp.expectResult('authenticated:bob');
  await ui.expectNoDialog();
});

test('username first: allowCredentials selects the matching passkey without a dialog', async ({ rp, ui }) => {
  await rp.registerOk('alice', 'bob');

  await rp.loginWithUsername('bob');
  await rp.expectResult('authenticated:bob');
  await ui.expectNoDialog();

  await rp.loginWithUsername('alice');
  await rp.expectResult('authenticated:alice');
  await ui.expectNoDialog();
});

test('conditional mediation: a single candidate signs in as soon as the page opens', async ({ rp, ui }) => {
  await rp.registerOk('alice');

  await rp.goto({ conditional: true });
  await rp.expectResult('authenticated:alice');
  await ui.expectNoDialog();
  await expect(ui.toast('signed-in')).toBeVisible();
});

test('no passkey for the current account: empty dialog, cancel rejects with NotAllowedError', async ({ rp, ui }) => {
  await rp.login();
  await expect(ui.dialog('empty')).toBeVisible();

  await ui.action('empty', 'cancel').click();
  await rp.expectResult('error:NotAllowedError');
  await ui.expectNoDialog();
});

import { expect, openProfile, test } from '../../support/extension-fixtures.ts';

// Browser profiles that share one Passkey Box account (as in AnyBrowser) each sign in with the
// account they registered, without choosing; a profile that used none of them still asks.
test('each browser profile signs in with the passkey it registered', async ({ extension, stack, page, rp, ui, pkb, headless }) => {
  await extension.configure(stack.users.a);
  await rp.goto();
  await rp.registerOk('alice');

  const second = await openProfile(stack, stack.users.a, headless);
  try {
    await second.rp.registerOk('bob');
    expect(await pkb.listCredentials(stack.users.a)).toHaveLength(2);

    await rp.login();
    await rp.expectResult('authenticated:alice');
    await ui.expectNoDialog();

    await second.rp.login();
    await second.rp.expectResult('authenticated:bob');
    await second.ui.expectNoDialog();
  } finally {
    await second.context.close();
  }

  // With automatic sign-in off, the picker lists this profile's account first.
  await extension.configure(stack.users.a, { autoLoginSingle: false });
  await page.reload();
  await rp.login();
  await expect(ui.pickerAccounts()).toHaveCount(2);
  await expect(ui.pickerAccounts().first()).toContainText('alice');
  await expect(ui.pickerAccounts().first()).toContainText('本浏览器用过');
  await expect(ui.pickerAccounts().nth(1)).not.toContainText('本浏览器用过');
  await ui.action('picker', 'cancel').click();
  await rp.expectResult('error:NotAllowedError');

  const third = await openProfile(stack, stack.users.a, headless);
  try {
    await third.rp.login();
    await expect(third.ui.dialog('picker')).toBeVisible();
    await expect(third.ui.pickerAccounts()).toHaveCount(2);
    await expect(third.ui.dialog('picker')).not.toContainText('本浏览器用过');
    await third.ui.pickerAccounts().filter({ hasText: 'bob' }).click();
    await third.rp.expectResult('authenticated:bob');

    // The account chosen here signs in directly from now on.
    await third.rp.page.reload();
    await third.rp.login();
    await third.rp.expectResult('authenticated:bob');
    await third.ui.expectNoDialog();
  } finally {
    await third.context.close();
  }
});

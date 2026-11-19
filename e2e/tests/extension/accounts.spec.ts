import { expect, test } from '../../support/extension-fixtures.ts';

test('passkeys stay with the extension account that saved them', async ({ extension, stack, page, rp, ui, pkb }) => {
  await extension.configure(stack.users.a);
  await rp.goto();
  await rp.register('alice');
  await rp.expectResult('registered:alice');
  expect(await pkb.listCredentials(stack.users.a)).toHaveLength(1);

  await extension.configure(stack.users.b);
  await page.reload();
  await rp.login();
  await expect(ui.dialog('empty')).toBeVisible();
  await ui.action('empty', 'cancel').click();
  await rp.expectResult('error:NotAllowedError');
  expect(await pkb.listCredentials(stack.users.b)).toEqual([]);

  // Switching back proves the empty result came from the account switch.
  await extension.configure(stack.users.a);
  await page.reload();
  await rp.login();
  await rp.expectResult('authenticated:alice');
});

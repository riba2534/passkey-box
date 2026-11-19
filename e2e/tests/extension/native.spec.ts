// "不要唤起系统的指纹认证": a CDP virtual authenticator stands in for the platform
// authenticator. Anything that reaches Chrome's native WebAuthn implementation lands in it.

import { expect, test } from '../../support/extension-fixtures.ts';
import { rpApi } from '../../support/rp.ts';
import { base64ToBase64url, VirtualAuthenticator } from '../../support/virtual-authenticator.ts';

test('a configured extension never calls the native implementation', async ({ extension, stack, page, rp, ui, pkb }) => {
  const authenticator = await VirtualAuthenticator.attach(page);
  await extension.configure(stack.users.a);
  await rp.goto();

  await rp.register('alice');
  await rp.expectResult('registered:alice');
  await rp.login();
  await rp.expectResult('authenticated:alice');
  await rp.loginWithUsername('alice');
  await rp.expectResult('authenticated:alice');
  await rp.goto({ conditional: true });
  await rp.expectResult('authenticated:alice');
  await ui.expectNoDialog();

  expect(await authenticator.credentials()).toEqual([]);
  expect(authenticator.operations).toEqual([]);
  expect(await pkb.listCredentials(stack.users.a)).toHaveLength(1);
});

test('an unconfigured extension leaves registration to the native implementation', async ({
  extension,
  stack,
  page,
  rp,
  ui,
  pkb,
}) => {
  await extension.unconfigure();
  const authenticator = await VirtualAuthenticator.attach(page);
  await rp.goto();

  await rp.register('alice');
  await rp.expectResult('registered:alice');
  await ui.expectNoDialog();

  const alice = await rpApi.user('alice');
  const credentials = await authenticator.credentials();
  expect(credentials.map((c) => base64ToBase64url(c.credentialId))).toEqual([alice.credentials[0].id]);
  expect(await pkb.listCredentials(stack.users.a)).toEqual([]);
  expect(await pkb.listCredentials(stack.users.b)).toEqual([]);
});

test('"使用其他方式" in the empty dialog hands the login to the native implementation', async ({
  extension,
  stack,
  page,
  rp,
  ui,
  pkb,
}) => {
  // A passkey that only the native authenticator holds.
  await extension.unconfigure();
  const authenticator = await VirtualAuthenticator.attach(page);
  await rp.goto();
  await rp.register('alice');
  await rp.expectResult('registered:alice');
  expect(authenticator.operations).toEqual(['credentialAdded']);

  await extension.configure(stack.users.a);
  await page.reload();
  await rp.login();
  await expect(ui.dialog('empty')).toBeVisible();
  expect(authenticator.operations).toEqual(['credentialAdded']);

  await ui.action('empty', 'fallback').click();
  await rp.expectResult('authenticated:alice');
  await ui.expectNoDialog();
  await expect.poll(() => authenticator.operations).toEqual(['credentialAdded', 'credentialAsserted']);
  expect(await pkb.listCredentials(stack.users.a)).toEqual([]);
});

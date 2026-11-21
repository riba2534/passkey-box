import { expect, test } from '../../support/extension-fixtures.ts';
import { rpApi } from '../../support/rp.ts';

test('a signed-in extension registers and signs in on a UV-required site without any extra verification', async ({
  context, extension, stack, authenticator, rp, pkb,
}) => {
  await extension.configure(stack.users.a);
  await rp.goto({ requireUV: true });
  const pages = context.pages().length;

  await rp.registerOk('alice');
  const [saved] = await pkb.listCredentials(stack.users.a);
  expect(saved?.user_name).toBe('alice');
  expect((await rpApi.user('alice')).credentials).toHaveLength(1);

  await rp.login();
  await rp.expectResult('authenticated:alice');
  await expect.poll(async () => (await pkb.listCredentials(stack.users.a))[0]?.use_count).toBe(1);

  // No verification window was opened and Chrome's native WebAuthn was never reached.
  expect(context.pages()).toHaveLength(pages);
  expect(authenticator.operations).toEqual([]);
});

import { RP_ID, RP_ORIGIN } from '../../support/config.ts';
import { expect, test } from '../../support/extension-fixtures.ts';
import { rpApi } from '../../support/rp.ts';

test.beforeEach(async ({ extension, stack, rp }) => {
  await extension.configure(stack.users.a);
  await rp.goto();
});

test('registration saves the passkey to the server', async ({ rp, ui, pkb, stack }) => {
  await rp.registerOk('alice');
  await expect(ui.toast('saved')).toBeVisible();
  await ui.expectNoDialog();

  const alice = await rpApi.user('alice');
  const credentials = await pkb.listCredentials(stack.users.a);
  expect(credentials).toHaveLength(1);
  expect(credentials[0]).toMatchObject({
    id: alice.credentials[0].id,
    rp_id: RP_ID,
    user_name: 'alice',
    user_handle: alice.userHandle,
    origin: RP_ORIGIN,
    alg: -7,
  });
  expect(await pkb.listCredentials(stack.users.b)).toEqual([]);
});

test('registering the same account on the same site again overwrites the old passkey', async ({ rp, pkb, stack }) => {
  await rp.registerOk('alice');
  await rp.registerOk('alice');

  // The RP keeps both credentials, the server only the newest one (same rp_id + user_handle).
  const alice = await rpApi.user('alice');
  expect(alice.credentials).toHaveLength(2);
  const credentials = await pkb.listCredentials(stack.users.a, RP_ID);
  expect(credentials.map((c) => c.id)).toEqual([alice.credentials[1].id]);

  await rp.login();
  await rp.expectResult('authenticated:alice');
});

test('registering with excludeCredentials that match a saved passkey fails with InvalidStateError', async ({
  rp,
  ui,
  pkb,
  stack,
}) => {
  await rp.registerOk('alice');
  const before = await pkb.listCredentials(stack.users.a);

  await rp.register('alice', { exclude: true });
  await rp.expectResult('error:InvalidStateError');
  await expect(ui.toast('exists')).toBeVisible();
  await ui.expectNoDialog();

  expect((await pkb.listCredentials(stack.users.a)).map((c) => c.id)).toEqual(before.map((c) => c.id));
  expect((await rpApi.user('alice')).credentials).toHaveLength(1);
});

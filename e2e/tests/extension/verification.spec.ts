import { RP_ORIGIN } from '../../support/config.ts';
import { expect, test } from '../../support/extension-fixtures.ts';
import { rpApi } from '../../support/rp.ts';

test('a configured but unenrolled extension rejects required registration before writing', async ({
  extension, stack, authenticator, rp, pkb,
}) => {
  extension.autoVerify = false;
  await extension.configure(stack.users.a, {}, { enroll: false });
  await rp.goto({ requireUV: true });
  await rp.register('alice');

  await rp.expectResult('error:NotAllowedError');
  expect(await pkb.listCredentials(stack.users.a)).toEqual([]);
  expect((await rpApi.user('alice')).credentials).toEqual([]);
  expect(authenticator.operations).toEqual([]);
});

test('required registration and authentication await verification on the extension origin', async ({
  extension, stack, authenticator, rp, pkb,
}) => {
  extension.autoVerify = false;
  await extension.configure(stack.users.a);
  await rp.goto({ requireUV: true });
  await rp.register('alice');

  const registration = await extension.waitForVerification();
  expect(extension.isVerificationUrl(new URL(registration.url()))).toBe(true);
  await expect(registration.locator('#device-site')).toContainText(RP_ORIGIN);
  await expect(rp.result).toHaveText('pending:register');
  expect(await pkb.listCredentials(stack.users.a)).toEqual([]);
  expect((await rpApi.user('alice')).credentials).toEqual([]);

  await extension.addDeviceAuthenticator(registration);
  await registration.locator('#verify').click();
  await rp.expectResult('registered:alice');
  const [saved] = await pkb.listCredentials(stack.users.a);
  expect(saved?.user_name).toBe('alice');

  await rp.login();
  const authentication = await extension.waitForVerification();
  await expect(authentication.locator('#device-site')).toContainText(RP_ORIGIN);
  await expect(rp.result).toHaveText('pending:login');
  expect((await pkb.listCredentials(stack.users.a))[0]?.use_count).toBe(0);

  await extension.addDeviceAuthenticator(authentication);
  await authentication.locator('#verify').click();
  await rp.expectResult('authenticated:alice');
  await expect.poll(async () => (await pkb.listCredentials(stack.users.a))[0]?.use_count).toBe(1);
  expect(authenticator.operations).toEqual([]);
});

test('canceling device registration approval leaves the website and Passkey Box without a passkey', async ({
  extension, stack, rp, pkb,
}) => {
  extension.autoVerify = false;
  await extension.configure(stack.users.a);
  await rp.goto({ requireUV: true });
  await rp.register('alice');

  const approval = await extension.waitForVerification();
  await approval.locator('#cancel').click();

  await rp.expectResult('error:NotAllowedError');
  expect(await pkb.listCredentials(stack.users.a)).toEqual([]);
  expect((await rpApi.user('alice')).credentials).toEqual([]);
});

test('canceling required login leaves local passkey usage untouched', async ({ extension, stack, rp, pkb }) => {
  await extension.configure(stack.users.a);
  await rp.goto({ requireUV: true });
  await rp.registerOk('alice');
  const before = await rpApi.user('alice');

  extension.autoVerify = false;
  await rp.login();
  const approval = await extension.waitForVerification();
  await approval.locator('#cancel').click();

  await rp.expectResult('error:NotAllowedError');
  expect(await rpApi.user('alice')).toEqual(before);
  expect((await pkb.listCredentials(stack.users.a))[0]?.use_count).toBe(0);
});

test('an extension device assertion without verified-user evidence does not authorize login', async ({
  extension, stack, rp, pkb,
}) => {
  await extension.configure(stack.users.a);
  await rp.goto({ requireUV: true });
  await rp.registerOk('alice');
  const before = await rpApi.user('alice');

  extension.autoVerify = false;
  await rp.login();
  const approval = await extension.waitForVerification();
  const device = await extension.addDeviceAuthenticator(approval);
  await device.clearResponseFlag('UV');
  await approval.locator('#verify').click();

  await rp.expectResult('error:NotAllowedError');
  expect(await rpApi.user('alice')).toEqual(before);
  expect((await pkb.listCredentials(stack.users.a))[0]?.use_count).toBe(0);
});

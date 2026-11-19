// Smoke test for the test RP itself: no extension, no Passkey Box server. Chrome's native
// WebAuthn implementation is backed by a CDP virtual authenticator.

import { expect, test } from '@playwright/test';
import { RP_ID } from '../support/config.ts';
import { RpPage, rpApi } from '../support/rp.ts';
import { base64ToBase64url, VirtualAuthenticator } from '../support/virtual-authenticator.ts';

test.beforeEach(async () => {
  await rpApi.reset();
});

test('registers, then logs in usernameless and username-first', async ({ page }) => {
  const authenticator = await VirtualAuthenticator.attach(page);
  const rp = new RpPage(page);
  await rp.goto();

  await rp.register('alice');
  await rp.expectResult('registered:alice');

  const alice = await rpApi.user('alice');
  expect(alice.credentials).toHaveLength(1);
  const [stored] = await authenticator.credentials();
  expect(stored).toMatchObject({ isResidentCredential: true, rpId: RP_ID });
  expect(base64ToBase64url(stored.credentialId)).toBe(alice.credentials[0].id);
  expect(base64ToBase64url(stored.userHandle ?? '')).toBe(alice.userHandle);

  // The authenticator survives a navigation (the extension fallback spec relies on that).
  await page.reload();
  await rp.login();
  await rp.expectResult('authenticated:alice');

  await rp.register('bob');
  await rp.expectResult('registered:bob');
  await rp.loginWithUsername('bob');
  await rp.expectResult('authenticated:bob');
  await rp.loginWithUsername('alice');
  await rp.expectResult('authenticated:alice');

  expect((await rpApi.user('alice')).credentials[0].counter).toBeGreaterThan(0);
  // The extension specs rely on these events to prove the native implementation was not used.
  await expect
    .poll(() => authenticator.operations)
    .toEqual(['credentialAdded', 'credentialAsserted', 'credentialAdded', 'credentialAsserted', 'credentialAsserted']);
});

test('excludeCredentials makes a duplicate registration fail with InvalidStateError', async ({ page }) => {
  await VirtualAuthenticator.attach(page);
  const rp = new RpPage(page);
  await rp.goto();

  await rp.register('alice');
  await rp.expectResult('registered:alice');
  await rp.register('alice', { exclude: true });
  await rp.expectResult('error:InvalidStateError');
  expect((await rpApi.user('alice')).credentials).toHaveLength(1);
});

test('re-registering without excludeCredentials keeps both credentials on the RP', async ({ page }) => {
  await VirtualAuthenticator.attach(page);
  const rp = new RpPage(page);
  await rp.goto();

  await rp.register('alice');
  await rp.expectResult('registered:alice');
  const { userHandle } = await rpApi.user('alice');
  await rp.register('alice');
  await rp.expectResult('registered:alice');

  const alice = await rpApi.user('alice');
  expect(alice.userHandle).toBe(userHandle);
  expect(alice.credentials).toHaveLength(2);
});

test('rejects assertions for credentials it does not know', async ({ page }) => {
  await VirtualAuthenticator.attach(page);
  const rp = new RpPage(page);
  await rp.goto();

  await rp.register('alice');
  await rp.expectResult('registered:alice');
  await rpApi.reset();
  await rp.login();
  await rp.expectResult('rejected:unknown-credential');

  await rp.loginWithUsername('alice');
  await rp.expectResult('rejected:unknown-user');
});

test('conditional page starts an autofill login on load', async ({ page }) => {
  await VirtualAuthenticator.attach(page);
  const rp = new RpPage(page);
  await rp.goto();
  await rp.register('alice');
  await rp.expectResult('registered:alice');

  // With automaticPresenceSimulation the virtual authenticator answers the conditional
  // request by itself, so the login completes without any click.
  await rp.goto({ conditional: true });
  await expect(rp.username).toHaveAttribute('autocomplete', 'username webauthn');
  await rp.expectResult('authenticated:alice');
});

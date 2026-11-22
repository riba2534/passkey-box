import { createHmac } from 'node:crypto';
import { expect, test } from '../../support/extension-fixtures.ts';
import { extensionSince } from '../../support/stack.ts';

// Since 0.7.0 the owner can add custom fields to a passkey. The popup lists them under the details:
// a password stays hidden until shown and a TOTP field shows its current code. Older extensions get
// the same credentials with `fields` in them and must keep signing in and showing the details.

const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

/** RFC 6238 with SHA1, 6 digits and 30-second steps, computed here rather than by the extension. */
function totpAt(base32: string, unixSeconds: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...base32].map((ch) => alphabet.indexOf(ch).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / 30)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('the popup shows custom fields: passwords hidden, a TOTP field as its current code', async ({ extension, stack, context, rp, pkb }) => {
  const { a } = stack.users;
  await extension.configure(a);
  await rp.goto();
  await rp.registerOk('alice');
  const [alice] = await pkb.listCredentials(a);
  const updated = await pkb.updateCredential(a, alice.id, {
    fields: [
      { label: '工号', type: 'text', value: 'E-1024' },
      { label: '恢复码', type: 'password', value: 'abcd-efgh-ijkl' },
      { label: '', type: 'totp', value: TOTP_SECRET },
    ],
  });
  expect(updated.fields?.map((f) => [f.label, f.type, f.value])).toEqual([
    ['工号', 'text', 'E-1024'],
    ['恢复码', 'password', 'abcd-efgh-ijkl'],
    ['', 'totp', TOTP_SECRET],
  ]);

  // Signing in reads the same list, fields and all.
  await rp.login();
  await rp.expectResult('authenticated:alice');

  const popup = await context.newPage();
  await popup.goto(extension.popupUrl);
  await popup.locator(`[data-credential-id="${alice.id}"]`).click();
  await expect(popup.locator('.field-row').filter({ hasText: '网站' }).locator('dd')).toHaveText('localhost');
  // An older extension got this far with the fields in every response; the rest is 0.7.0 UI.
  test.skip(!extensionSince(stack, '0.7.0'), 'extensions before 0.7.0 do not show custom fields');

  const rows = popup.locator('.custom-fields .field-row');
  const value = (i: number) => rows.nth(i).locator('.field-value');
  await expect(rows.locator('dt')).toHaveText(['工号', '恢复码', '一次性密码']);
  await expect(value(0)).toHaveText('E-1024');
  await expect(value(1)).toHaveText('••••••••');
  await expect(popup.locator('body')).not.toContainText('abcd-efgh-ijkl');
  await expect(popup.locator('body')).not.toContainText(TOTP_SECRET);
  await rows.nth(1).getByRole('button', { name: '显示', exact: true }).click();
  await expect(value(1)).toHaveText('abcd-efgh-ijkl');

  await expect(value(2)).toHaveText(/^\d{3} \d{3}$/);
  const now = Date.now() / 1000;
  const shown = (await value(2).textContent())?.replace(' ', '');
  // The code may have just changed on either side of a period boundary.
  expect([-30, 0, 30].map((offset) => totpAt(TOTP_SECRET, now + offset))).toContain(shown);
  await expect(rows.nth(2).locator('.totp-remaining')).toHaveText(/^([1-9]|[12]\d|30) 秒$/);
});

// One-time codes for TOTP fields: base32 secrets, otpauth:// links and
// RFC 6238 codes computed with WebCrypto. The functions touch no DOM, so
// they run in node as well.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const ALGORITHMS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

/**
 * trimSpace removes ASCII white space (space, \t, \n, \r, \f, \v) from both
 * ends, as the server and the extension do. String.prototype.trim would also
 * remove characters such as U+0085 and U+FEFF that they keep.
 *
 * @param {string} s
 * @returns {string}
 */
export function trimSpace(s) {
  return s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
}

/**
 * decodeBase32 decodes a TOTP secret by the rules the server and the
 * extension share: ASCII white space and "-" are ignored, "=" padding may
 * end it, and case does not matter. Only A-Z, a-z and 2-7 are checked for
 * before upper-casing, which would turn "ß" into "SS".
 *
 * @param {string} text
 * @returns {Uint8Array|null} The bytes, at least one, or null when the text
 *   is not base32.
 */
function decodeBase32(text) {
  let s = String(text).replace(/[ \t\n\r\f\v-]/g, '').replace(/=+$/, '');
  // Leftovers of 1, 3 or 6 characters cannot come from whole bytes.
  if (!/^[A-Za-z2-7]+$/.test(s) || [1, 3, 6].includes(s.length % 8)) return null;
  s = s.toUpperCase();
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const ch of s) {
    acc = ((acc << 5) | BASE32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/**
 * @typedef {object} TotpParams
 * @property {Uint8Array} secret
 * @property {'SHA-1'|'SHA-256'|'SHA-512'} algorithm  A WebCrypto hash name.
 * @property {number} digits   6 to 8.
 * @property {number} period   Seconds, 1 to 300.
 */

/**
 * parseTotp reads the value of a TOTP field: a base32 secret or an
 * otpauth://totp/<label>?secret=…[&issuer][&algorithm][&digits][&period]
 * link, by the same rules the server checks.
 *
 * @param {string} value
 * @returns {TotpParams | {error: string}} The parameters, or why the value
 *   is not usable (Chinese text for the form).
 */
export function parseTotp(value) {
  const text = trimSpace(String(value || ''));
  if (!text) return { error: '请输入密钥' };
  const params = { secret: null, algorithm: 'SHA-1', digits: 6, period: 30 };
  if (!/^otpauth:/i.test(text)) {
    params.secret = decodeBase32(text);
    return params.secret ? params : { error: '密钥不是有效的 base32' };
  }

  // The server's URL parser refuses control characters, which the browser's
  // would drop or escape, and malformed %-escapes, which it would keep.
  let url;
  try {
    if (/[\x00-\x1f\x7f]/.test(text)) throw new Error('control character');
    url = new URL(text);
  } catch {
    return { error: 'otpauth:// 链接格式不正确' };
  }
  if (url.host.toLowerCase() !== 'totp') return { error: '只支持 otpauth://totp/ 链接' };
  if (/%(?![0-9A-Fa-f]{2})/.test(url.search)) return { error: '链接的参数格式不正确' };
  // Parameter names do not depend on case; the first of a name counts.
  const q = new Map();
  for (const [k, v] of url.searchParams) {
    const key = k.toLowerCase();
    if (!q.has(key)) q.set(key, v);
  }
  if (!q.get('secret')) return { error: '链接里缺少 secret' };
  params.secret = decodeBase32(q.get('secret'));
  if (!params.secret) return { error: '链接里的 secret 不是有效的 base32' };
  if (q.get('algorithm')) {
    params.algorithm = ALGORITHMS[q.get('algorithm').toUpperCase()];
    if (!params.algorithm) return { error: 'algorithm 只能是 SHA1、SHA256 或 SHA512' };
  }
  if (q.get('digits')) {
    if (!['6', '7', '8'].includes(q.get('digits'))) return { error: 'digits 只能是 6、7 或 8' };
    params.digits = Number(q.get('digits'));
  }
  if (q.get('period')) {
    // Digits only, leading zeros allowed: "030" is 30.
    const p = /^[0-9]+$/.test(q.get('period')) ? Number(q.get('period')) : 0;
    if (p < 1 || p > 300) return { error: 'period 必须是 1 到 300 秒' };
    params.period = p;
  }
  return params;
}

/**
 * canComputeCodes reports whether WebCrypto is there: browsers offer it to
 * HTTPS pages and localhost only.
 *
 * @returns {boolean}
 */
export function canComputeCodes() {
  return Boolean(globalThis.crypto && globalThis.crypto.subtle);
}

/**
 * hotp computes an RFC 4226 code.
 *
 * @param {Uint8Array} secret
 * @param {number} counter  A non-negative integer.
 * @param {'SHA-1'|'SHA-256'|'SHA-512'} [algorithm]
 * @param {number} [digits]
 * @returns {Promise<string>} The code, padded with zeros on the left.
 */
export async function hotp(secret, counter, algorithm = 'SHA-1', digits = 6) {
  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: algorithm }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * totpCounter is the RFC 6238 time step at a moment.
 *
 * @param {TotpParams} params
 * @param {number} unixSeconds
 * @returns {{counter: number, remaining: number}} The step, and the seconds
 *   left in it (1 to period).
 */
export function totpCounter(params, unixSeconds) {
  const s = Math.floor(unixSeconds);
  return { counter: Math.floor(s / params.period), remaining: params.period - (s % params.period) };
}

/**
 * groupCode splits a code in two for reading, "123 456"; with an odd
 * length the first group is longer, "1234 567", as in the extension.
 *
 * @param {string} code
 * @returns {string}
 */
export function groupCode(code) {
  const half = Math.ceil(code.length / 2);
  return code.slice(0, half) + ' ' + code.slice(half);
}

// One-time passwords of "totp" custom fields (RFC 6238 over RFC 4226 HOTP, WebCrypto HMAC).
// A field holds a base32 secret or an otpauth://totp/ URI; the server checks the same rules.

import type { Bytes } from "./base64url";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpParams {
  secret: Bytes;
  algorithm: TotpAlgorithm;
  /** 6–8 */
  digits: number;
  /** Seconds, 1–300 */
  period: number;
}

const HASH: Record<TotpAlgorithm, string> = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// The server's rules know only ASCII whitespace; \s and String.prototype.trim() also take U+0085, U+FEFF and more.
const SPACE_OR_DASH = /[ \t\n\r\f\v-]/g;
const EDGE_SPACE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

/**
 * RFC 4648 base32, case-insensitive, ignoring ASCII whitespace and "-", optionally "="-padded (CONTRACT §2).
 * Null for other characters, "=" before the end, or a length no encoder produces, which includes no bytes at all.
 */
export function decodeBase32(text: string): Bytes | null {
  const s = text.replace(SPACE_OR_DASH, "").replace(/=+$/, "");
  // Checked before upper-casing, which turns "ß" into "SS".
  if (!/^[A-Za-z2-7]+$/.test(s) || [1, 3, 6].includes(s.length % 8)) return null;
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let n = 0;
  for (const ch of s.toUpperCase()) {
    buffer = ((buffer << 5) | BASE32.indexOf(ch)) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = buffer >> bits;
    }
  }
  return out;
}

/** A field value as TOTP parameters (CONTRACT §2), or null when it is neither form. */
export function parseTotp(value: string): TotpParams | null {
  const text = value.replace(EDGE_SPACE, "");
  if (!/^otpauth:/i.test(text)) {
    const secret = decodeBase32(text);
    return secret && { secret, algorithm: "SHA1", digits: 6, period: 30 };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.host.toLowerCase() !== "totp") return null;
  // Parameter names are case-insensitive; the first of a repeated one counts, and an empty one is left out.
  const params = new Map<string, string>();
  for (const [name, v] of url.searchParams) {
    const key = name.toLowerCase();
    if (!params.has(key)) params.set(key, v);
  }
  const secret = decodeBase32(params.get("secret") ?? "");
  const algorithm = (params.get("algorithm") || "SHA1").toUpperCase();
  const digits = params.get("digits") || "6";
  // Only digits, read as a whole number: "030" is 30.
  const period = params.get("period") || "30";
  if (!secret || !Object.hasOwn(HASH, algorithm) || !["6", "7", "8"].includes(digits) || !/^\d+$/.test(period)) return null;
  if (Number(period) < 1 || Number(period) > 300) return null;
  return { secret, algorithm: algorithm as TotpAlgorithm, digits: Number(digits), period: Number(period) };
}

/** RFC 4226: HMAC of the 8-byte big-endian counter, dynamically truncated to `digits` decimal digits. */
export async function hotp(params: Omit<TotpParams, "period">, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", params.secret, { name: "HMAC", hash: HASH[params.algorithm] }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
  return String(binary % 10 ** params.digits).padStart(params.digits, "0");
}

export interface TotpCode {
  code: string;
  /** Seconds until the next code, 1–period */
  remaining: number;
}

/** RFC 6238: the code at `now` (milliseconds since the epoch) for T = floor(unix seconds / period). */
export async function totp(params: TotpParams, now = Date.now()): Promise<TotpCode> {
  const seconds = Math.floor(now / 1000);
  const code = await hotp(params, Math.floor(seconds / params.period));
  return { code, remaining: params.period - (seconds % params.period) };
}

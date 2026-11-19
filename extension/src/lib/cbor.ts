// Minimal CTAP2 canonical CBOR encoder (RFC 8949 §4.2.3 "length-first" key ordering).
// Supports exactly what an authenticator needs: integers, byte/text strings, arrays,
// maps (string or integer keys), booleans and null.

import { concatBytes, utf8, type Bytes } from "./base64url";

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | CborValue[]
  | CborMap
  | { [key: string]: CborValue };

export type CborMap = Map<number | string, CborValue>;

function head(major: number, value: number): Bytes {
  const m = major << 5;
  if (value < 24) return new Uint8Array([m | value]);
  if (value < 0x100) return new Uint8Array([m | 24, value]);
  if (value < 0x10000) return new Uint8Array([m | 25, value >> 8, value & 0xff]);
  if (value < 0x100000000) {
    return new Uint8Array([m | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
  }
  const out = new Uint8Array(9);
  out[0] = m | 27;
  new DataView(out.buffer).setBigUint64(1, BigInt(value));
  return out;
}

function encodeInteger(n: number): Bytes {
  if (!Number.isSafeInteger(n)) throw new TypeError(`CBOR: unsupported number ${n}`);
  return n >= 0 ? head(0, n) : head(1, -1 - n);
}

/** Orders encoded keys by length first, then bytewise (CTAP2 canonical form). */
export function compareEncodedKeys(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

function encodeMap(entries: Array<[number | string, CborValue]>): Bytes {
  const encoded = entries.map(([k, v]) => [encodeCbor(k), encodeCbor(v)] as const);
  encoded.sort((x, y) => compareEncodedKeys(x[0], y[0]));
  return concatBytes(head(5, encoded.length), ...encoded.flat());
}

export function encodeCbor(value: CborValue): Bytes {
  if (value === null) return new Uint8Array([0xf6]);
  if (value === false) return new Uint8Array([0xf4]);
  if (value === true) return new Uint8Array([0xf5]);
  if (typeof value === "number") return encodeInteger(value);
  if (typeof value === "string") {
    const bytes = utf8(value);
    return concatBytes(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concatBytes(head(2, value.length), value);
  if (Array.isArray(value)) return concatBytes(head(4, value.length), ...value.map(encodeCbor));
  if (value instanceof Map) return encodeMap([...value.entries()]);
  if (typeof value === "object") return encodeMap(Object.entries(value));
  throw new TypeError(`CBOR: unsupported value ${String(value)}`);
}

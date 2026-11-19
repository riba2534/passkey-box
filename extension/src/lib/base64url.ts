// base64url (RFC 4648 §5, no padding) helpers that work in pages, service workers and Node.

export type Bytes = Uint8Array<ArrayBuffer>;

const CHUNK = 0x8000;

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(input: string): Bytes {
  const trimmed = input.replace(/=+$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(trimmed) || trimmed.length % 4 === 1) {
    throw new TypeError("invalid base64url string");
  }
  const base64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function tag(value: unknown): string {
  return Object.prototype.toString.call(value);
}

/** True for ArrayBuffer and ArrayBufferView values, including ones from other realms. */
export function isBufferSource(value: unknown): value is BufferSource {
  if (value === null || typeof value !== "object") return false;
  return tag(value) === "[object ArrayBuffer]" || ArrayBuffer.isView(value);
}

/** Copies a BufferSource into a fresh Uint8Array. Throws TypeError for anything else. */
export function bufferSourceToBytes(value: unknown): Bytes {
  if (!isBufferSource(value)) throw new TypeError("expected an ArrayBuffer or ArrayBufferView");
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
  }
  return new Uint8Array((value as ArrayBuffer).slice(0));
}

export function bufferSourceToBase64url(value: unknown): string {
  return bytesToBase64url(bufferSourceToBytes(value));
}

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text) as Bytes;
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

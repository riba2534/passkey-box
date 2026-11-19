// Describes the calling frame for clientDataJSON (origin, crossOrigin, topOrigin).

import type { CallerInfo } from "./protocol";

export interface LocationLike {
  origin: string;
  hostname: string;
  ancestorOrigins?: ArrayLike<string> | null;
}

/** True for tuple origins with an http(s) scheme; false for opaque ("null") and other schemes. */
export function isHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
  } catch {
    return false;
  }
}

/**
 * `fallbackOrigin` covers about:blank frames whose location.origin is "null" (use window.origin).
 * Opaque origins (sandboxed frames) stay "null" with an empty hostname; the handler ignores them.
 */
export function callerInfo(loc: LocationLike, fallbackOrigin?: string): CallerInfo {
  const origin = loc.origin !== "null" ? loc.origin : (fallbackOrigin ?? loc.origin);
  const hostname = isHttpOrigin(origin) ? new URL(origin).hostname : "";
  const ancestors = loc.ancestorOrigins ? Array.from(loc.ancestorOrigins) : [];
  const crossOrigin = ancestors.some((a) => a !== origin);
  const info: CallerInfo = { origin, hostname, crossOrigin };
  if (crossOrigin) info.topOrigin = ancestors[ancestors.length - 1]!;
  return info;
}

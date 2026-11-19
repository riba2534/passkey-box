// Describes the calling frame for clientDataJSON (origin, crossOrigin, topOrigin).

import type { CallerInfo } from "./protocol";

export interface LocationLike {
  origin: string;
  hostname: string;
  ancestorOrigins?: ArrayLike<string> | null;
}

/** `fallbackOrigin` covers about:blank frames whose location.origin is "null" (use window.origin). */
export function callerInfo(loc: LocationLike, fallbackOrigin?: string): CallerInfo {
  const origin = loc.origin !== "null" ? loc.origin : (fallbackOrigin ?? loc.origin);
  let hostname = loc.hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    // keep location.hostname
  }
  const ancestors = loc.ancestorOrigins ? Array.from(loc.ancestorOrigins) : [];
  const crossOrigin = ancestors.some((a) => a !== origin);
  const info: CallerInfo = { origin, hostname, crossOrigin };
  if (crossOrigin) info.topOrigin = ancestors[ancestors.length - 1]!;
  return info;
}

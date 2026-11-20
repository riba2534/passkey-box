// Relying Party ID helpers.

import { getDomain } from "tldts";

/** Effective rpId: the requested one, or the page hostname when absent. */
export function effectiveRpId(requested: string | null | undefined, hostname: string): string {
  return requested === undefined || requested === null ? hostname : requested;
}

/** IPv4 dotted quad, or an IPv6 literal (bracketed as in URL.hostname, or bare). */
export function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[") || hostname.includes(":");
}

/**
 * A host may use rpId when it equals rpId (case-insensitive), or is a subdomain of it.
 * Subdomain matching is not allowed for IP address hosts or for rpIds without a dot
 * (so "localhost" works only on localhost, and "com" is never accepted for a.com).
 */
export function hostMatchesRpId(hostname: string, rpId: string): boolean {
  if (!rpId || !hostname) return false;
  const host = hostname.toLowerCase();
  const rp = rpId.toLowerCase();
  if (host === rp) return true;
  if (isIpAddress(host) || !rp.includes(".")) return false;
  return host.endsWith("." + rp) && getDomain(rp, { allowPrivateDomains: true }) !== null;
}

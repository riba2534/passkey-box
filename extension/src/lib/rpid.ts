// Relying Party ID helpers.

/** Effective rpId: the requested one, or the page hostname when absent. */
export function effectiveRpId(requested: string | null | undefined, hostname: string): string {
  return requested === undefined || requested === null ? hostname : requested;
}

/** A host may use rpId when it equals rpId or is a subdomain of it (case-insensitive). */
export function hostMatchesRpId(hostname: string, rpId: string): boolean {
  if (!rpId || !hostname) return false;
  const host = hostname.toLowerCase();
  const rp = rpId.toLowerCase();
  return host === rp || host.endsWith("." + rp);
}

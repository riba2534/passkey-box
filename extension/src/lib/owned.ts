// Credentials registered or used in this browser profile. Several profiles (for example in
// AnyBrowser) can share one Passkey Box account; chrome.storage.local is per profile, so this
// record tells which of a site's accounts belong to the current one.

export const OWNED_KEY = "pkb_owned";
/** Oldest entries are dropped beyond this many credentials. */
export const OWNED_LIMIT = 500;

/** Credential ID → last registration or sign-in in this profile (ms since epoch). */
export type OwnedCredentials = ReadonlyMap<string, number>;

/** Reads the stored `{ id: time }` object; anything malformed is skipped. */
export function normalizeOwned(value: unknown): Map<string, number> {
  const owned = new Map<string, number>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return owned;
  for (const [id, time] of Object.entries(value)) {
    if (id !== "" && typeof time === "number" && Number.isFinite(time)) owned.set(id, time);
  }
  return owned;
}

/** Records `id` as used at `now`, keeping it and the `limit - 1` most recent others. */
export function rememberCredential(owned: OwnedCredentials, id: string, now: number, limit = OWNED_LIMIT): Map<string, number> {
  const others = [...owned].filter(([key]) => key !== id).sort((a, b) => b[1] - a[1]);
  return new Map([[id, now], ...others.slice(0, Math.max(0, limit - 1))]);
}

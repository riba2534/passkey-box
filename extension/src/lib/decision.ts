// Pure decision logic for get/create requests (CONTRACT 4.4).

import { ALG_ES256, ALG_RS256, type CoseAlgorithm } from "./authenticator";
import type { Settings } from "./config";
import type { AutoLoginPolicy } from "./managed";
import type { OwnedCredentials } from "./owned";

/**
 * auto    – sign right away with the only candidate, or (with autoLoginSingle) the only one this browser profile
 *           registered or used; under the owned-only policy only with the latter
 * picker  – let the user choose
 * empty   – show the "no passkey" dialog
 * pending – stay silent until the page aborts
 */
export type GetDecision = "auto" | "picker" | "empty" | "pending";

export function decideGet(
  candidateCount: number,
  mediation: string | undefined,
  settings: Settings,
  ownedCount = 0,
  autoLogin: AutoLoginPolicy = "any",
): GetDecision {
  // Among several accounts, the only one this browser profile registered or used counts as the only candidate,
  // unless the user turned off skipping the choice: then several accounts always show the picker.
  const count = candidateCount > 1 && ownedCount === 1 && settings.autoLoginSingle ? 1 : candidateCount;
  // owned-only: an account this browser profile never registered or used is not signed in by itself, even as the
  // only candidate; the user picks it once, and the choice is recorded for this profile.
  const single = count === 1 && (autoLogin === "any" || ownedCount === 1);
  if (mediation === "conditional") {
    if (!settings.conditionalAutoLogin || count === 0) return "pending";
    return single ? "auto" : "picker";
  }
  if (count === 0) return "empty";
  if (single && settings.autoLoginSingle) return "auto";
  return "picker";
}

/** Keeps credentials listed in allowCredentials; an empty or missing list keeps everything. */
export function filterByAllowList<T extends { id: string }>(credentials: T[], allowIds: string[] | undefined): T[] {
  if (!allowIds || allowIds.length === 0) return credentials;
  const allowed = new Set(allowIds);
  return credentials.filter((c) => allowed.has(c.id));
}

/** Credentials this browser profile registered or used come first, most recent first; the rest keep their order. */
export function rankOwnedFirst<T extends { id: string }>(credentials: T[], owned: OwnedCredentials): T[] {
  const mine = credentials.filter((c) => owned.has(c.id)).sort((a, b) => owned.get(b.id)! - owned.get(a.id)!);
  return [...mine, ...credentials.filter((c) => !owned.has(c.id))];
}

/** True when any excluded ID already exists among the stored credentials. */
export function hasExcludedCredential(credentials: Array<{ id: string }>, excludeIds: string[] | undefined): boolean {
  if (!excludeIds || excludeIds.length === 0) return false;
  const existing = new Set(credentials.map((c) => c.id));
  return excludeIds.some((id) => existing.has(id));
}

/** Empty params or -7 present → ES256; otherwise -257 → RS256; otherwise unsupported (null). */
export function selectAlgorithm(params: Array<{ type?: string; alg: number }> | undefined): CoseAlgorithm | null {
  const algs = (params ?? []).filter((p) => p.type === undefined || p.type === "public-key").map((p) => p.alg);
  if (!params || params.length === 0 || algs.includes(ALG_ES256)) return ALG_ES256;
  if (algs.includes(ALG_RS256)) return ALG_RS256;
  return null;
}

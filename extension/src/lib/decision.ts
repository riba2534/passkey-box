// Pure decision logic for get/create requests (CONTRACT 4.4).

import { ALG_ES256, ALG_RS256, type CoseAlgorithm } from "./authenticator";
import type { Settings } from "./config";

/**
 * auto    – sign with the only candidate right away
 * picker  – let the user choose
 * empty   – show the "no passkey" dialog
 * pending – stay silent until the page aborts
 */
export type GetDecision = "auto" | "picker" | "empty" | "pending";

export function decideGet(candidateCount: number, mediation: string | undefined, settings: Settings): GetDecision {
  if (mediation === "conditional") {
    if (!settings.conditionalAutoLogin || candidateCount === 0) return "pending";
    return candidateCount === 1 ? "auto" : "picker";
  }
  if (candidateCount === 0) return "empty";
  if (candidateCount === 1 && settings.autoLoginSingle) return "auto";
  return "picker";
}

/** Keeps credentials listed in allowCredentials; an empty or missing list keeps everything. */
export function filterByAllowList<T extends { id: string }>(credentials: T[], allowIds: string[] | undefined): T[] {
  if (!allowIds || allowIds.length === 0) return credentials;
  const allowed = new Set(allowIds);
  return credentials.filter((c) => allowed.has(c.id));
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

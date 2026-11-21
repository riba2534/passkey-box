// Background request handling: decides what to do with a page's create/get call.

import { describeError, type Credential, type NewCredential } from "./api";
import { ALG_ES256, ALG_RS256, createAssertion, createRegistration, type CoseAlgorithm } from "./authenticator";
import { isHttpOrigin } from "./caller";
import type { Config, Settings } from "./config";
import { decideGet, filterByAllowList, hasExcludedCredential, rankOwnedFirst, selectAlgorithm } from "./decision";
import type { OwnedCredentials } from "./owned";
import { requestedRpId, type BackgroundRequest, type BackgroundResponse, type CandidateSummary } from "./protocol";
import { effectiveRpId, hostMatchesRpId } from "./rpid";

export interface CredentialStore {
  listCredentials(rpId?: string): Promise<Credential[]>;
  createCredential(credential: NewCredential): Promise<unknown>;
  useCredential(id: string): Promise<void>;
}

/** Credentials registered or used in this browser profile (owned.ts). */
export interface OwnedStore {
  load(): Promise<OwnedCredentials>;
  remember(id: string): Promise<void>;
}

export interface HandlerDeps {
  loadConfig(): Promise<Config | null>;
  loadSettings(): Promise<Settings>;
  store(config: Config): CredentialStore;
  owned: OwnedStore;
  signal?: AbortSignal;
}

const MSG_SECURITY = "The relying party ID is not a registrable domain suffix of, nor equal to the current domain.";
const MSG_EXISTS =
  "The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.";
const MSG_ALG = "None of the requested public key algorithms are supported. Passkey Box supports ES256 (-7) and RS256 (-257).";
// The page aborted the request (AbortSignal, navigation or tab close): discard the result.
const ABORTED = { action: "reject", name: "NotAllowedError", message: "请求已取消。" } as const;

function summarize(c: Credential, owned: OwnedCredentials): CandidateSummary {
  return { id: c.id, user_name: c.user_name, user_display_name: c.user_display_name, rp_id: c.rp_id, owned: owned.has(c.id) };
}

export async function handleRequest(req: BackgroundRequest, deps: HandlerDeps): Promise<BackgroundResponse> {
  // Unconfigured, or an opaque/non-http(s) origin (e.g. sandboxed iframe): not ours to handle.
  if (!isHttpOrigin(req.caller.origin)) return { action: "fallback" };
  const config = await deps.loadConfig();
  if (!config) return { action: "fallback" };
  const rpId = effectiveRpId(requestedRpId(req.options), req.caller.hostname);
  if (!hostMatchesRpId(req.caller.hostname, rpId)) {
    return { action: "reject", name: "SecurityError", message: MSG_SECURITY };
  }
  const store = deps.store(config);
  return req.type === "pkb:create" ? handleCreate(req, rpId, store, deps) : handleGet(req, rpId, store, deps);
}

async function handleGet(
  req: Extract<BackgroundRequest, { type: "pkb:get" }>,
  rpId: string,
  store: CredentialStore,
  deps: HandlerDeps,
): Promise<BackgroundResponse> {
  let all: Credential[];
  try {
    all = await store.listCredentials(rpId);
  } catch (err) {
    // A conditional (autofill) request starts on page load without user action: stay silent.
    // Once the user picked an account (credentialId set), report the failure.
    if (req.mediation === "conditional" && req.credentialId === undefined) return { action: "pending" };
    return { action: "error", message: describeError(err) };
  }
  const candidates = filterByAllowList(all, req.options.allowCredentials.map((d) => d.id));

  let chosen: Credential | undefined;
  if (req.credentialId !== undefined) {
    chosen = candidates.find((c) => c.id === req.credentialId);
    if (!chosen) return { action: "error", message: "所选的通行密钥已不存在，请重试。" };
  } else {
    // Accounts this browser profile registered or used come first; a single one of them signs in
    // like the only candidate. Without the record, every account is treated alike.
    const owned = await deps.owned.load().catch(() => new Map<string, number>());
    const ranked = rankOwnedFirst(candidates, owned);
    const ownedCount = ranked.filter((c) => owned.has(c.id)).length;
    const decision = decideGet(candidates.length, req.mediation, await deps.loadSettings(), ownedCount);
    if (decision === "pending") return { action: "pending" };
    if (decision === "empty") return { action: "empty" };
    if (decision === "picker") return { action: "picker", candidates: ranked.map((c) => summarize(c, owned)) };
    chosen = ranked[0]!;
  }

  if (chosen.alg !== ALG_ES256 && chosen.alg !== ALG_RS256) {
    return { action: "error", message: `不支持的算法：${chosen.alg}` };
  }
  if (deps.signal?.aborted) return ABORTED;
  let credential;
  try {
    credential = await createAssertion({
      rpId,
      challenge: req.options.challenge,
      credentialId: chosen.id,
      alg: chosen.alg as CoseAlgorithm,
      privateKey: chosen.private_key,
      userHandle: chosen.user_handle,
      ...req.caller,
    });
  } catch (err) {
    return { action: "error", message: `签名失败：${describeError(err)}` };
  }
  if (deps.signal?.aborted) return ABORTED;
  store.useCredential(chosen.id).catch(() => undefined);
  await deps.owned.remember(chosen.id).catch(() => undefined);
  return { action: "success", credential, toast: "signed-in", userName: chosen.user_name };
}

async function handleCreate(
  req: Extract<BackgroundRequest, { type: "pkb:create" }>,
  rpId: string,
  store: CredentialStore,
  deps: HandlerDeps,
): Promise<BackgroundResponse> {
  const { options } = req;
  const excludeIds = options.excludeCredentials.map((d) => d.id);
  if (excludeIds.length > 0) {
    let existing: Credential[];
    try {
      existing = await store.listCredentials(rpId);
    } catch (err) {
      return { action: "error", message: describeError(err) };
    }
    if (hasExcludedCredential(existing, excludeIds)) {
      return { action: "reject", name: "InvalidStateError", message: MSG_EXISTS, toast: "exists" };
    }
  }
  const alg = selectAlgorithm(options.pubKeyCredParams);
  if (alg === null) return { action: "reject", name: "NotSupportedError", message: MSG_ALG };
  if (deps.signal?.aborted) return ABORTED;

  const registration = await createRegistration({
    rpId,
    challenge: options.challenge,
    alg,
    credProps: options.extensions.credProps === true,
    ...req.caller,
  });
  if (deps.signal?.aborted) return ABORTED;
  try {
    await store.createCredential({
      id: registration.credentialId,
      rp_id: rpId,
      rp_name: options.rp.name,
      user_handle: options.user.id,
      user_name: options.user.name,
      user_display_name: options.user.displayName,
      alg,
      private_key: registration.privateKey,
      public_key: registration.publicKey,
      origin: req.caller.origin,
      label: "",
    });
  } catch (err) {
    return { action: "error", message: `保存通行密钥失败：${describeError(err)}` };
  }
  if (deps.signal?.aborted) return ABORTED;
  await deps.owned.remember(registration.credentialId).catch(() => undefined);
  return { action: "success", credential: registration.response, toast: "saved", userName: options.user.name };
}

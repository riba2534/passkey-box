// Background request handling: decides what to do with a page's create/get call.

import { describeError, type Credential, type NewCredential } from "./api";
import { ALG_ES256, ALG_RS256, createAssertion, createRegistration, type CoseAlgorithm } from "./authenticator";
import type { Config, Settings } from "./config";
import { decideGet, filterByAllowList, hasExcludedCredential, selectAlgorithm } from "./decision";
import type { BackgroundRequest, BackgroundResponse, CallerInfo, CandidateSummary } from "./protocol";
import { effectiveRpId, hostMatchesRpId } from "./rpid";

export interface CredentialStore {
  listCredentials(rpId?: string): Promise<Credential[]>;
  createCredential(credential: NewCredential): Promise<unknown>;
  useCredential(id: string): Promise<void>;
}

export interface HandlerDeps {
  loadConfig(): Promise<Config | null>;
  loadSettings(): Promise<Settings>;
  store(config: Config): CredentialStore;
}

const MSG_SECURITY = "The relying party ID is not a registrable domain suffix of, nor equal to the current domain.";
const MSG_EXISTS =
  "The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.";
const MSG_ALG = "None of the requested public key algorithms are supported. Passkey Box supports ES256 (-7) and RS256 (-257).";

function caller(c: CallerInfo): { origin: string; crossOrigin: boolean; topOrigin?: string } {
  return c.crossOrigin && c.topOrigin
    ? { origin: c.origin, crossOrigin: true, topOrigin: c.topOrigin }
    : { origin: c.origin, crossOrigin: c.crossOrigin };
}

export function summarize(c: Credential): CandidateSummary {
  return { id: c.id, user_name: c.user_name, user_display_name: c.user_display_name, rp_id: c.rp_id };
}

export async function handleRequest(req: BackgroundRequest, deps: HandlerDeps): Promise<BackgroundResponse> {
  const config = await deps.loadConfig();
  if (!config) return { action: "fallback" };
  return req.type === "pkb:create" ? handleCreate(req, config, deps) : handleGet(req, config, deps);
}

async function handleGet(
  req: Extract<BackgroundRequest, { type: "pkb:get" }>,
  config: Config,
  deps: HandlerDeps,
): Promise<BackgroundResponse> {
  const rpId = effectiveRpId(req.options.rpId, req.caller.hostname);
  if (!hostMatchesRpId(req.caller.hostname, rpId)) {
    return { action: "reject", name: "SecurityError", message: MSG_SECURITY };
  }
  const store = deps.store(config);
  let all: Credential[];
  try {
    all = await store.listCredentials(rpId);
  } catch (err) {
    return { action: "error", rpId, message: describeError(err) };
  }
  const candidates = filterByAllowList(all, req.options.allowCredentials.map((d) => d.id));

  let chosen: Credential | undefined;
  if (req.credentialId !== undefined) {
    chosen = candidates.find((c) => c.id === req.credentialId);
    if (!chosen) return { action: "error", rpId, message: "所选的通行密钥已不存在，请重试。" };
  } else {
    const decision = decideGet(candidates.length, req.mediation, await deps.loadSettings());
    if (decision === "pending") return { action: "pending" };
    if (decision === "empty") return { action: "empty", rpId };
    if (decision === "picker") return { action: "picker", rpId, candidates: candidates.map(summarize) };
    chosen = candidates[0]!;
  }

  if (chosen.alg !== ALG_ES256 && chosen.alg !== ALG_RS256) {
    return { action: "error", rpId, message: `不支持的算法：${chosen.alg}` };
  }
  let credential;
  try {
    credential = await createAssertion({
      rpId,
      challenge: req.options.challenge,
      credentialId: chosen.id,
      alg: chosen.alg as CoseAlgorithm,
      privateKey: chosen.private_key,
      userHandle: chosen.user_handle,
      ...caller(req.caller),
    });
  } catch (err) {
    return { action: "error", rpId, message: `签名失败：${describeError(err)}` };
  }
  store.useCredential(chosen.id).catch(() => undefined);
  return { action: "success", credential, toast: "signed-in", userName: chosen.user_name };
}

async function handleCreate(
  req: Extract<BackgroundRequest, { type: "pkb:create" }>,
  config: Config,
  deps: HandlerDeps,
): Promise<BackgroundResponse> {
  const { options } = req;
  const rpId = effectiveRpId(options.rp.id, req.caller.hostname);
  if (!hostMatchesRpId(req.caller.hostname, rpId)) {
    return { action: "reject", name: "SecurityError", message: MSG_SECURITY };
  }
  const store = deps.store(config);
  const excludeIds = options.excludeCredentials.map((d) => d.id);
  if (excludeIds.length > 0) {
    let existing: Credential[];
    try {
      existing = await store.listCredentials(rpId);
    } catch (err) {
      return { action: "error", rpId, message: describeError(err) };
    }
    if (hasExcludedCredential(existing, excludeIds)) {
      return { action: "reject", name: "InvalidStateError", message: MSG_EXISTS, toast: "exists" };
    }
  }
  const alg = selectAlgorithm(options.pubKeyCredParams);
  if (alg === null) return { action: "reject", name: "NotSupportedError", message: MSG_ALG };

  const registration = await createRegistration({
    rpId,
    challenge: options.challenge,
    alg,
    credProps: options.extensions.credProps === true,
    ...caller(req.caller),
  });
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
    return { action: "error", rpId, message: `保存通行密钥失败：${describeError(err)}` };
  }
  return { action: "success", credential: registration.response, toast: "saved", userName: options.user.name };
}

// Converts page-supplied WebAuthn options (with BufferSources) into JSON-safe structures.

import { bufferSourceToBase64url } from "./base64url";
import type { CreationOptionsJSON, CredentialDescriptorJSON, RequestOptionsJSON } from "./protocol";

type Obj = Record<string, unknown>;

function asObject(value: unknown, what: string): Obj {
  if (!value || typeof value !== "object") throw new TypeError(`${what} is required`);
  return value as Obj;
}

function binary(value: unknown, what: string): string {
  try {
    return bufferSourceToBase64url(value);
  } catch {
    throw new TypeError(`${what} must be a BufferSource`);
  }
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function descriptors(list: unknown, what: string): CredentialDescriptorJSON[] {
  if (list === undefined || list === null) return [];
  if (typeof (list as Iterable<unknown>)[Symbol.iterator] !== "function") throw new TypeError(`${what} must be a sequence`);
  return Array.from(list as Iterable<unknown>, (item, i) => {
    const d = asObject(item, `${what}[${i}]`);
    const out: CredentialDescriptorJSON = { type: String(d["type"] ?? "public-key"), id: binary(d["id"], `${what}[${i}].id`) };
    if (d["transports"] && typeof (d["transports"] as Iterable<unknown>)[Symbol.iterator] === "function") {
      out.transports = Array.from(d["transports"] as Iterable<unknown>, String);
    }
    return out;
  });
}

export function serializeCreationOptions(publicKey: unknown): CreationOptionsJSON {
  const pk = asObject(publicKey, "publicKey");
  const rp = asObject(pk["rp"], "publicKey.rp");
  const user = asObject(pk["user"], "publicKey.user");
  const params = pk["pubKeyCredParams"];
  if (!params || typeof (params as Iterable<unknown>)[Symbol.iterator] !== "function") {
    throw new TypeError("publicKey.pubKeyCredParams must be a sequence");
  }
  const ext = pk["extensions"] && typeof pk["extensions"] === "object" ? (pk["extensions"] as Obj) : {};
  const out: CreationOptionsJSON = {
    rp: { name: String(rp["name"] ?? "") },
    user: {
      id: binary(user["id"], "publicKey.user.id"),
      name: String(user["name"] ?? ""),
      displayName: String(user["displayName"] ?? ""),
    },
    challenge: binary(pk["challenge"], "publicKey.challenge"),
    pubKeyCredParams: Array.from(params as Iterable<unknown>, (p, i) => {
      const o = asObject(p, `publicKey.pubKeyCredParams[${i}]`);
      return { type: String(o["type"] ?? "public-key"), alg: Number(o["alg"]) };
    }),
    excludeCredentials: descriptors(pk["excludeCredentials"], "publicKey.excludeCredentials"),
    extensions: ext["credProps"] === true ? { credProps: true } : {},
  };
  const rpId = optionalString(rp["id"]);
  if (rpId !== undefined) out.rp.id = rpId;
  if (typeof pk["timeout"] === "number") out.timeout = pk["timeout"];
  const attestation = optionalString(pk["attestation"]);
  if (attestation !== undefined) out.attestation = attestation;
  return out;
}

export function serializeRequestOptions(publicKey: unknown): RequestOptionsJSON {
  const pk = asObject(publicKey, "publicKey");
  const out: RequestOptionsJSON = {
    challenge: binary(pk["challenge"], "publicKey.challenge"),
    allowCredentials: descriptors(pk["allowCredentials"], "publicKey.allowCredentials"),
  };
  const rpId = optionalString(pk["rpId"]);
  if (rpId !== undefined) out.rpId = rpId;
  if (typeof pk["timeout"] === "number") out.timeout = pk["timeout"];
  const uv = optionalString(pk["userVerification"]);
  if (uv !== undefined) out.userVerification = uv;
  return out;
}

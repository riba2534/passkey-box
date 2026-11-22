// Shared fakes for unit tests.

import type { Credential, FetchLike } from "../src/lib/api";
import type { CredentialRealm } from "../src/lib/credential-object";

export const bytes = (...b: number[]) => new Uint8Array(b);
export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
/** Lets pending promise callbacks and zero-delay timers run. */
export const flush = () => new Promise((r) => setTimeout(r, 0));

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A credential as the server lists it, with `over` replacing fields. */
export function cred(over: Partial<Credential>): Credential {
  return {
    id: "id",
    rp_id: "example.com",
    rp_name: "",
    user_handle: "aA",
    user_name: "user",
    user_display_name: "",
    alg: -7,
    private_key: "",
    public_key: "",
    sign_count: 0,
    label: "",
    origin: "",
    created_at: "2026-11-20T03:30:00Z",
    last_used_at: null,
    use_count: 0,
    ...over,
  };
}

/** A FetchLike that records every call and answers with `handler`. */
export function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

export class FakePublicKeyCredential {}
export class FakeAttestationResponse {}
export class FakeAssertionResponse {}

export const fakeRealm: CredentialRealm = {
  PublicKeyCredential: FakePublicKeyCredential,
  AuthenticatorAttestationResponse: FakeAttestationResponse,
  AuthenticatorAssertionResponse: FakeAssertionResponse,
};

export const registrationJSON = {
  id: "AQID",
  rawId: "AQID",
  type: "public-key" as const,
  authenticatorAttachment: "platform" as const,
  response: {
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
    authenticatorData: "BAUG",
    transports: ["hybrid", "internal"],
    publicKey: "BwgJ",
    publicKeyAlgorithm: -7,
    attestationObject: "CgsM",
  },
  clientExtensionResults: { credProps: { rk: true } },
};

export const assertionJSON = {
  id: "AQID",
  rawId: "AQID",
  type: "public-key" as const,
  authenticatorAttachment: "platform" as const,
  response: {
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
    authenticatorData: "BAUG",
    signature: "DQ4P",
    userHandle: "dXNlcg",
  },
  clientExtensionResults: {},
};

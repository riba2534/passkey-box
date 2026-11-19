// Builds PublicKeyCredential-compatible objects (CONTRACT 4.5) from authenticator JSON.
// Prototypes come from the page realm so `instanceof PublicKeyCredential` holds there.

import { base64urlToBytes } from "./base64url";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "./authenticator";
import type { CredentialJSON } from "./protocol";

export interface CredentialRealm {
  PublicKeyCredential: { prototype: object };
  AuthenticatorAttestationResponse: { prototype: object };
  AuthenticatorAssertionResponse: { prototype: object };
}

function buffer(b64u: string): ArrayBuffer {
  return base64urlToBytes(b64u).buffer;
}

function define(target: object, props: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: false });
  }
}

function method<T>(name: string, fn: () => T): () => T {
  // Gives the function a stable name, like native methods.
  return { [name]: () => fn() }[name]!;
}

export function isRegistrationJSON(json: CredentialJSON): json is RegistrationResponseJSON {
  return "attestationObject" in json.response;
}

export function toPublicKeyCredential(json: CredentialJSON, realm: CredentialRealm): PublicKeyCredential {
  const snapshot = JSON.stringify(json);
  const copy = (): CredentialJSON => JSON.parse(snapshot) as CredentialJSON;

  let response: object;
  if (isRegistrationJSON(json)) {
    const r = json.response;
    response = Object.create(realm.AuthenticatorAttestationResponse.prototype) as object;
    define(response, {
      clientDataJSON: buffer(r.clientDataJSON),
      attestationObject: buffer(r.attestationObject),
      getTransports: method("getTransports", () => [...r.transports]),
      getAuthenticatorData: method("getAuthenticatorData", () => buffer(r.authenticatorData)),
      getPublicKey: method("getPublicKey", () => buffer(r.publicKey)),
      getPublicKeyAlgorithm: method("getPublicKeyAlgorithm", () => r.publicKeyAlgorithm),
    });
  } else {
    const r = (json as AuthenticationResponseJSON).response;
    response = Object.create(realm.AuthenticatorAssertionResponse.prototype) as object;
    define(response, {
      clientDataJSON: buffer(r.clientDataJSON),
      authenticatorData: buffer(r.authenticatorData),
      signature: buffer(r.signature),
      userHandle: r.userHandle ? buffer(r.userHandle) : null,
    });
  }

  const credential = Object.create(realm.PublicKeyCredential.prototype) as object;
  define(credential, {
    id: json.id,
    rawId: buffer(json.rawId),
    type: "public-key",
    authenticatorAttachment: json.authenticatorAttachment,
    response,
    getClientExtensionResults: method("getClientExtensionResults", () => copy().clientExtensionResults),
    toJSON: method("toJSON", copy),
  });
  return credential as PublicKeyCredential;
}

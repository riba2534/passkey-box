// Shared fakes for unit tests.

import type { CredentialRealm } from "../src/lib/credential-object";

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

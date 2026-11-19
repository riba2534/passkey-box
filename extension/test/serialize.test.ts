import { describe, expect, it } from "vitest";
import { toPublicKeyCredential } from "../src/lib/credential-object";
import { serializeCreationOptions, serializeRequestOptions } from "../src/lib/serialize";
import {
  assertionJSON,
  bytes,
  FakeAssertionResponse,
  FakeAttestationResponse,
  FakePublicKeyCredential,
  fakeRealm,
  registrationJSON,
} from "./fixtures";

describe("serializeCreationOptions", () => {
  it("converts BufferSources to base64url and keeps the relevant fields", () => {
    const backing = bytes(0, 9, 9, 9, 0);
    const out = serializeCreationOptions({
      rp: { id: "example.com", name: "Example" },
      user: { id: new DataView(backing.buffer, 1, 3), name: "alice", displayName: "Alice" },
      challenge: bytes(1, 2, 3).buffer,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      timeout: 60000,
      excludeCredentials: [{ type: "public-key", id: bytes(4, 5), transports: ["internal"] }],
      authenticatorSelection: { residentKey: "required" },
      attestation: "none",
      extensions: { credProps: true, prf: {} },
    });
    expect(out).toEqual({
      rp: { id: "example.com", name: "Example" },
      user: { id: "CQkJ", name: "alice", displayName: "Alice" },
      challenge: "AQID",
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      excludeCredentials: [{ type: "public-key", id: "BAU" }],
      extensions: { credProps: true },
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("fills defaults for optional fields", () => {
    const out = serializeCreationOptions({
      rp: { name: "X" },
      user: { id: bytes(1), name: "u", displayName: "" },
      challenge: bytes(2),
      pubKeyCredParams: [],
    });
    expect(out.rp).toEqual({ name: "X" });
    expect(out.excludeCredentials).toEqual([]);
    expect(out.extensions).toEqual({});
    expect(out.pubKeyCredParams).toEqual([]);
  });

  it("throws TypeError for missing or non-binary required fields", () => {
    const base = { rp: { name: "X" }, user: { id: bytes(1), name: "u", displayName: "u" }, challenge: bytes(1), pubKeyCredParams: [] };
    expect(() => serializeCreationOptions({ ...base, challenge: "abc" })).toThrow(TypeError);
    expect(() => serializeCreationOptions({ ...base, user: { ...base.user, id: "u1" } })).toThrow(TypeError);
    expect(() => serializeCreationOptions({ ...base, rp: undefined })).toThrow(TypeError);
    expect(() => serializeCreationOptions({ ...base, pubKeyCredParams: undefined })).toThrow(TypeError);
    expect(() => serializeCreationOptions(null)).toThrow(TypeError);
  });
});

describe("serializeRequestOptions", () => {
  it("converts challenge and allowCredentials and keeps only the relevant fields", () => {
    expect(
      serializeRequestOptions({
        challenge: bytes(1, 2, 3),
        rpId: "example.com",
        timeout: 1000,
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: bytes(255) }],
      }),
    ).toEqual({
      challenge: "AQID",
      rpId: "example.com",
      allowCredentials: [{ type: "public-key", id: "_w" }],
    });
    expect(serializeRequestOptions({ challenge: bytes(1) })).toEqual({ challenge: "AQ", allowCredentials: [] });
  });

  it("rejects bad input", () => {
    expect(() => serializeRequestOptions({})).toThrow(TypeError);
    expect(() => serializeRequestOptions({ challenge: bytes(1), allowCredentials: [{ id: "abc" }] })).toThrow(TypeError);
    expect(() => serializeRequestOptions({ challenge: bytes(1), allowCredentials: 5 })).toThrow(TypeError);
  });
});

describe("toPublicKeyCredential", () => {
  it("builds a registration credential with page-realm prototypes", () => {
    const cred = toPublicKeyCredential(registrationJSON, fakeRealm) as unknown as Record<string, any>;
    expect(cred).toBeInstanceOf(FakePublicKeyCredential);
    expect(cred.response).toBeInstanceOf(FakeAttestationResponse);
    expect(cred.id).toBe("AQID");
    expect(cred.type).toBe("public-key");
    expect(cred.authenticatorAttachment).toBe("platform");
    expect([...new Uint8Array(cred.rawId)]).toEqual([1, 2, 3]);
    expect(cred.rawId).toBe(cred.rawId);
    expect(cred.rawId).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(cred.response.attestationObject)]).toEqual([10, 11, 12]);
    expect(cred.response.getTransports()).toEqual(["hybrid", "internal"]);
    expect([...new Uint8Array(cred.response.getAuthenticatorData())]).toEqual([4, 5, 6]);
    expect([...new Uint8Array(cred.response.getPublicKey())]).toEqual([7, 8, 9]);
    expect(cred.response.getPublicKeyAlgorithm()).toBe(-7);
    expect(cred.getClientExtensionResults()).toEqual({ credProps: { rk: true } });
    expect(cred.toJSON()).toEqual(registrationJSON);
    expect(JSON.parse(JSON.stringify(cred))).toEqual(registrationJSON);
  });

  it("toJSON and extension results return fresh copies", () => {
    const cred = toPublicKeyCredential(registrationJSON, fakeRealm) as unknown as Record<string, any>;
    const first = cred.toJSON();
    first.response.transports.push("usb");
    cred.getClientExtensionResults().credProps.rk = false;
    expect(cred.toJSON()).toEqual(registrationJSON);
    expect(cred.getClientExtensionResults()).toEqual({ credProps: { rk: true } });
    expect(cred.toJSON.name).toBe("toJSON");
  });

  it("builds an assertion credential", () => {
    const cred = toPublicKeyCredential(assertionJSON, fakeRealm) as unknown as Record<string, any>;
    expect(cred).toBeInstanceOf(FakePublicKeyCredential);
    expect(cred.response).toBeInstanceOf(FakeAssertionResponse);
    expect([...new Uint8Array(cred.response.signature)]).toEqual([13, 14, 15]);
    expect(new TextDecoder().decode(cred.response.userHandle)).toBe("user");
    expect(cred.toJSON()).toEqual(assertionJSON);
  });

  it("userHandle is null when absent", () => {
    const { userHandle: _omit, ...response } = assertionJSON.response;
    const cred = toPublicKeyCredential({ ...assertionJSON, response }, fakeRealm) as unknown as Record<string, any>;
    expect(cred.response.userHandle).toBeNull();
  });
});

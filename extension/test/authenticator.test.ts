import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { decodeAttestationObject, isoCBOR, parseAuthenticatorData } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vitest";
import {
  AAGUID,
  ALG_ES256,
  ALG_RS256,
  aaguidBytes,
  attestationObjectNone,
  attestedCredentialData,
  authenticatorData,
  clientDataJSON,
  coseEc2PublicKey,
  coseRsaPublicKey,
  createAssertion,
  createRegistration,
  ecdsaRawToDer,
  generateKey,
  sha256,
  signWithPkcs8,
  type CoseAlgorithm,
} from "../src/lib/authenticator";
import { base64urlToBytes, bytesToBase64url, utf8 } from "../src/lib/base64url";
import { hex } from "./fixtures";

const fromHex = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, "hex"));

describe("constants", () => {
  it("AAGUID bytes", () => {
    expect(hex(aaguidBytes())).toBe(AAGUID.replace(/-/g, ""));
    expect(() => aaguidBytes("nope")).toThrow(TypeError);
  });
});

describe("ecdsaRawToDer", () => {
  it("encodes small positive integers", () => {
    const raw = new Uint8Array(64);
    raw[31] = 0x01;
    raw[63] = 0x02;
    expect(hex(ecdsaRawToDer(raw))).toBe("3006020101020102");
  });

  it("prefixes 0x00 when the high bit is set and strips leading zeros", () => {
    const r = fromHex("80" + "11".repeat(31));
    const s = fromHex("0000" + "7f" + "22".repeat(29));
    const der = ecdsaRawToDer(new Uint8Array([...r, ...s]));
    expect(hex(der)).toBe("3043" + "0221" + "00" + hex(r) + "021e" + "7f" + "22".repeat(29));
  });

  it("encodes a zero integer as a single 0x00 byte", () => {
    const raw = new Uint8Array(64);
    raw[63] = 5;
    expect(hex(ecdsaRawToDer(raw))).toBe("3006020100020105");
  });

  it("uses long-form lengths for large integers", () => {
    const raw = new Uint8Array(400).fill(0x11);
    const der = ecdsaRawToDer(raw);
    expect(hex(der.subarray(0, 4))).toBe("30820196");
    expect(hex(der.subarray(4, 7))).toBe("0281c8");
  });

  it("rejects odd-length input", () => {
    expect(() => ecdsaRawToDer(new Uint8Array(63))).toThrow(TypeError);
  });

  it("ES256 signatures are DER and verify with a DER-only verifier", async () => {
    const key = await generateKey(ALG_ES256);
    const data = utf8("hello passkey");
    for (let i = 0; i < 8; i++) {
      const sig = await signWithPkcs8(ALG_ES256, key.privateKeyPkcs8, data);
      expect(sig[0]).toBe(0x30);
      expect(sig[1]).toBe(sig.length - 2);
      const pub = createPublicKey({ key: Buffer.from(key.publicKeySpki), format: "der", type: "spki" });
      expect(nodeVerify("sha256", data, { key: pub, dsaEncoding: "der" }, sig)).toBe(true);
    }
  });
});

describe("COSE keys", () => {
  it("EC2 key uses canonical order 1, 3, -1, -2, -3", () => {
    const x = new Uint8Array(32).fill(0xaa);
    const y = new Uint8Array(32).fill(0xbb);
    expect(hex(coseEc2PublicKey(x, y))).toBe("a5" + "0102" + "0326" + "2001" + "215820" + "aa".repeat(32) + "225820" + "bb".repeat(32));
  });

  it("RSA key uses canonical order 1, 3, -1, -2", () => {
    const n = new Uint8Array(256).fill(0xcc);
    const e = new Uint8Array([1, 0, 1]);
    expect(hex(coseRsaPublicKey(n, e))).toBe("a4" + "0103" + "03390100" + "20590100" + "cc".repeat(256) + "2143010001");
  });

  it("generated keys embed the exported public key", async () => {
    const es = await generateKey(ALG_ES256);
    const decoded = isoCBOR.decodeFirst<Map<number, unknown>>(es.cosePublicKey);
    expect(decoded.get(1)).toBe(2);
    expect(decoded.get(3)).toBe(-7);
    expect((decoded.get(-2) as Uint8Array).length).toBe(32);
    const rs = await generateKey(ALG_RS256);
    const rsDecoded = isoCBOR.decodeFirst<Map<number, unknown>>(rs.cosePublicKey);
    expect(rsDecoded.get(3)).toBe(-257);
    expect((rsDecoded.get(-1) as Uint8Array).length).toBe(256);
  });
});

describe("authenticatorData / attestationObject", () => {
  it("lays out rpIdHash, flags, counter and attested data", async () => {
    const rpIdHash = await sha256(utf8("example.com"));
    const credId = new Uint8Array(32).fill(7);
    const cose = coseEc2PublicKey(new Uint8Array(32), new Uint8Array(32));
    const ad = authenticatorData(rpIdHash, 0x5d, 0, attestedCredentialData(aaguidBytes(), credId, cose));
    const parsed = parseAuthenticatorData(ad);
    expect(hex(parsed.rpIdHash)).toBe(hex(rpIdHash));
    expect(parsed.flags).toMatchObject({ up: true, uv: true, be: true, bs: true, at: true, ed: false });
    expect(parsed.counter).toBe(0);
    expect(hex(parsed.aaguid!)).toBe(hex(aaguidBytes()));
    expect(hex(parsed.credentialID!)).toBe(hex(credId));
    expect(hex(parsed.credentialPublicKey!)).toBe(hex(cose));
  });

  it("assertion authData is exactly 37 bytes", async () => {
    const ad = authenticatorData(await sha256(utf8("a")), 0x1d, 0);
    expect(ad.length).toBe(37);
    expect(ad[32]).toBe(0x1d);
    expect(() => authenticatorData(new Uint8Array(31), 0, 0)).toThrow(TypeError);
  });

  it("attestationObject is fmt none with empty attStmt", () => {
    const ad = new Uint8Array([1, 2, 3]);
    const decoded = decodeAttestationObject(attestationObjectNone(ad));
    expect(decoded.get("fmt")).toBe("none");
    expect(decoded.get("attStmt").size).toBe(0);
    expect([...decoded.get("authData")]).toEqual([1, 2, 3]);
  });
});

describe("clientDataJSON", () => {
  it("keeps key order type, challenge, origin, crossOrigin", () => {
    const json = clientDataJSON({ type: "webauthn.get", challenge: "abc", origin: "https://a.test", crossOrigin: false });
    expect(json).toBe('{"type":"webauthn.get","challenge":"abc","origin":"https://a.test","crossOrigin":false}');
  });

  it("adds topOrigin only for cross-origin calls", () => {
    expect(
      clientDataJSON({ type: "webauthn.create", challenge: "c", origin: "https://f.test", crossOrigin: true, topOrigin: "https://top.test" }),
    ).toBe('{"type":"webauthn.create","challenge":"c","origin":"https://f.test","crossOrigin":true,"topOrigin":"https://top.test"}');
    expect(
      clientDataJSON({ type: "webauthn.create", challenge: "c", origin: "https://f.test", crossOrigin: false, topOrigin: "https://top.test" }),
    ).not.toContain("topOrigin");
  });
});

describe.each<[string, CoseAlgorithm]>([
  ["ES256", ALG_ES256],
  ["RS256", ALG_RS256],
])("%s ceremonies verify with @simplewebauthn/server", (_name, alg) => {
  const rpId = "localhost";
  const origin = "http://localhost:18411";

  async function register(challenge: string, extra: { credProps?: boolean } = {}) {
    const reg = await createRegistration({ rpId, challenge, origin, crossOrigin: false, alg, ...extra });
    const verification = await verifyRegistrationResponse({
      response: reg.response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
    return { reg, verification };
  }

  it("registration response verifies", async () => {
    const challenge = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
    const { reg, verification } = await register(challenge, { credProps: true });
    expect(verification.verified).toBe(true);
    const info = verification.registrationInfo!;
    expect(info.fmt).toBe("none");
    expect(info.aaguid).toBe(AAGUID);
    expect(info.credential.id).toBe(reg.credentialId);
    expect(info.credential.counter).toBe(0);
    expect(info.credentialDeviceType).toBe("multiDevice");
    expect(info.credentialBackedUp).toBe(true);
    expect(info.userVerified).toBe(true);
    expect(base64urlToBytes(reg.credentialId).length).toBe(32);
    expect(reg.response).toMatchObject({
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: { credProps: { rk: true } },
      response: { transports: ["hybrid", "internal"], publicKeyAlgorithm: alg, publicKey: reg.publicKey },
    });
  });

  it("authentication response verifies against the registered public key", async () => {
    const { reg, verification } = await register(bytesToBase64url(utf8("register")));
    const challenge = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
    const userHandle = bytesToBase64url(utf8("user-1"));
    const assertion = await createAssertion({
      rpId,
      challenge,
      origin,
      crossOrigin: false,
      credentialId: reg.credentialId,
      alg,
      privateKey: reg.privateKey,
      userHandle,
    });
    expect(assertion.response.userHandle).toBe(userHandle);
    const result = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: verification.registrationInfo!.credential,
      requireUserVerification: true,
    });
    expect(result.verified).toBe(true);
    expect(result.authenticationInfo.newCounter).toBe(0);
  });

  it("cross-origin iframe assertions carry topOrigin", async () => {
    const { reg, verification } = await register("Y2g");
    const assertion = await createAssertion({
      rpId,
      challenge: "Y2hhbGxlbmdl",
      origin,
      crossOrigin: true,
      topOrigin: "https://top.example",
      credentialId: reg.credentialId,
      alg,
      privateKey: reg.privateKey,
    });
    const cdj = JSON.parse(new TextDecoder().decode(base64urlToBytes(assertion.response.clientDataJSON)));
    expect(cdj).toEqual({ type: "webauthn.get", challenge: "Y2hhbGxlbmdl", origin, crossOrigin: true, topOrigin: "https://top.example" });
    expect(assertion.response.userHandle).toBeUndefined();
    const result = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: "Y2hhbGxlbmdl",
      expectedOrigin: origin,
      expectedRPID: rpId,
      expectedTopOrigin: "https://top.example",
      credential: verification.registrationInfo!.credential,
    });
    expect(result.verified).toBe(true);
  });

  it("a tampered signature fails verification", async () => {
    const { reg, verification } = await register("dGFtcGVy");
    const assertion = await createAssertion({
      rpId,
      challenge: "dGFtcGVy",
      origin,
      crossOrigin: false,
      credentialId: reg.credentialId,
      alg,
      privateKey: reg.privateKey,
    });
    const sig = base64urlToBytes(assertion.response.signature);
    sig[sig.length - 1]! ^= 0x01;
    assertion.response.signature = bytesToBase64url(sig);
    const result = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: "dGFtcGVy",
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: verification.registrationInfo!.credential,
    }).catch(() => ({ verified: false }));
    expect(result.verified).toBe(false);
  });
});

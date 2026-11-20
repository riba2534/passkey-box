// Software WebAuthn authenticator: key generation, COSE keys, authenticatorData,
// attestationObject ("none"), clientDataJSON and assertion signatures.

import { base64urlToBytes, bytesToBase64url, concatBytes, utf8, type Bytes } from "./base64url";
import { encodeCbor, type CborMap } from "./cbor";

export const ALG_ES256 = -7;
export const ALG_RS256 = -257;
export type CoseAlgorithm = typeof ALG_ES256 | typeof ALG_RS256;

export const AAGUID = "b1d8a1c4-5f3e-4a6b-9c2d-7e8f9a0b1c2d";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const SYNCED_CREDENTIAL_FLAGS = FLAG_BE | FLAG_BS;

function verifiedFlags(userVerified: true): number {
  if (userVerified !== true) throw new TypeError("user verification required");
  return FLAG_UP | FLAG_UV | SYNCED_CREDENTIAL_FLAGS;
}

const TRANSPORTS = ["hybrid", "internal"];
const CREDENTIAL_ID_LENGTH = 32;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export function aaguidBytes(uuid: string = AAGUID): Bytes {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new TypeError("invalid AAGUID");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomCredentialId(): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(CREDENTIAL_ID_LENGTH));
}

export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Bytes> {
  return new Uint8Array(await subtle().digest("SHA-256", data));
}

// ---------------------------------------------------------------- COSE keys

/** COSE_Key for an EC2 P-256 public key; keys emitted in CTAP2 canonical order (1, 3, -1, -2, -3). */
export function coseEc2PublicKey(x: Uint8Array, y: Uint8Array): Bytes {
  const key: CborMap = new Map<number, Uint8Array | number>([
    [1, 2], // kty: EC2
    [3, ALG_ES256],
    [-1, 1], // crv: P-256
    [-2, x],
    [-3, y],
  ]);
  return encodeCbor(key);
}

/** COSE_Key for an RSA public key; keys emitted in CTAP2 canonical order (1, 3, -1, -2). */
export function coseRsaPublicKey(n: Uint8Array, e: Uint8Array): Bytes {
  const key: CborMap = new Map<number, Uint8Array | number>([
    [1, 3], // kty: RSA
    [3, ALG_RS256],
    [-1, n],
    [-2, e],
  ]);
  return encodeCbor(key);
}

// ---------------------------------------------------------------- authenticatorData

function encodeUint32(n: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
}

export function attestedCredentialData(aaguid: Uint8Array, credentialId: Uint8Array, coseKey: Uint8Array): Bytes {
  const len = new Uint8Array([(credentialId.length >> 8) & 0xff, credentialId.length & 0xff]);
  return concatBytes(aaguid, len, credentialId, coseKey);
}

export function authenticatorData(
  rpIdHash: Uint8Array,
  flags: number,
  signCount: number,
  attestedData?: Uint8Array,
): Bytes {
  if (rpIdHash.length !== 32) throw new TypeError("rpIdHash must be 32 bytes");
  return concatBytes(rpIdHash, new Uint8Array([flags]), encodeUint32(signCount), attestedData ?? new Uint8Array());
}

export function attestationObjectNone(authData: Uint8Array): Bytes {
  return encodeCbor({ fmt: "none", attStmt: {}, authData });
}

// ---------------------------------------------------------------- clientDataJSON

export interface ClientDataInput {
  type: "webauthn.create" | "webauthn.get";
  /** base64url challenge */
  challenge: string;
  origin: string;
  crossOrigin: boolean;
  topOrigin?: string;
}

/** Key order: type, challenge, origin, crossOrigin, then topOrigin for cross-origin iframes. */
export function clientDataJSON(input: ClientDataInput): string {
  const data: Record<string, string | boolean> = {
    type: input.type,
    challenge: input.challenge,
    origin: input.origin,
    crossOrigin: input.crossOrigin,
  };
  if (input.crossOrigin && input.topOrigin) data["topOrigin"] = input.topOrigin;
  return JSON.stringify(data);
}

// ---------------------------------------------------------------- signatures

function derLength(len: number): Bytes {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derInteger(unsigned: Uint8Array): Bytes {
  let start = 0;
  while (start < unsigned.length - 1 && unsigned[start] === 0) start++;
  let body: Uint8Array = unsigned.subarray(start);
  if (body.length === 0) body = new Uint8Array([0]);
  if (body[0]! & 0x80) body = concatBytes(new Uint8Array([0]), body);
  return concatBytes(new Uint8Array([0x02]), derLength(body.length), body);
}

/** Converts a WebCrypto ECDSA signature (r || s, fixed width) into an ASN.1 DER Ecdsa-Sig-Value. */
export function ecdsaRawToDer(raw: Uint8Array): Bytes {
  if (raw.length === 0 || raw.length % 2 !== 0) throw new TypeError("raw ECDSA signature must be r||s");
  const half = raw.length / 2;
  const seq = concatBytes(derInteger(raw.subarray(0, half)), derInteger(raw.subarray(half)));
  return concatBytes(new Uint8Array([0x30]), derLength(seq.length), seq);
}

function importParams(alg: CoseAlgorithm): EcKeyImportParams | RsaHashedImportParams {
  if (alg === ALG_ES256) return { name: "ECDSA", namedCurve: "P-256" };
  if (alg === ALG_RS256) return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  throw new TypeError(`unsupported algorithm ${String(alg)}`);
}

/** Signs `data` with a PKCS#8 private key; ES256 output is DER, RS256 is PKCS#1 v1.5. */
export async function signWithPkcs8(alg: CoseAlgorithm, pkcs8: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Bytes> {
  const key = await subtle().importKey("pkcs8", pkcs8, importParams(alg), false, ["sign"]);
  if (alg === ALG_ES256) {
    const raw = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
    return ecdsaRawToDer(raw);
  }
  return new Uint8Array(await subtle().sign({ name: "RSASSA-PKCS1-v1_5" }, key, data));
}

export interface GeneratedKey {
  alg: CoseAlgorithm;
  privateKeyPkcs8: Bytes;
  publicKeySpki: Bytes;
  cosePublicKey: Bytes;
}

export async function generateKey(alg: CoseAlgorithm): Promise<GeneratedKey> {
  let pair: CryptoKeyPair;
  if (alg === ALG_ES256) {
    pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  } else if (alg === ALG_RS256) {
    pair = await subtle().generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
  } else {
    throw new TypeError(`unsupported algorithm ${String(alg)}`);
  }
  const privateKeyPkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
  const publicKeySpki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
  const jwk = await subtle().exportKey("jwk", pair.publicKey);
  const cosePublicKey =
    alg === ALG_ES256
      ? coseEc2PublicKey(base64urlToBytes(jwk.x!), base64urlToBytes(jwk.y!))
      : coseRsaPublicKey(base64urlToBytes(jwk.n!), base64urlToBytes(jwk.e!));
  return { alg, privateKeyPkcs8, publicKeySpki, cosePublicKey };
}

// ---------------------------------------------------------------- ceremonies

export interface RegistrationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment: "platform";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    transports: string[];
    publicKey: string;
    publicKeyAlgorithm: number;
    attestationObject: string;
  };
  clientExtensionResults: Record<string, unknown>;
}

export interface AuthenticationResponseJSON {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment: "platform";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: Record<string, unknown>;
}

export interface CallerContext {
  origin: string;
  crossOrigin: boolean;
  topOrigin?: string;
}

export interface RegistrationInput extends CallerContext {
  userVerified: true;
  rpId: string;
  /** base64url */
  challenge: string;
  alg: CoseAlgorithm;
  credProps?: boolean;
  /** Fixed credential ID for tests; random 32 bytes otherwise. */
  credentialId?: Uint8Array<ArrayBuffer>;
}

export interface Registration {
  response: RegistrationResponseJSON;
  credentialId: string;
  privateKey: string;
  publicKey: string;
}

export async function createRegistration(input: RegistrationInput): Promise<Registration> {
  const key = await generateKey(input.alg);
  const credentialId = input.credentialId ?? randomCredentialId();
  const rpIdHash = await sha256(utf8(input.rpId));
  const authData = authenticatorData(
    rpIdHash,
    verifiedFlags(input.userVerified) | FLAG_AT,
    0,
    attestedCredentialData(aaguidBytes(), credentialId, key.cosePublicKey),
  );
  const cdj = clientDataJSON({ ...input, type: "webauthn.create" });
  const id = bytesToBase64url(credentialId);
  return {
    credentialId: id,
    privateKey: bytesToBase64url(key.privateKeyPkcs8),
    publicKey: bytesToBase64url(key.publicKeySpki),
    response: {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: bytesToBase64url(utf8(cdj)),
        authenticatorData: bytesToBase64url(authData),
        transports: [...TRANSPORTS],
        publicKey: bytesToBase64url(key.publicKeySpki),
        publicKeyAlgorithm: input.alg,
        attestationObject: bytesToBase64url(attestationObjectNone(authData)),
      },
      clientExtensionResults: input.credProps ? { credProps: { rk: true } } : {},
    },
  };
}

export interface AssertionInput extends CallerContext {
  userVerified: true;
  rpId: string;
  /** base64url */
  challenge: string;
  credentialId: string;
  alg: CoseAlgorithm;
  /** base64url PKCS#8 */
  privateKey: string;
  /** base64url; omitted from the response when empty */
  userHandle?: string;
}

export async function createAssertion(input: AssertionInput): Promise<AuthenticationResponseJSON> {
  const rpIdHash = await sha256(utf8(input.rpId));
  const authData = authenticatorData(rpIdHash, verifiedFlags(input.userVerified), 0);
  const cdjBytes = utf8(clientDataJSON({ ...input, type: "webauthn.get" }));
  const signature = await signWithPkcs8(
    input.alg,
    base64urlToBytes(input.privateKey),
    concatBytes(authData, await sha256(cdjBytes)),
  );
  const response: AuthenticationResponseJSON["response"] = {
    clientDataJSON: bytesToBase64url(cdjBytes),
    authenticatorData: bytesToBase64url(authData),
    signature: bytesToBase64url(signature),
  };
  if (input.userHandle) response.userHandle = input.userHandle;
  return {
    id: input.credentialId,
    rawId: input.credentialId,
    type: "public-key",
    authenticatorAttachment: "platform",
    response,
    clientExtensionResults: {},
  };
}

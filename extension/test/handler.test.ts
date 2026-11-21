import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Credential, type NewCredential } from "../src/lib/api";
import { bytesToBase64url, utf8 } from "../src/lib/base64url";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "../src/lib/authenticator";
import type { Config, Settings } from "../src/lib/config";
import { handleRequest, type CredentialStore, type OwnedStore } from "../src/lib/handler";
import { rememberCredential } from "../src/lib/owned";
import type { BackgroundRequest, CallerInfo, CreationOptionsJSON, RequestOptionsJSON } from "../src/lib/protocol";

const config: Config = { serverUrl: "http://127.0.0.1:1", username: "alice", password: "pw" };
const caller: CallerInfo = { origin: "https://login.example.com", hostname: "login.example.com", crossOrigin: false };

class MemoryStore implements CredentialStore {
  credentials: Credential[] = [];
  listCalls: Array<string | undefined> = [];
  used: string[] = [];
  failList = false;
  failCreate = false;

  async listCredentials(rpId?: string) {
    this.listCalls.push(rpId);
    if (this.failList) throw new ApiError("connect ECONNREFUSED", 0, "network");
    return this.credentials.filter((c) => rpId === undefined || c.rp_id.toLowerCase() === rpId.toLowerCase());
  }
  async createCredential(c: NewCredential) {
    if (this.failCreate) throw new ApiError("credential exists", 409, "conflict");
    const stored: Credential = { ...c, sign_count: 0, created_at: "2026-11-20T00:00:00Z", last_used_at: null, use_count: 0 };
    this.credentials.unshift(stored);
    return stored;
  }
  async useCredential(id: string) {
    this.used.push(id);
  }
}

/** One browser profile's record of the credentials it registered or used. */
class MemoryProfile implements OwnedStore {
  owned = new Map<string, number>();
  clock = 0;
  failLoad = false;
  failRemember = false;
  /** Writes never finish, like a stalled chrome.storage. */
  stall = false;
  writes: Array<Promise<void>> = [];

  async load() {
    if (this.failLoad) throw new Error("storage unavailable");
    return this.owned;
  }
  remember(id: string) {
    if (this.stall) return new Promise<void>(() => undefined);
    const write = this.write(id);
    this.writes.push(write);
    return write;
  }
  private async write(id: string) {
    // Like chrome.storage, the write lands after the handler has moved on.
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (this.failRemember) throw new Error("quota exceeded");
    this.owned = rememberCredential(this.owned, id, ++this.clock);
  }
  /** Waits for the writes the handler started without waiting for them. */
  async settled() {
    await Promise.allSettled(this.writes);
  }
}

// Without a profile, every call runs in a fresh one that has registered and used nothing.
function deps(store: MemoryStore, opts: { config?: Config | null; settings?: Partial<Settings>; profile?: MemoryProfile } = {}) {
  return {
    loadConfig: async () => (opts.config === undefined ? config : opts.config),
    loadSettings: async () => ({ autoLoginSingle: true, conditionalAutoLogin: true, ...opts.settings }),
    store: vi.fn(() => store),
    owned: opts.profile ?? new MemoryProfile(),
  };
}

const createOptions = (over: Partial<CreationOptionsJSON> = {}): CreationOptionsJSON => ({
  rp: { id: "example.com", name: "Example" },
  user: { id: "dXNlci0x", name: "alice@example.com", displayName: "Alice" },
  challenge: "Y3JlYXRl",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  excludeCredentials: [],
  extensions: {},
  ...over,
});

const getOptions = (over: Partial<RequestOptionsJSON> = {}): RequestOptionsJSON => ({
  challenge: "Z2V0",
  rpId: "example.com",
  allowCredentials: [],
  ...over,
});

const createReq = (options = createOptions(), c = caller): BackgroundRequest => ({ type: "pkb:create", caller: c, options });
const getReq = (options = getOptions(), extra: { mediation?: string; credentialId?: string } = {}): BackgroundRequest => ({
  type: "pkb:get",
  caller,
  options,
  ...extra,
});

async function register(store: MemoryStore, name: string, alg = -7, profile?: MemoryProfile) {
  const res = await handleRequest(
    createReq(createOptions({ user: { id: bytesToBase64url(utf8(name)), name, displayName: name.toUpperCase() }, pubKeyCredParams: [{ type: "public-key", alg }] })),
    deps(store, { profile }),
  );
  if (res.action !== "success") throw new Error(`register failed: ${JSON.stringify(res)}`);
  await profile?.settled();
  return res.credential as RegistrationResponseJSON;
}

describe("handleRequest: unconfigured", () => {
  it("falls back for both operations", async () => {
    const store = new MemoryStore();
    expect(await handleRequest(createReq(), deps(store, { config: null }))).toEqual({ action: "fallback" });
    expect(await handleRequest(getReq(), deps(store, { config: null }))).toEqual({ action: "fallback" });
    expect(store.listCalls).toEqual([]);
  });
});

describe("handleRequest: callers the extension does not handle", () => {
  it.each([
    ["sandboxed frame (opaque origin, location.hostname still set)", { origin: "null", hostname: "login.example.com", crossOrigin: false }],
    ["opaque origin with empty hostname", { origin: "null", hostname: "", crossOrigin: false }],
    ["non-http(s) origin", { origin: "chrome-extension://abcdef", hostname: "abcdef", crossOrigin: false }],
  ])("%s → fallback without UI or server calls", async (_name, c: CallerInfo) => {
    const store = new MemoryStore();
    await register(store, "opaque");
    store.listCalls = [];
    const get: BackgroundRequest = { type: "pkb:get", caller: c, options: getOptions({ rpId: undefined }) };
    expect(await handleRequest(get, deps(store))).toEqual({ action: "fallback" });
    expect(await handleRequest({ ...get, options: getOptions() }, deps(store))).toEqual({ action: "fallback" });
    expect(await handleRequest(createReq(createOptions(), c), deps(store))).toEqual({ action: "fallback" });
    expect(store.listCalls).toEqual([]);
    expect(store.credentials).toHaveLength(1);
  });
});

describe("handleRequest: create", () => {
  it("generates an ES256 key, uploads it and returns a verifiable response", async () => {
    const store = new MemoryStore();
    const res = await handleRequest(createReq(createOptions({ extensions: { credProps: true } })), deps(store));
    expect(res).toMatchObject({ action: "success", toast: "saved", userName: "alice@example.com" });
    const credential = (res as { credential: RegistrationResponseJSON }).credential;
    expect(credential.clientExtensionResults).toEqual({ credProps: { rk: true } });
    expect(store.listCalls).toEqual([]); // no excludeCredentials → no lookup
    expect(store.credentials[0]).toMatchObject({
      id: credential.id,
      rp_id: "example.com",
      rp_name: "Example",
      user_handle: "dXNlci0x",
      user_name: "alice@example.com",
      user_display_name: "Alice",
      alg: -7,
      public_key: credential.response.publicKey,
      origin: "https://login.example.com",
      label: "",
    });
    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: "Y3JlYXRl",
      expectedOrigin: "https://login.example.com",
      expectedRPID: "example.com",
    });
    expect(verification.verified).toBe(true);
  });

  it("picks RS256 when ES256 is not offered", async () => {
    const store = new MemoryStore();
    const res = await handleRequest(createReq(createOptions({ pubKeyCredParams: [{ type: "public-key", alg: -257 }] })), deps(store));
    expect(res.action).toBe("success");
    expect(store.credentials[0]!.alg).toBe(-257);
  });

  it("rejects unsupported algorithms with NotSupportedError", async () => {
    const store = new MemoryStore();
    const res = await handleRequest(createReq(createOptions({ pubKeyCredParams: [{ type: "public-key", alg: -8 }] })), deps(store));
    expect(res).toMatchObject({ action: "reject", name: "NotSupportedError" });
    expect(store.credentials).toEqual([]);
  });

  it("rejects InvalidStateError with the exists toast when excludeCredentials matches", async () => {
    const store = new MemoryStore();
    const first = await register(store, "bob");
    const res = await handleRequest(
      createReq(createOptions({ excludeCredentials: [{ type: "public-key", id: "other" }, { type: "public-key", id: first.id }] })),
      deps(store),
    );
    expect(res).toMatchObject({ action: "reject", name: "InvalidStateError", toast: "exists" });
    expect(store.listCalls).toEqual(["example.com"]);
    expect(store.credentials).toHaveLength(1);
  });

  it("proceeds when excluded IDs are unknown", async () => {
    const store = new MemoryStore();
    const res = await handleRequest(createReq(createOptions({ excludeCredentials: [{ type: "public-key", id: "nope" }] })), deps(store));
    expect(res.action).toBe("success");
  });

  it("uses the page hostname when rp.id is absent and enforces rpId scope", async () => {
    const store = new MemoryStore();
    const { id: _drop, ...rpNoId } = createOptions().rp;
    const res = await handleRequest(createReq(createOptions({ rp: rpNoId })), deps(store));
    expect(res.action).toBe("success");
    expect(store.credentials[0]!.rp_id).toBe("login.example.com");

    const bad = await handleRequest(createReq(createOptions({ rp: { id: "evil.com", name: "" } })), deps(store));
    expect(bad).toMatchObject({ action: "reject", name: "SecurityError" });
  });

  it("shows an error dialog when the server fails", async () => {
    const store = new MemoryStore();
    store.failCreate = true;
    expect(await handleRequest(createReq(), deps(store))).toMatchObject({
      action: "error",
      message: expect.stringContaining("保存通行密钥失败"),
    });
    const store2 = new MemoryStore();
    store2.failList = true;
    expect(
      await handleRequest(createReq(createOptions({ excludeCredentials: [{ type: "public-key", id: "x" }] })), deps(store2)),
    ).toMatchObject({ action: "error", message: expect.stringContaining("无法连接服务器") });
  });
});

describe("handleRequest: aborted by the page", () => {
  it("does not create a credential when the site already aborted", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    controller.abort();
    const result = await handleRequest(createReq(), { ...deps(store), signal: controller.signal });
    expect(result).toMatchObject({ action: "reject", name: "NotAllowedError" });
    expect(store.credentials).toHaveLength(0);
  });

  it("does not sign or record use when the site already aborted", async () => {
    const store = new MemoryStore();
    await register(store, "already-registered");
    const controller = new AbortController();
    controller.abort();
    const result = await handleRequest(getReq(), { ...deps(store), signal: controller.signal });
    expect(result).toMatchObject({ action: "reject", name: "NotAllowedError" });
    expect(store.used).toHaveLength(0);
  });

  it("suppresses the response if the site aborted during the write", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    const write = store.createCredential.bind(store);
    store.createCredential = async (credential) => {
      const saved = await write(credential);
      controller.abort();
      return saved;
    };
    const result = await handleRequest(createReq(), { ...deps(store), signal: controller.signal });
    expect(result).toMatchObject({ action: "reject", name: "NotAllowedError" });
  });
});

describe("handleRequest: get", () => {
  it("0 candidates → empty dialog", async () => {
    const store = new MemoryStore();
    expect(await handleRequest(getReq(), deps(store))).toEqual({ action: "empty" });
    expect(store.listCalls).toEqual(["example.com"]);
  });

  it("1 candidate → signs, records use, and verifies", async () => {
    const store = new MemoryStore();
    const reg = await register(store, "carol");
    const registration = await verifyRegistrationResponse({
      response: reg,
      expectedChallenge: "Y3JlYXRl",
      expectedOrigin: caller.origin,
      expectedRPID: "example.com",
    });
    const res = await handleRequest(getReq(), deps(store));
    expect(res).toMatchObject({ action: "success", toast: "signed-in", userName: "carol" });
    const assertion = (res as { credential: AuthenticationResponseJSON }).credential;
    expect(assertion.id).toBe(reg.id);
    expect(assertion.response.userHandle).toBe(store.credentials[0]!.user_handle);
    await vi.waitFor(() => expect(store.used).toEqual([reg.id]));
    const result = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: "Z2V0",
      expectedOrigin: caller.origin,
      expectedRPID: "example.com",
      credential: registration.registrationInfo!.credential,
    });
    expect(result.verified).toBe(true);
  });

  it("1 candidate with autoLoginSingle off → picker", async () => {
    const store = new MemoryStore();
    await register(store, "dave");
    const res = await handleRequest(getReq(), deps(store, { settings: { autoLoginSingle: false } }));
    expect(res.action).toBe("picker");
  });

  it("several candidates → picker without private keys; selection signs the chosen one", async () => {
    const store = new MemoryStore();
    const a = await register(store, "erin");
    const b = await register(store, "frank", -257);
    const res = await handleRequest(getReq(), deps(store));
    expect(res.action).toBe("picker");
    const candidates = (res as unknown as { candidates: Array<Record<string, unknown>> }).candidates;
    expect(candidates.map((c) => c["id"]).sort()).toEqual([a.id, b.id].sort());
    expect(candidates[0]).toEqual({
      id: expect.any(String),
      user_name: expect.any(String),
      user_display_name: expect.any(String),
      rp_id: "example.com",
      owned: false,
    });
    expect(JSON.stringify(res)).not.toContain("private_key");

    const picked = await handleRequest(getReq(getOptions(), { credentialId: b.id }), deps(store));
    expect(picked).toMatchObject({ action: "success", userName: "frank" });
    expect((picked as { credential: AuthenticationResponseJSON }).credential.id).toBe(b.id);
  });

  it("allowCredentials narrows the candidates", async () => {
    const store = new MemoryStore();
    await register(store, "gina");
    const h = await register(store, "hank");
    const res = await handleRequest(getReq(getOptions({ allowCredentials: [{ type: "public-key", id: h.id }] })), deps(store));
    expect(res).toMatchObject({ action: "success", userName: "hank" });
    const none = await handleRequest(getReq(getOptions({ allowCredentials: [{ type: "public-key", id: "zzz" }] })), deps(store));
    expect(none.action).toBe("empty");
  });

  it("conditional mediation follows conditionalAutoLogin", async () => {
    const store = new MemoryStore();
    expect(await handleRequest(getReq(getOptions(), { mediation: "conditional" }), deps(store))).toEqual({ action: "pending" });
    await register(store, "ivy");
    expect((await handleRequest(getReq(getOptions(), { mediation: "conditional" }), deps(store))).action).toBe("success");
    expect(
      await handleRequest(getReq(getOptions(), { mediation: "conditional" }), deps(store, { settings: { conditionalAutoLogin: false } })),
    ).toEqual({ action: "pending" });
  });

  it("a vanished selection reports an error", async () => {
    const store = new MemoryStore();
    expect(await handleRequest(getReq(getOptions(), { credentialId: "gone" }), deps(store))).toMatchObject({ action: "error" });
  });

  it("rpId outside the page's domain → SecurityError without contacting the server", async () => {
    const store = new MemoryStore();
    expect(await handleRequest(getReq(getOptions({ rpId: "other.com" })), deps(store))).toMatchObject({
      action: "reject",
      name: "SecurityError",
    });
    expect(store.listCalls).toEqual([]);
  });

  it("server errors → error dialog", async () => {
    const store = new MemoryStore();
    store.failList = true;
    expect(await handleRequest(getReq(), deps(store))).toMatchObject({
      action: "error",
      message: expect.stringContaining("无法连接服务器"),
    });
  });

  it("conditional requests stay silent (pending) when the server is unreachable", async () => {
    const store = new MemoryStore();
    store.failList = true;
    expect(await handleRequest(getReq(getOptions(), { mediation: "conditional" }), deps(store))).toEqual({ action: "pending" });
    expect(store.listCalls).toEqual(["example.com"]);
    // modal requests still explain the failure
    expect((await handleRequest(getReq(getOptions(), { mediation: "optional" }), deps(store))).action).toBe("error");
    // after the user picked an account from a conditional picker, failures are reported
    expect(
      (await handleRequest(getReq(getOptions(), { mediation: "conditional", credentialId: "picked" }), deps(store))).action,
    ).toBe("error");
  });

  it("dotless rpIds and IP hosts only match exactly", async () => {
    const store = new MemoryStore();
    const on = (hostname: string): CallerInfo => ({ origin: `https://${hostname}`, hostname, crossOrigin: false });
    const get = (hostname: string, rpId: string): BackgroundRequest => ({
      type: "pkb:get",
      caller: on(hostname),
      options: getOptions({ rpId }),
    });
    expect(await handleRequest(get("a.com", "com"), deps(store))).toMatchObject({ action: "reject", name: "SecurityError" });
    expect(await handleRequest(get("127.0.0.1", "0.0.1"), deps(store))).toMatchObject({ action: "reject", name: "SecurityError" });
    expect(await handleRequest(createReq(createOptions({ rp: { id: "com", name: "" } }), on("a.com")), deps(store))).toMatchObject({
      action: "reject",
      name: "SecurityError",
    });
    expect(store.listCalls).toEqual([]);
    expect((await handleRequest(get("localhost", "localhost"), deps(store))).action).toBe("empty");
    expect((await handleRequest(get("127.0.0.1", "127.0.0.1"), deps(store))).action).toBe("empty");
  });

  it("use() failures do not affect the login", async () => {
    const store = new MemoryStore();
    await register(store, "jack");
    store.useCredential = async () => {
      throw new Error("boom");
    };
    expect((await handleRequest(getReq(), deps(store))).action).toBe("success");
  });
});

describe("handleRequest: credentials of this browser profile", () => {
  const signedInAs = (res: unknown) => (res as { userName?: string }).userName;
  const pickerOf = (res: unknown) => (res as { candidates: Array<{ id: string; user_name: string; owned?: boolean }> }).candidates;

  it("remembers a registered credential once the server saved it", async () => {
    const store = new MemoryStore();
    const profile = new MemoryProfile();
    const res = await handleRequest(createReq(), deps(store, { profile }));
    await profile.settled();
    expect([...profile.owned.keys()]).toEqual([(res as { credential: RegistrationResponseJSON }).credential.id]);

    const failed = new MemoryProfile();
    store.failCreate = true;
    expect((await handleRequest(createReq(), deps(store, { profile: failed }))).action).toBe("error");
    store.failCreate = false;
    const existing = store.credentials[0]!.id;
    const excluded = createOptions({ excludeCredentials: [{ type: "public-key", id: existing }] });
    expect((await handleRequest(createReq(excluded), deps(store, { profile: failed }))).action).toBe("reject");
    const controller = new AbortController();
    controller.abort();
    await handleRequest(createReq(), { ...deps(store, { profile: failed }), signal: controller.signal });
    await failed.settled();
    expect(failed.owned.size).toBe(0);
  });

  it("remembers a credential saved before the page aborted", async () => {
    const store = new MemoryStore();
    const profile = new MemoryProfile();
    const controller = new AbortController();
    const write = store.createCredential.bind(store);
    store.createCredential = async (credential) => {
      const saved = await write(credential);
      controller.abort();
      return saved;
    };
    const result = await handleRequest(createReq(), { ...deps(store, { profile }), signal: controller.signal });
    expect(result).toMatchObject({ action: "reject", name: "NotAllowedError" });
    await profile.settled();
    expect([...profile.owned.keys()]).toEqual([store.credentials[0]!.id]);
  });

  it("does not wait for the record before answering", async () => {
    const store = new MemoryStore();
    const profile = new MemoryProfile();
    await register(store, "quinn", -7, profile);
    await register(store, "rose");
    profile.stall = true;
    const within = <T>(work: Promise<T>) =>
      Promise.race([work, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1000))]);
    expect(await within(handleRequest(getReq(), deps(store, { profile })))).toMatchObject({ action: "success", userName: "quinn" });
    expect(await within(handleRequest(createReq(), deps(store, { profile })))).toMatchObject({ action: "success" });
  });

  it("several accounts, one registered here → signs with it without a picker", async () => {
    const store = new MemoryStore();
    const a = new MemoryProfile();
    const b = new MemoryProfile();
    await register(store, "alice", -7, a);
    await register(store, "bob", -7, b);

    expect(signedInAs(await handleRequest(getReq(), deps(store, { profile: a })))).toBe("alice");
    expect(signedInAs(await handleRequest(getReq(), deps(store, { profile: b })))).toBe("bob");
    expect((await handleRequest(getReq(), deps(store))).action).toBe("picker");
  });

  it("a choice made in the picker signs in directly next time", async () => {
    const store = new MemoryStore();
    await register(store, "carol");
    const dan = await register(store, "dan");
    const profile = new MemoryProfile();
    expect((await handleRequest(getReq(), deps(store, { profile }))).action).toBe("picker");
    expect(profile.owned.size).toBe(0);

    await handleRequest(getReq(getOptions(), { credentialId: dan.id }), deps(store, { profile }));
    await profile.settled();
    expect([...profile.owned.keys()]).toEqual([dan.id]);
    expect(signedInAs(await handleRequest(getReq(), deps(store, { profile })))).toBe("dan");
  });

  it("several accounts used here → picker with them first, most recent first, and marked", async () => {
    const store = new MemoryStore();
    const profile = new MemoryProfile();
    const erin = await register(store, "erin", -7, profile);
    await register(store, "frank");
    await register(store, "gina", -7, profile);
    await handleRequest(getReq(getOptions(), { credentialId: erin.id }), deps(store, { profile }));
    await profile.settled();

    const res = await handleRequest(getReq(), deps(store, { profile }));
    expect(res.action).toBe("picker");
    expect(pickerOf(res).map((c) => [c.user_name, c.owned])).toEqual([
      ["erin", true],
      ["gina", true],
      ["frank", false],
    ]);
  });

  it("autoLoginSingle off → the picker, with the account used here first", async () => {
    const store = new MemoryStore();
    const profile = new MemoryProfile();
    await register(store, "hank");
    await register(store, "ivy", -7, profile);
    const res = await handleRequest(getReq(), deps(store, { profile, settings: { autoLoginSingle: false } }));
    expect(res.action).toBe("picker");
    expect(pickerOf(res).map((c) => [c.user_name, c.owned])).toEqual([
      ["ivy", true],
      ["hank", false],
    ]);
  });

  it("conditional requests sign in with it, unless autoLoginSingle or conditionalAutoLogin is off", async () => {
    const store = new MemoryStore();
    const profile = new MemoryProfile();
    await register(store, "jack");
    await register(store, "kate", -7, profile);
    const conditional = getReq(getOptions(), { mediation: "conditional" });
    expect(signedInAs(await handleRequest(conditional, deps(store, { profile })))).toBe("kate");
    const choose = await handleRequest(conditional, deps(store, { profile, settings: { autoLoginSingle: false } }));
    expect(choose.action).toBe("picker");
    expect(pickerOf(choose).map((c) => [c.user_name, c.owned])).toEqual([
      ["kate", true],
      ["jack", false],
    ]);
    expect(await handleRequest(conditional, deps(store, { profile, settings: { conditionalAutoLogin: false } }))).toEqual({
      action: "pending",
    });
    expect((await handleRequest(conditional, deps(store))).action).toBe("picker");
  });

  it("applies after allowCredentials", async () => {
    const store = new MemoryStore();
    const profile = new MemoryProfile();
    const leo = await register(store, "leo", -7, profile);
    const mia = await register(store, "mia");
    const ned = await register(store, "ned");
    const allow = (...ids: string[]) => getReq(getOptions({ allowCredentials: ids.map((id) => ({ type: "public-key", id })) }));
    expect((await handleRequest(allow(mia.id, ned.id), deps(store, { profile }))).action).toBe("picker");
    expect(signedInAs(await handleRequest(allow(leo.id, ned.id), deps(store, { profile })))).toBe("leo");
    expect(signedInAs(await handleRequest(allow(ned.id), deps(store, { profile })))).toBe("ned");
  });

  it("storage failures do not affect sign-in or registration", async () => {
    const store = new MemoryStore();
    const profile = new MemoryProfile();
    await register(store, "olga", -7, profile);
    await register(store, "pete");
    profile.failLoad = true;
    expect((await handleRequest(getReq(), deps(store, { profile }))).action).toBe("picker");
    profile.failLoad = false;
    profile.failRemember = true;
    expect(signedInAs(await handleRequest(getReq(), deps(store, { profile })))).toBe("olga");
    expect((await handleRequest(createReq(), deps(store, { profile }))).action).toBe("success");
  });
});

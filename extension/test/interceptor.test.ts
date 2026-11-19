import { describe, expect, it, vi } from "vitest";
import { CAPABILITY_OVERRIDES, installInterceptor, type PageGlobals } from "../src/lib/interceptor";
import { PAGE_CHANNEL, type PageResult, type ToContent, type ToPage } from "../src/lib/protocol";
import { assertionJSON, FakeAssertionResponse, FakeAttestationResponse, FakePublicKeyCredential, registrationJSON } from "./fixtures";

const bytes = (...b: number[]) => new Uint8Array(b);

const createOptions = () => ({
  publicKey: {
    rp: { name: "Example" },
    user: { id: bytes(1), name: "alice", displayName: "Alice" },
    challenge: bytes(1, 2, 3),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  },
});
const getOptions = () => ({ publicKey: { challenge: bytes(9) } });

function setup(opts: { secure?: boolean; capabilities?: boolean } = {}) {
  const nativeCreate = vi.fn(async function (this: unknown, o: unknown) {
    return { native: "create", self: this, options: o };
  });
  const nativeGet = vi.fn(async function (this: unknown, o: unknown) {
    return { native: "get", self: this, options: o };
  });
  class CredentialsContainer {}
  Object.assign(CredentialsContainer.prototype, { create: nativeCreate, get: nativeGet });
  class PublicKeyCredential extends FakePublicKeyCredential {
    static isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
    static isConditionalMediationAvailable = async () => false;
  }
  if (opts.capabilities !== false) {
    Object.assign(PublicKeyCredential, { getClientCapabilities: async () => ({ hybridTransport: true, conditionalGet: false }) });
  }
  const globals = {
    isSecureContext: opts.secure ?? true,
    CredentialsContainer,
    PublicKeyCredential,
    AuthenticatorAttestationResponse: FakeAttestationResponse,
    AuthenticatorAssertionResponse: FakeAssertionResponse,
    DOMException,
  } as unknown as PageGlobals;

  const sent: ToContent[] = [];
  let handler: ((m: ToPage) => void) | undefined;
  let n = 0;
  const installed = installInterceptor(
    globals,
    { send: (m) => sent.push(m), onMessage: (h) => (handler = h) },
    () => `req-${++n}`,
  );
  const container = new CredentialsContainer() as unknown as CredentialsContainer & {
    create(o?: unknown): Promise<any>;
    get(o?: unknown): Promise<any>;
  };
  const respond = (id: string, result: PageResult) => handler!({ channel: PAGE_CHANNEL, dir: "to-page", kind: "response", id, result });
  return { installed, container, sent, respond, nativeCreate, nativeGet, PublicKeyCredential, CredentialsContainer };
}

describe("installInterceptor", () => {
  it("does nothing outside secure contexts", async () => {
    const { installed, container, nativeCreate, PublicKeyCredential } = setup({ secure: false });
    expect(installed).toBe(false);
    await container.create(createOptions());
    expect(nativeCreate).toHaveBeenCalledOnce();
    expect(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).toBe(false);
  });

  it("static capability methods report a platform authenticator", async () => {
    const { PublicKeyCredential } = setup();
    const P = PublicKeyCredential as unknown as Record<string, () => Promise<unknown>>;
    expect(await P["isUserVerifyingPlatformAuthenticatorAvailable"]!()).toBe(true);
    expect(await P["isConditionalMediationAvailable"]!()).toBe(true);
    expect(await P["getClientCapabilities"]!()).toEqual({ hybridTransport: true, ...CAPABILITY_OVERRIDES });
  });

  it("leaves getClientCapabilities undefined when the browser lacks it", () => {
    const { PublicKeyCredential } = setup({ capabilities: false });
    expect("getClientCapabilities" in PublicKeyCredential).toBe(false);
  });

  it("passes non-publicKey calls to the native implementation", async () => {
    const { container, sent, nativeGet } = setup();
    const result = await container.get({ password: true });
    expect(result).toMatchObject({ native: "get", self: container, options: { password: true } });
    await container.get();
    expect(nativeGet).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([]);
  });

  it("create: sends a serialized request and resolves a PublicKeyCredential", async () => {
    const { container, sent, respond, nativeCreate } = setup();
    const promise = container.create(createOptions());
    expect(sent).toEqual([
      {
        channel: PAGE_CHANNEL,
        dir: "to-content",
        kind: "request",
        id: "req-1",
        op: "create",
        options: {
          rp: { name: "Example" },
          user: { id: "AQ", name: "alice", displayName: "Alice" },
          challenge: "AQID",
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          excludeCredentials: [],
          extensions: {},
        },
      },
    ]);
    respond("req-1", { type: "success", credential: registrationJSON });
    const cred = await promise;
    expect(cred).toBeInstanceOf(FakePublicKeyCredential);
    expect(cred.response).toBeInstanceOf(FakeAttestationResponse);
    expect(cred.toJSON()).toEqual(registrationJSON);
    expect(nativeCreate).not.toHaveBeenCalled();
  });

  it("get: forwards mediation and resolves assertions", async () => {
    const { container, sent, respond } = setup();
    const promise = container.get({ ...getOptions(), mediation: "conditional" });
    expect(sent[0]).toMatchObject({ op: "get", mediation: "conditional", options: { challenge: "CQ", allowCredentials: [] } });
    respond("req-1", { type: "success", credential: assertionJSON });
    expect((await promise).response).toBeInstanceOf(FakeAssertionResponse);
  });

  it("rejects with a DOMException named by the content script", async () => {
    const { container, respond } = setup();
    const promise = container.create(createOptions());
    respond("req-1", { type: "error", name: "InvalidStateError", message: "exists" });
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect(err).toMatchObject({ name: "InvalidStateError", message: "exists" });
  });

  it("fallback calls the saved native function with the original this and options", async () => {
    const { container, respond, nativeGet } = setup();
    const options = getOptions();
    const promise = container.get(options);
    respond("req-1", { type: "fallback" });
    expect(await promise).toEqual({ native: "get", self: container, options });
    expect(nativeGet).toHaveBeenCalledOnce();
  });

  it("matches concurrent responses by request ID", async () => {
    const { container, sent, respond } = setup();
    const a = container.get(getOptions());
    const b = container.create(createOptions());
    expect(sent.map((m) => m.id)).toEqual(["req-1", "req-2"]);
    respond("req-2", { type: "success", credential: registrationJSON });
    respond("req-1", { type: "error", name: "NotAllowedError", message: "no" });
    expect((await b).response).toBeInstanceOf(FakeAttestationResponse);
    await expect(a).rejects.toMatchObject({ name: "NotAllowedError" });
    respond("req-1", { type: "success", credential: assertionJSON }); // late duplicates are ignored
  });

  it("abort rejects with signal.reason, notifies content and ignores late responses", async () => {
    const { container, sent, respond } = setup();
    const controller = new AbortController();
    const promise = container.get({ ...getOptions(), signal: controller.signal });
    const reason = new Error("page navigated");
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(sent[1]).toEqual({ channel: PAGE_CHANNEL, dir: "to-content", kind: "abort", id: "req-1" });
    respond("req-1", { type: "success", credential: assertionJSON });
  });

  it("abort without a reason rejects with AbortError", async () => {
    const { container } = setup();
    const controller = new AbortController();
    const promise = container.create({ ...createOptions(), signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an already-aborted signal rejects without contacting content", async () => {
    const { container, sent } = setup();
    await expect(container.get({ ...getOptions(), signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(sent).toEqual([]);
  });

  it("aborting after completion is a no-op", async () => {
    const { container, sent, respond } = setup();
    const controller = new AbortController();
    const promise = container.get({ ...getOptions(), signal: controller.signal });
    respond("req-1", { type: "success", credential: assertionJSON });
    await promise;
    controller.abort();
    expect(sent).toHaveLength(1);
  });

  it("invalid options reject with TypeError", async () => {
    const { container, sent } = setup();
    await expect(container.get({ publicKey: { challenge: "nope" } })).rejects.toBeInstanceOf(TypeError);
    expect(sent).toEqual([]);
  });

  it("replaced methods keep native-like names", () => {
    const { CredentialsContainer } = setup();
    const proto = CredentialsContainer.prototype as Record<string, { name: string }>;
    expect(proto["create"]!.name).toBe("create");
    expect(proto["get"]!.name).toBe("get");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  PAGE_CHANNEL,
  type BackgroundRequest,
  type BackgroundResponse,
  type CallerInfo,
  type ToContent,
  type ToPage,
} from "../src/lib/protocol";
import { createContentRouter, NOT_ALLOWED_MESSAGE, toastText, type ContentUI, type UiChoice } from "../src/lib/router";
import { assertionJSON, flush, registrationJSON } from "./fixtures";

const caller: CallerInfo = { origin: "https://login.example.com", hostname: "login.example.com", crossOrigin: false };

const getRequest = (id = "r1", mediation?: string): ToContent => ({
  channel: PAGE_CHANNEL,
  dir: "to-content",
  kind: "request",
  id,
  op: "get",
  options: { challenge: "AQ", allowCredentials: [] },
  ...(mediation ? { mediation } : {}),
});

const createRequest = (id = "c1"): ToContent => ({
  channel: PAGE_CHANNEL,
  dir: "to-content",
  kind: "request",
  id,
  op: "create",
  options: {
    rp: { id: "example.com", name: "Example" },
    user: { id: "AQ", name: "alice", displayName: "Alice" },
    challenge: "AQ",
    pubKeyCredParams: [],
    excludeCredentials: [],
    extensions: {},
  },
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(responses: Array<BackgroundResponse | Error | undefined>) {
  const sent: BackgroundRequest[] = [];
  const posted: ToPage[] = [];
  const dialogs: Array<{ kind: string; id: string; args: unknown[]; choice: ReturnType<typeof deferred<UiChoice>> }> = [];
  const open = (kind: string) =>
    vi.fn((id: string, ...args: unknown[]) => {
      const choice = deferred<UiChoice>();
      dialogs.push({ kind, id, args, choice });
      return choice.promise;
    });
  const ui = {
    showPicker: open("picker"),
    showEmpty: open("empty"),
    showError: open("error"),
    close: vi.fn((id: string) => {
      for (const d of dialogs) if (d.id === id) d.choice.resolve({ kind: "closed" });
    }),
    toast: vi.fn(),
  } satisfies ContentUI;
  const queue = [...responses];
  const router = createContentRouter({
    send: async (req) => {
      sent.push(req);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    post: (m) => posted.push(m),
    caller: () => caller,
    ui,
  });
  return { router, sent, posted, dialogs, ui };
}

describe("content router", () => {
  it("forwards get requests with caller info and mediation", async () => {
    const { router, sent } = setup([{ action: "pending" }]);
    await router.handle(getRequest("r1", "conditional"));
    expect(sent).toEqual([
      { type: "pkb:get", requestId: "r1", caller, options: { challenge: "AQ", allowCredentials: [] }, mediation: "conditional" },
    ]);
  });

  it("fallback → tells the page to use the native implementation", async () => {
    const { router, posted } = setup([{ action: "fallback" }]);
    await router.handle(createRequest());
    expect(posted).toEqual([{ channel: PAGE_CHANNEL, dir: "to-page", kind: "response", id: "c1", result: { type: "fallback" } }]);
  });

  it("success → resolves the page and shows the toast", async () => {
    const { router, posted, ui } = setup([{ action: "success", credential: registrationJSON, toast: "saved", userName: "alice" }]);
    await router.handle(createRequest());
    expect(posted[0]!.result).toEqual({ type: "success", credential: registrationJSON });
    expect(ui.toast).toHaveBeenCalledWith("saved", toastText("saved", "alice"));
  });

  it("reject → DOMException data plus the exists toast", async () => {
    const { router, posted, ui } = setup([{ action: "reject", name: "InvalidStateError", message: "dup", toast: "exists" }]);
    await router.handle(createRequest());
    expect(posted[0]!.result).toEqual({ type: "error", name: "InvalidStateError", message: "dup" });
    expect(ui.toast).toHaveBeenCalledWith("exists", expect.any(String));
  });

  it("pending → nothing until abort closes it", async () => {
    const { router, posted, ui } = setup([{ action: "pending" }]);
    await router.handle(getRequest("r1", "conditional"));
    expect(posted).toEqual([]);
    await router.handle({ channel: PAGE_CHANNEL, dir: "to-content", kind: "abort", id: "r1" });
    expect(ui.close).toHaveBeenCalledWith("r1");
    expect(posted).toEqual([]);
  });

  it("picker → selection signs with the chosen credential", async () => {
    const candidates = [
      { id: "a", user_name: "a@x", user_display_name: "A", rp_id: "example.com" },
      { id: "b", user_name: "b@x", user_display_name: "B", rp_id: "example.com" },
    ];
    const { router, posted, sent, dialogs, ui } = setup([
      { action: "picker", candidates },
      { action: "success", credential: assertionJSON, toast: "signed-in", userName: "b@x" },
    ]);
    const done = router.handle(getRequest());
    await flush();
    expect(dialogs[0]).toMatchObject({ kind: "picker", id: "r1", args: ["login.example.com", candidates] });
    dialogs[0]!.choice.resolve({ kind: "select", credentialId: "b" });
    await done;
    expect(sent[1]).toMatchObject({ type: "pkb:get", credentialId: "b" });
    expect(posted[0]!.result).toEqual({ type: "success", credential: assertionJSON });
    expect(ui.toast).toHaveBeenCalledWith("signed-in", toastText("signed-in", "b@x"));
  });

  it.each<[string, BackgroundResponse]>([
    ["picker", { action: "picker", candidates: [] }],
    ["empty", { action: "empty" }],
    ["error", { action: "error", message: "down" }],
  ])("%s dialog: cancel → NotAllowedError, fallback → native", async (_kind, response) => {
    const cancel = setup([response]);
    const p1 = cancel.router.handle(getRequest());
    await flush();
    cancel.dialogs[0]!.choice.resolve({ kind: "cancel" });
    await p1;
    expect(cancel.posted[0]!.result).toEqual({ type: "error", name: "NotAllowedError", message: NOT_ALLOWED_MESSAGE });

    const fallback = setup([response]);
    const p2 = fallback.router.handle(getRequest());
    await flush();
    fallback.dialogs[0]!.choice.resolve({ kind: "fallback" });
    await p2;
    expect(fallback.posted[0]!.result).toEqual({ type: "fallback" });
  });

  it("error dialogs get the operation and rpId", async () => {
    const { router, dialogs } = setup([{ action: "error", message: "upload failed" }]);
    void router.handle(createRequest());
    await flush();
    expect(dialogs[0]).toMatchObject({ kind: "error", args: ["create", "example.com", "upload failed"] });
  });

  it("abort while a dialog is open closes it and posts nothing", async () => {
    const { router, posted, dialogs, ui } = setup([{ action: "empty" }]);
    const done = router.handle(getRequest());
    await flush();
    await router.handle({ channel: PAGE_CHANNEL, dir: "to-content", kind: "abort", id: "r1" });
    await done;
    expect(ui.close).toHaveBeenCalledWith("r1");
    expect(dialogs).toHaveLength(1);
    expect(posted).toEqual([]);
  });

  it("abort while waiting for the background drops the late result", async () => {
    const { router, posted } = setup([{ action: "fallback" }]);
    const done = router.handle(getRequest());
    await router.handle({ channel: PAGE_CHANNEL, dir: "to-content", kind: "abort", id: "r1" });
    await done;
    expect(posted).toEqual([]);
  });

  it("background failures show the error dialog", async () => {
    const thrown = setup([new Error("Extension context invalidated.")]);
    void thrown.router.handle(getRequest());
    await flush();
    expect(thrown.dialogs[0]).toMatchObject({ kind: "error", args: ["get", "login.example.com", expect.stringContaining("Extension context invalidated")] });

    const silent = setup([undefined]);
    void silent.router.handle(getRequest());
    await flush();
    expect(silent.dialogs[0]!.kind).toBe("error");
  });

  it("ignores duplicate request IDs while one is active", async () => {
    const { router, sent } = setup([{ action: "pending" }, { action: "pending" }]);
    await router.handle(getRequest("dup"));
    await router.handle(getRequest("dup"));
    expect(sent).toHaveLength(1);
  });

  it("toast texts", () => {
    expect(toastText("signed-in", "alice")).toBe("已使用通行密钥登录 · alice");
    expect(toastText("saved", "")).toBe("通行密钥已保存");
    expect(toastText("exists", "x")).toContain("已保存在 Passkey Box");
  });
});

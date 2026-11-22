// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "../src/lib/api";
import { CONFIG_KEY } from "../src/lib/config";
import { cred, fakeFetch, json } from "./fixtures";

const config = { serverUrl: "https://pk.example.com", username: "alice", password: "pw" };

const own = cred({ id: "own", rp_name: "GitHub", user_name: "alice-gh", owner: { id: 1, username: "alice" }, access: "owner", shared_at: null });
const shared = cred({ id: "in", rp_name: "Figma", user_name: "team@example.com", owner: { id: 2, username: "bob" }, access: "shared", shared_at: "2026-11-21T00:00:00Z" });
// Servers before 0.6.0 send none of owner, access and shared_at.
const legacy = cred({ id: "old", rp_name: "Linear", user_name: "alice-linear" });

/** Opens the signed-in popup (no current site) against a server listing `credentials`. */
async function openPopup(credentials: Credential[], deleteStatus = 204) {
  const stored: Record<string, unknown> = { [CONFIG_KEY]: config };
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => (key in stored ? { [key]: stored[key] } : {}),
        remove: async (keys: string[]) => {
          for (const key of keys) delete stored[key];
          for (const listener of listeners) listener(Object.fromEntries(keys.map((key) => [key, {}])), "local");
        },
      },
      onChanged: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) },
    },
    tabs: { query: async () => [{ url: "chrome://newtab/" }], create: vi.fn() },
  });
  const server = fakeFetch((_url, init) => {
    if (init.method !== "DELETE") return json(200, { credentials });
    return deleteStatus === 204 ? new Response(null, { status: 204 }) : json(deleteStatus, { error: { code: "internal", message: "boom" } });
  });
  vi.stubGlobal("fetch", server.fn);
  document.body.replaceChildren(Object.assign(document.createElement("div"), { id: "app" }));
  vi.resetModules();
  await import("../src/popup");
  await vi.waitFor(() => expect(document.querySelector(".item")).not.toBeNull());
  return server;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-credential-id="${id}"]`);
const removeButton = () => [...document.querySelectorAll<HTMLButtonElement>(".detail-actions .btn")].at(-1)!;
const fields = () => [...document.querySelectorAll(".field-row")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("popup: passkeys shared by other users", () => {
  it("lists a shared passkey with its owner after the account; own passkeys look as before", async () => {
    await openPopup([own, shared, legacy]);
    const sub = row("in")!.querySelector<HTMLElement>(".item-sub")!;
    expect(sub.className).toBe("item-sub shared");
    expect(sub.querySelector(".item-account")!.textContent).toBe("team@example.com");
    const tag = sub.querySelector<HTMLElement>(".item-owner")!;
    expect(tag.textContent).toBe("共享自 bob");
    expect(tag.title).toBe("共享自 bob");
    for (const [id, name] of [["own", "alice-gh"], ["old", "alice-linear"]] as const) {
      const plain = row(id)!.querySelector<HTMLElement>(".item-sub")!;
      expect(plain.className).toBe("item-sub");
      expect(plain.children).toHaveLength(0);
      expect(plain.textContent).toBe(name);
    }
  });

  it("a long account name truncates before the owner does", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "static", "ui.css"), "utf8");
    expect(css).toMatch(/\.item-sub\.shared \{[^}]*display: flex;/);
    expect(css).toMatch(/\.item-account,\s*\.item-owner \{[^}]*overflow: hidden;\s*text-overflow: ellipsis;/);
    expect(css).toMatch(/\.item-owner \{[^}]*flex: none;\s*max-width: 60%;/);
  });

  it("details name the owner, and removing leaves the share through DELETE", async () => {
    const server = await openPopup([own, shared]);
    row("in")!.click();
    expect(fields()).toContainEqual(["所有者", "bob"]);
    expect(fields().map(([k]) => k)).toEqual(["网站", "用户名", "显示名", "所有者", "创建时间", "最近使用"]);
    expect(removeButton().textContent).toBe("移除共享");
    removeButton().click();
    await vi.waitFor(() => expect(row("own")).not.toBeNull());
    expect(server.calls.at(-1)).toMatchObject({ url: "https://pk.example.com/api/v1/credentials/in", init: { method: "DELETE" } });
    expect(document.querySelector(".flash")!.textContent).toBe("已移除共享");
    expect(row("in")).toBeNull();
  });

  it("explains a failed removal", async () => {
    await openPopup([shared], 500);
    row("in")!.click();
    removeButton().click();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(false));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("移除共享失败：服务器返回错误（500）：boom");
  });

  it.each([
    ["own", own],
    ["legacy", legacy],
  ])("an %s passkey keeps the 0.5.0 details and deletion", async (_name, c) => {
    await openPopup([c, shared], 500);
    row(c.id)!.click();
    expect(fields().map(([k]) => k)).toEqual(["网站", "用户名", "显示名", "创建时间", "最近使用"]);
    expect(removeButton().textContent).toBe("删除");
    removeButton().click();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(false));
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("删除失败：服务器返回错误（500）：boom");
  });

  it("an own passkey is deleted with the 0.5.0 message", async () => {
    await openPopup([own, shared]);
    row("own")!.click();
    removeButton().click();
    await vi.waitFor(() => expect(row("in")).not.toBeNull());
    expect(document.querySelector(".flash")!.textContent).toBe("已删除通行密钥");
  });
});

describe("popup: custom fields", () => {
  // RFC 6238's SHA1 seed: 6-digit codes 081804 for T=37037036 (1111111080–1111111109 s) and 050471 for T=37037037.
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const withFields = cred({
    id: "f",
    rp_name: "GitHub",
    fields: [
      { id: "a", label: "工号", type: "text", value: "E-1024" },
      { id: "b", label: "恢复码", type: "password", value: "abcd-efgh" },
      { id: "c", label: "", type: "totp", value: SECRET },
      { id: "d", label: "后台", type: "url", value: "https://admin.example.com/login" },
      { id: "e", label: "内网", type: "url", value: "javascript:alert(1)" },
      { id: "g", label: "备注", type: "multiline", value: "第一行\n第二行" },
      { id: "h", label: "", type: "email", value: "" },
      { id: "i", label: "旧密钥", type: "totp", value: "not base32!" },
    ],
  });

  const customRows = () => [...document.querySelectorAll<HTMLElement>(".custom-fields .field-row")];
  const customRow = (label: string) => customRows().find((r) => r.querySelector("dt")!.textContent === label)!;
  const value = (label: string) => customRow(label).querySelector(".field-value")!.textContent;
  const rowButton = (label: string, name: string) =>
    [...customRow(label).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name)!;
  const backButton = () => document.querySelector<HTMLButtonElement>(".subbar .btn")!;
  const accountButton = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".account-actions .btn")].find((b) => b.textContent === name)!;

  /** WebCrypto settles outside the fake timers. */
  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 1000 && !check(); i++) await new Promise((r) => setImmediate(r));
    expect(check()).toBe(true);
  }

  function stubClipboard() {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    return writeText;
  }

  async function openDetail(c: Credential, now = 1111111109_000) {
    await openPopup([c]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now });
    row(c.id)!.click();
  }

  it("lists the fields under the details in their order, hiding passwords and TOTP secrets", async () => {
    await openDetail(withFields);
    expect([...document.querySelectorAll(".fields:not(.custom-fields) dt")].map((dt) => dt.textContent)).toEqual([
      "网站",
      "用户名",
      "显示名",
      "创建时间",
      "最近使用",
    ]);
    await until(() => value("一次性密码") === "081 804");
    expect(customRows().map((r) => [r.dataset.fieldType, r.querySelector("dt")!.textContent, r.querySelector(".field-value")!.textContent])).toEqual([
      ["text", "工号", "E-1024"],
      ["password", "恢复码", "••••••••"],
      ["totp", "一次性密码", "081 804"],
      ["url", "后台", "https://admin.example.com/login"],
      ["url", "内网", "javascript:alert(1)"],
      ["multiline", "备注", "第一行\n第二行"],
      ["email", "邮箱", "—"],
      ["totp", "旧密钥", "无法识别的密钥"],
    ]);
    expect(customRows().map((r) => [...r.querySelectorAll("button")].map((b) => b.textContent))).toEqual([
      ["复制"],
      ["显示", "复制"],
      ["复制"],
      ["打开", "复制"],
      ["复制"],
      ["复制"],
      [],
      [],
    ]);
    expect(document.body.textContent).not.toContain("abcd-efgh");
    expect(document.body.textContent).not.toContain(SECRET);
    // Field values are text, never markup.
    expect(customRow("内网").querySelector("a")).toBeNull();
  });

  it("reveals and copies a password, and copies other values", async () => {
    const writeText = stubClipboard();
    await openDetail(withFields);
    rowButton("恢复码", "显示").click();
    expect(value("恢复码")).toBe("abcd-efgh");
    rowButton("恢复码", "隐藏").click();
    expect(value("恢复码")).toBe("••••••••");
    expect(rowButton("恢复码", "显示")).toBeDefined();

    rowButton("恢复码", "复制").click();
    await until(() => document.querySelector(".flash")?.textContent === "已复制恢复码");
    rowButton("备注", "复制").click();
    expect(writeText.mock.calls).toEqual([["abcd-efgh"], ["第一行\n第二行"]]);
  });

  it("opens only http(s) links, in a new tab", async () => {
    await openDetail(withFields);
    rowButton("后台", "打开").click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://admin.example.com/login" });
    expect(rowButton("内网", "打开")).toBeUndefined();
  });

  it("shows the TOTP code and seconds left, refreshes it every second and copies it", async () => {
    const writeText = stubClipboard();
    await openDetail(withFields, 1111111108_400);
    const remaining = () => customRow("一次性密码").querySelector(".totp-remaining")!.textContent;
    // Nothing to copy before WebCrypto computed the first code.
    expect(value("一次性密码")).toBe("••••••••");
    expect(rowButton("一次性密码", "复制").disabled).toBe(true);
    await until(() => value("一次性密码") === "081 804" && remaining() === "2 秒");
    expect(rowButton("一次性密码", "复制").disabled).toBe(false);

    // The next tick comes at the start of the next second.
    vi.advanceTimersByTime(599);
    await until(() => remaining() === "2 秒");
    vi.advanceTimersByTime(1);
    await until(() => remaining() === "1 秒");
    expect(value("一次性密码")).toBe("081 804");
    vi.advanceTimersByTime(1000);
    await until(() => value("一次性密码") === "050 471" && remaining() === "30 秒");

    rowButton("一次性密码", "复制").click();
    await until(() => document.querySelector(".flash")?.textContent === "已复制验证码");
    expect(writeText).toHaveBeenCalledWith("050471");
  });

  it("stops the TOTP timer when going back to the list or to the settings", async () => {
    await openDetail(withFields);
    await until(() => value("一次性密码") === "081 804");
    expect(vi.getTimerCount()).toBe(1);
    backButton().click();
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector(".custom-fields")).toBeNull();

    row("f")!.click();
    expect(vi.getTimerCount()).toBe(1);
    accountButton("设置").click();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the TOTP timer when signing out from the details", async () => {
    await openDetail(withFields);
    expect(vi.getTimerCount()).toBe(1);
    accountButton("退出登录").click();
    await until(() => document.querySelector(".login-form") !== null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no timer without a TOTP field", async () => {
    await openDetail(cred({ id: "p", fields: [{ id: "b", label: "", type: "password", value: "x" }] }));
    expect(customRows().map((r) => r.querySelector("dt")!.textContent)).toEqual(["密码"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["before 0.7.0 sends no fields", legacy],
    ["sends no custom fields", cred({ id: "e", rp_name: "Empty", fields: [] })],
  ])("a server that %s gets the details as before", async (_name, c) => {
    await openDetail(c);
    expect(document.querySelector(".custom-fields")).toBeNull();
    expect(fields().map(([k]) => k)).toEqual(["网站", "用户名", "显示名", "创建时间", "最近使用"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

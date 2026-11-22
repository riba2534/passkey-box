// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "../src/lib/api";
import { CONFIG_KEY } from "../src/lib/config";
import { fakeFetch, json } from "./fixtures";

const config = { serverUrl: "https://pk.example.com", username: "alice", password: "pw" };

function cred(over: Partial<Credential>): Credential {
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

const own = cred({ id: "own", rp_name: "GitHub", user_name: "alice-gh", owner: { id: 1, username: "alice" }, access: "owner", shared_at: null });
const shared = cred({ id: "in", rp_name: "Figma", user_name: "team@example.com", owner: { id: 2, username: "bob" }, access: "shared", shared_at: "2026-11-21T00:00:00Z" });
// Servers before 0.6.0 send none of owner, access and shared_at.
const legacy = cred({ id: "old", rp_name: "Linear", user_name: "alice-linear" });

/** Opens the signed-in popup (no current site) against a server listing `credentials`. */
async function openPopup(credentials: Credential[], deleteStatus = 204) {
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: async (key: string) => (key === CONFIG_KEY ? { [key]: config } : {}) },
      onChanged: { addListener: () => undefined },
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

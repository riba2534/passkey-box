// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPageUI, HOST_TAG, TOAST_MS } from "../src/ui/page-ui";

const candidates = [
  { id: "cred-a", user_name: "alice@example.com", user_display_name: "Alice", rp_id: "example.com" },
  { id: "cred-b", user_name: "bob@example.com", user_display_name: "", rp_id: "example.com" },
];

beforeEach(() => {
  document.documentElement.querySelectorAll(HOST_TAG).forEach((el) => el.remove());
});

afterEach(() => {
  vi.useRealTimers();
});

function q(ui: ReturnType<typeof createPageUI>, selector: string) {
  return ui.root()!.querySelector<HTMLElement>(selector);
}

describe("page UI host", () => {
  it("mounts lazily on <passkey-box-ui> under documentElement with an open shadow root", () => {
    const ui = createPageUI(document);
    expect(document.querySelector(HOST_TAG)).toBeNull();
    void ui.showEmpty("r1", "example.com");
    const host = document.documentElement.querySelector(HOST_TAG)!;
    expect(host.parentElement).toBe(document.documentElement);
    expect(host.shadowRoot).not.toBeNull();
    expect(host.shadowRoot!.mode).toBe("open");
    expect(host.shadowRoot!.querySelector("style")!.textContent).toContain("#0572EC");
    void ui.showEmpty("r2", "example.com");
    expect(document.querySelectorAll(HOST_TAG)).toHaveLength(1);
  });

  it("re-attaches the host if the page removed it", () => {
    const ui = createPageUI(document);
    ui.toast("saved", "ok");
    document.querySelector(HOST_TAG)!.remove();
    ui.toast("saved", "again");
    expect(document.querySelector(HOST_TAG)).not.toBeNull();
  });
});

describe("picker dialog", () => {
  it("renders header, accounts and both actions", () => {
    const ui = createPageUI(document);
    void ui.showPicker("r1", "example.com", candidates);
    const dialog = q(ui, '[data-pkb-dialog="picker"]')!;
    expect(dialog.textContent).toContain("Passkey Box");
    expect(dialog.textContent).toContain("使用通行密钥登录 · example.com");
    const a = q(ui, '[data-pkb-credential-id="cred-a"]')!;
    expect(a.tagName).toBe("BUTTON");
    expect(a.textContent).toContain("Alice");
    expect(a.textContent).toContain("alice@example.com");
    expect(q(ui, '[data-pkb-credential-id="cred-b"]')!.textContent).toContain("bob@example.com");
    expect(dialog.querySelector(".avatar")!.textContent).toBe("A");
    expect(dialog.querySelector('[data-pkb-action="cancel"]')!.textContent).toBe("取消");
    expect(dialog.querySelector('[data-pkb-action="fallback"]')!.textContent).toBe("使用其他方式");
  });

  it("clicking an account resolves the selection and removes the dialog", async () => {
    const ui = createPageUI(document);
    const choice = ui.showPicker("r1", "example.com", candidates);
    q(ui, '[data-pkb-credential-id="cred-b"] .account-text')!.click();
    expect(await choice).toEqual({ kind: "select", credentialId: "cred-b" });
    expect(q(ui, "[data-pkb-dialog]")).toBeNull();
  });

  it.each([
    ["cancel", { kind: "cancel" }],
    ["fallback", { kind: "fallback" }],
  ])("%s button", async (action, expected) => {
    const ui = createPageUI(document);
    const choice = ui.showPicker("r1", "example.com", candidates);
    q(ui, `[data-pkb-action="${action}"]`)!.click();
    expect(await choice).toEqual(expected);
  });

  it("Escape cancels", async () => {
    const ui = createPageUI(document);
    const choice = ui.showPicker("r1", "example.com", candidates);
    q(ui, "[data-pkb-credential-id]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await choice).toEqual({ kind: "cancel" });
  });

  it("close(id) removes only that dialog", async () => {
    const ui = createPageUI(document);
    const first = ui.showPicker("r1", "example.com", candidates);
    void ui.showEmpty("r2", "example.com");
    ui.close("r1");
    expect(await first).toEqual({ kind: "closed" });
    expect(q(ui, '[data-pkb-dialog="picker"]')).toBeNull();
    expect(q(ui, '[data-pkb-dialog="empty"]')).not.toBeNull();
    ui.close("unknown");
  });
});

describe("empty and error dialogs", () => {
  it("empty dialog has both actions", async () => {
    const ui = createPageUI(document);
    const choice = ui.showEmpty("r1", "example.com");
    const dialog = q(ui, '[data-pkb-dialog="empty"]')!;
    expect(dialog.textContent).toContain("未找到通行密钥");
    expect(dialog.textContent).toContain("example.com");
    dialog.querySelector<HTMLElement>('[data-pkb-action="fallback"]')!.click();
    expect(await choice).toEqual({ kind: "fallback" });
  });

  it("error dialog shows the message and op-specific title", async () => {
    const ui = createPageUI(document);
    const choice = ui.showError("r1", "create", "example.com", "保存通行密钥失败：boom");
    const dialog = q(ui, '[data-pkb-dialog="error"]')!;
    expect(dialog.textContent).toContain("创建通行密钥 · example.com");
    expect(dialog.textContent).toContain("保存通行密钥失败：boom");
    expect(dialog.querySelector('[data-pkb-action="fallback"]')).not.toBeNull();
    dialog.querySelector<HTMLElement>('[data-pkb-action="cancel"]')!.click();
    expect(await choice).toEqual({ kind: "cancel" });
  });

  it("does not interpret page data as HTML", () => {
    const ui = createPageUI(document);
    void ui.showPicker("r1", "<img src=x>", [{ id: "x", user_name: "<b>bold</b>", user_display_name: "", rp_id: "x" }]);
    expect(ui.root()!.querySelector("img, b")).toBeNull();
    expect(q(ui, "[data-pkb-credential-id]")!.textContent).toContain("<b>bold</b>");
  });
});

describe("toasts", () => {
  it("appear with data-pkb-toast and disappear after about 3 seconds", () => {
    vi.useFakeTimers();
    const ui = createPageUI(document);
    ui.toast("signed-in", "已使用通行密钥登录 · alice");
    const toast = q(ui, '[data-pkb-toast="signed-in"]')!;
    expect(toast.textContent).toContain("alice");
    vi.advanceTimersByTime(TOAST_MS - 250);
    expect(q(ui, '[data-pkb-toast="signed-in"]')).not.toBeNull();
    vi.advanceTimersByTime(300);
    expect(q(ui, '[data-pkb-toast="signed-in"]')).toBeNull();
    expect(TOAST_MS).toBe(3000);
  });

  it.each(["saved", "exists"] as const)("%s toast", (kind) => {
    const ui = createPageUI(document);
    ui.toast(kind, "x");
    expect(q(ui, `[data-pkb-toast="${kind}"]`)).not.toBeNull();
  });
});

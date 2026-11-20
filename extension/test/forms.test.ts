// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/lib/config";
import type { LoginResult } from "../src/lib/login";
import { loginForm, settingsPanel } from "../src/ui/forms";
import { flush } from "./fixtures";

function mount(opts: Partial<Parameters<typeof loginForm>[1]> = {}) {
  const verify = vi.fn<(input: { serverUrl: string; username: string; password: string }) => Promise<LoginResult>>();
  const save = vi.fn<(c: Config) => Promise<void>>(async () => undefined);
  const onSuccess = vi.fn();
  const form = loginForm(document, { defaultServerUrl: "", submitLabel: "登录", verify, save, onSuccess, ...opts });
  document.body.replaceChildren(form);
  const input = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  return { form, verify, save, onSuccess, input, error: form.querySelector<HTMLElement>(".form-error")! };
}

describe("loginForm", () => {
  it("prefills the default server URL or the saved config", () => {
    expect(mount({ defaultServerUrl: "https://pk.example.com" }).input("serverUrl").value).toBe("https://pk.example.com");
    const saved = mount({ defaultServerUrl: "https://default", initial: { serverUrl: "http://saved", username: "u", password: "p" } });
    expect(saved.input("serverUrl").value).toBe("http://saved");
    expect(saved.input("username").value).toBe("u");
    expect(saved.input("password").value).toBe("p");
    expect(saved.input("password").type).toBe("password");
  });

  it("verifies, saves the normalized config and reports success", async () => {
    const { form, verify, save, onSuccess, input, error } = mount();
    const config = { serverUrl: "https://pk.example.com", username: "alice", password: "pw" };
    verify.mockResolvedValue({ ok: true, config, user: { username: "alice" } as never });
    input("serverUrl").value = "pk.example.com/";
    input("username").value = "alice";
    input("password").value = "pw";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(verify).toHaveBeenCalledWith({ serverUrl: "pk.example.com/", username: "alice", password: "pw" });
    expect(save).toHaveBeenCalledWith(config);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(input("serverUrl").value).toBe("https://pk.example.com");
    expect(error.hidden).toBe(true);
  });

  it("shows the failure reason and does not save", async () => {
    const { form, verify, save, error } = mount();
    verify.mockResolvedValue({ ok: false, message: "用户名或密码错误" });
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(save).not.toHaveBeenCalled();
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("用户名或密码错误");
    expect(form.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(false);
  });
});

describe("settingsPanel", () => {
  it("renders both switches and reports changes", () => {
    const onChange = vi.fn();
    const panel = settingsPanel(document, { autoLoginSingle: true, conditionalAutoLogin: false }, onChange);
    document.body.replaceChildren(panel);
    const single = panel.querySelector<HTMLInputElement>('[data-setting="autoLoginSingle"]')!;
    const conditional = panel.querySelector<HTMLInputElement>('[data-setting="conditionalAutoLogin"]')!;
    expect(single.checked).toBe(true);
    expect(conditional.checked).toBe(false);
    expect(panel.textContent).toContain("只有一个账号时跳过选择");
    expect(panel.textContent).toContain("响应页面的自动填充请求");
    single.checked = false;
    single.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenLastCalledWith({ autoLoginSingle: false, conditionalAutoLogin: false });
    conditional.checked = true;
    conditional.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenLastCalledWith({ autoLoginSingle: false, conditionalAutoLogin: true });
  });
});

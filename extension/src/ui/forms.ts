// Login form and settings switches shared by popup.html and options.html.

import type { User } from "../lib/api";
import type { Config, Settings } from "../lib/config";
import type { LoginResult } from "../lib/login";
import { h } from "./dom";

export interface LoginFormOptions {
  initial?: Partial<Config> | null;
  defaultServerUrl: string;
  submitLabel: string;
  verify(input: { serverUrl: string; username: string; password: string }): Promise<LoginResult>;
  save(config: Config): Promise<void>;
  onSuccess?(config: Config, user: User): void;
}

function field(doc: Document, id: string, label: string, input: HTMLInputElement): HTMLElement {
  input.id = id;
  return h(doc, "div", { class: "field" }, h(doc, "label", { for: id }, label), input);
}

export function loginForm(doc: Document, opts: LoginFormOptions): HTMLFormElement {
  const serverUrl = h(doc, "input", {
    type: "text",
    name: "serverUrl",
    placeholder: "https://passkey.example.com",
    autocomplete: "url",
    spellcheck: "false",
  });
  serverUrl.value = opts.initial?.serverUrl || opts.defaultServerUrl;
  const username = h(doc, "input", { type: "text", name: "username", autocomplete: "username", spellcheck: "false" });
  username.value = opts.initial?.username ?? "";
  const password = h(doc, "input", { type: "password", name: "password", autocomplete: "current-password" });
  password.value = opts.initial?.password ?? "";
  const error = h(doc, "div", { class: "form-error", role: "alert", hidden: "" });
  const submit = h(doc, "button", { type: "submit", class: "primary" }, opts.submitLabel);

  const form = h(
    doc,
    "form",
    { class: "login-form", novalidate: "" },
    field(doc, "pkb-server-url", "服务器地址", serverUrl),
    field(doc, "pkb-username", "用户名", username),
    field(doc, "pkb-password", "密码", password),
    error,
    submit,
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      error.hidden = true;
      submit.disabled = true;
      submit.textContent = "正在登录…";
      try {
        const result = await opts.verify({ serverUrl: serverUrl.value, username: username.value, password: password.value });
        if (!result.ok) {
          error.textContent = result.message;
          error.hidden = false;
          return;
        }
        serverUrl.value = result.config.serverUrl;
        await opts.save(result.config);
        opts.onSuccess?.(result.config, result.user);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : String(err);
        error.hidden = false;
      } finally {
        submit.disabled = false;
        submit.textContent = opts.submitLabel;
      }
    })();
  });
  return form;
}

export const SETTING_LABELS: Record<keyof Settings, { title: string; desc: string }> = {
  autoLoginSingle: {
    title: "只匹配到一个时自动登录",
    desc: "网站请求通行密钥时，如果只找到一个账号，直接使用它登录，不弹出选择框。",
  },
  conditionalAutoLogin: {
    title: "页面打开时自动登录",
    desc: "网站在页面打开时就请求通行密钥（自动填充式登录）时，直接使用匹配到的账号登录。",
  },
};

export function settingsPanel(
  doc: Document,
  settings: Settings,
  onChange: (settings: Settings) => Promise<void> | void,
): HTMLElement {
  const current: Settings = { ...settings };
  const rows = (Object.keys(SETTING_LABELS) as Array<keyof Settings>).map((key) => {
    const input = h(doc, "input", { type: "checkbox", class: "switch", "data-setting": key, role: "switch" });
    input.checked = current[key];
    input.addEventListener("change", () => {
      current[key] = input.checked;
      void onChange({ ...current });
    });
    return h(
      doc,
      "label",
      { class: "toggle-row" },
      h(
        doc,
        "span",
        { class: "toggle-text" },
        h(doc, "span", { class: "toggle-title" }, SETTING_LABELS[key].title),
        h(doc, "span", { class: "toggle-desc" }, SETTING_LABELS[key].desc),
      ),
      input,
    );
  });
  return h(doc, "div", { class: "settings" }, ...rows);
}

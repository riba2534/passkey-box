// Options page: the same login form as the popup plus the two auto-login switches.

import { CONFIG_KEY } from "./lib/config";
import { verifyLogin } from "./lib/login";
import { serverHost } from "./lib/popup-model";
import { clearConfig, loadConfig, loadSettings, saveConfig, saveSettings } from "./lib/storage";
import { button, h } from "./ui/dom";
import { loginForm, settingsPanel } from "./ui/forms";
import { LOGO_FILE, logo } from "./ui/logo";

const app = document.getElementById("app")!;

async function render(): Promise<void> {
  const [config, settings] = await Promise.all([loadConfig(), loadSettings()]);

  const status = config
    ? h(
        document,
        "div",
        { class: "status ok" },
        h(document, "span", {}, "已登录 ", h(document, "strong", {}, config.username), ` · ${serverHost(config.serverUrl)}`),
        button(document, "退出登录", "ghost danger-text", () => void clearConfig()),
      )
    : h(document, "div", { class: "status" }, "尚未登录。填写服务器地址、用户名和密码后即可使用服务器上保存的通行密钥。");

  const saved = h(document, "p", { class: "saved-hint", role: "status", hidden: "" }, "已保存");

  app.replaceChildren(
    h(
      document,
      "header",
      { class: "options-head" },
      logo(document, "options-logo", LOGO_FILE),
      h(document, "div", {}, h(document, "h1", {}, "Passkey Box"), h(document, "p", { class: "muted" }, "通行密钥扩展设置")),
    ),
    h(
      document,
      "section",
      { class: "card" },
      h(document, "h2", {}, "服务器"),
      status,
      loginForm(document, {
        initial: config,
        defaultServerUrl: __PKB_DEFAULT_SERVER_URL__,
        submitLabel: config ? "保存并重新登录" : "登录",
        verify: (input) => verifyLogin(input),
        save: saveConfig,
      }),
    ),
    h(
      document,
      "section",
      { class: "card" },
      h(document, "h2", {}, "自动登录"),
      settingsPanel(document, settings, async (next) => {
        await saveSettings(next);
        saved.hidden = false;
        setTimeout(() => (saved.hidden = true), 1200);
      }),
      saved,
    ),
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && CONFIG_KEY in changes) void render();
});

void render();

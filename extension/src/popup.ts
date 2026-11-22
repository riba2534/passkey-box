// Toolbar popup: login when unconfigured, otherwise a 1Password-style passkey list.

import { describeError, ServerClient, type Credential } from "./lib/api";
import { CONFIG_KEY, type Config, type Settings } from "./lib/config";
import { verifyLogin } from "./lib/login";
import { MANAGED_KEY, type ManagedPolicy } from "./lib/managed";
import {
  accountName,
  credentialTitle,
  detailFields,
  groupCredentials,
  removeAction,
  serverHost,
  sharedLabel,
  siteUrl,
  tabHostname,
} from "./lib/popup-model";
import { clearConfig, loadConfig, loadPolicy, loadSettings, saveConfig, saveSettings } from "./lib/storage";
import { avatar } from "./ui/avatar";
import { button, h, icon } from "./ui/dom";
import { loginForm, settingsPanel } from "./ui/forms";
import { BACK, CHEVRON, GEAR, SEARCH } from "./ui/icons";
import { LOGO_FILE, logo } from "./ui/logo";

const app = document.getElementById("app")!;

function flash(text: string): void {
  const el = h(document, "div", { class: "flash", role: "status" }, text);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

async function activeTabHostname(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabHostname(tab?.url);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- login

function renderLogin(): void {
  app.replaceChildren(
    h(document, "header", { class: "topbar" }, logo(document, "topbar-logo", LOGO_FILE), h(document, "span", { class: "topbar-title" }, "Passkey Box")),
    h(
      document,
      "main",
      { class: "login-main" },
      h(
        document,
        "div",
        { class: "login-hero" },
        logo(document, "hero-logo", LOGO_FILE),
        h(document, "h1", {}, "登录 Passkey Box"),
        h(document, "p", {}, "连接到你的 Passkey Box 服务器，即可在网站上自动使用保存的通行密钥。"),
      ),
      loginForm(document, {
        defaultServerUrl: __PKB_DEFAULT_SERVER_URL__,
        submitLabel: "登录",
        verify: (input) => verifyLogin(input),
        save: saveConfig,
      }),
    ),
  );
}

// ---------------------------------------------------------------- signed in

interface MainState {
  settings: Settings;
  query: string;
  credentials: Credential[] | null;
  error: string;
}

function renderMain(config: Config, settings: Settings, policy: ManagedPolicy, hostname: string): void {
  const client = new ServerClient(config);
  const state: MainState = { settings, query: "", credentials: null, error: "" };
  const view = h(document, "main", { class: "view" });

  const search = h(document, "input", { type: "search", placeholder: "搜索通行密钥", "aria-label": "搜索通行密钥", spellcheck: "false" });
  search.addEventListener("input", () => {
    state.query = search.value;
    showList();
  });
  const topbar = h(
    document,
    "header",
    { class: "topbar" },
    logo(document, "topbar-logo", LOGO_FILE),
    h(document, "label", { class: "search" }, icon(document, SEARCH, "search-icon"), search),
  );

  const footer = h(
    document,
    "footer",
    { class: "account-bar" },
    h(
      document,
      "div",
      { class: "account-info" },
      avatar(document, config.username, config.username, "avatar avatar-sm"),
      h(
        document,
        "div",
        { class: "account-text" },
        h(document, "div", { class: "account-name" }, config.username),
        h(document, "div", { class: "account-server", title: config.serverUrl }, serverHost(config.serverUrl)),
      ),
    ),
    h(
      document,
      "div",
      { class: "account-actions" },
      button(document, "打开 Web 后台", "ghost", () => void chrome.tabs.create({ url: config.serverUrl })),
      button(document, "设置", "ghost", showSettings, GEAR),
      button(document, "退出登录", "ghost danger-text", () => void clearConfig()),
    ),
  );

  app.replaceChildren(topbar, view, footer);
  search.focus();
  void refresh();

  async function refresh(): Promise<void> {
    state.error = "";
    state.credentials = null;
    showList();
    try {
      state.credentials = await client.listCredentials();
    } catch (err) {
      state.error = describeError(err);
    }
    showList();
  }

  function row(c: Credential): HTMLElement {
    const title = credentialTitle(c);
    const shared = sharedLabel(c);
    const sub = shared
      ? h(
          document,
          "span",
          { class: "item-sub shared" },
          h(document, "span", { class: "item-account" }, accountName(c)),
          h(document, "span", { class: "item-owner", title: shared }, shared),
        )
      : h(document, "span", { class: "item-sub" }, accountName(c));
    const btn = h(
      document,
      "button",
      { type: "button", class: "item", "data-credential-id": c.id },
      avatar(document, c.rp_id, title, "avatar avatar-sm"),
      h(
        document,
        "span",
        { class: "item-text" },
        h(document, "span", { class: "item-title" }, title),
        sub,
      ),
      icon(document, CHEVRON, "item-go"),
    );
    btn.addEventListener("click", () => showDetail(c));
    return btn;
  }

  function section(title: string, count: number | null, items: Credential[], empty: string): HTMLElement {
    return h(
      document,
      "section",
      { class: "group" },
      h(document, "h2", { class: "group-title" }, title, count === null ? null : h(document, "span", { class: "count" }, String(count))),
      items.length ? h(document, "div", { class: "items" }, ...items.map(row)) : h(document, "p", { class: "group-empty" }, empty),
    );
  }

  function showList(): void {
    topbar.hidden = false;
    if (state.error) {
      const retry = button(document, "重试", "secondary", () => void refresh());
      view.replaceChildren(
        h(document, "div", { class: "state" }, h(document, "p", { class: "state-error" }, state.error), retry),
      );
      return;
    }
    if (!state.credentials) {
      view.replaceChildren(h(document, "div", { class: "state" }, h(document, "p", { class: "muted" }, "正在加载…")));
      return;
    }
    if (state.credentials.length === 0) {
      view.replaceChildren(
        h(
          document,
          "div",
          { class: "state" },
          h(document, "p", { class: "state-title" }, "还没有通行密钥"),
          h(document, "p", { class: "muted" }, "在网站上创建通行密钥时，Passkey Box 会自动保存到服务器。"),
        ),
      );
      return;
    }
    const groups = groupCredentials(state.credentials, hostname, state.query);
    const sections: HTMLElement[] = [];
    if (hostname) {
      sections.push(section(`当前网站 · ${hostname}`, null, groups.current, state.query ? "没有匹配的通行密钥" : "当前网站没有保存的通行密钥"));
    }
    sections.push(section("全部通行密钥", groups.all.length, groups.all, "没有匹配的通行密钥"));
    view.replaceChildren(...sections);
  }

  function backBar(title: string): HTMLElement {
    const back = button(document, "返回", "back", () => showList(), BACK);
    return h(document, "div", { class: "subbar" }, back, h(document, "span", { class: "subbar-title" }, title));
  }

  function showDetail(c: Credential): void {
    topbar.hidden = true;
    const title = credentialTitle(c);
    const status = h(document, "p", { class: "state-error", role: "alert", hidden: "" });
    const remove = removeAction(c);
    const del = button(document, remove.label, "danger", () => {
      void (async () => {
        del.disabled = true;
        try {
          await client.deleteCredential(c.id);
          if (state.credentials) state.credentials = state.credentials.filter((x) => x.id !== c.id);
          flash(remove.done);
          showList();
        } catch (err) {
          status.textContent = `${remove.failed}：${describeError(err)}`;
          status.hidden = false;
          del.disabled = false;
        }
      })();
    });
    view.replaceChildren(
      backBar(""),
      h(
        document,
        "div",
        { class: "detail-hero" },
        avatar(document, c.rp_id, title, "avatar avatar-lg"),
        h(document, "div", {}, h(document, "div", { class: "detail-title" }, title), h(document, "div", { class: "muted" }, "通行密钥")),
      ),
      h(
        document,
        "dl",
        { class: "fields" },
        ...detailFields(c).map(([k, v]) => h(document, "div", { class: "field-row" }, h(document, "dt", {}, k), h(document, "dd", {}, v))),
      ),
      h(
        document,
        "div",
        { class: "detail-actions" },
        button(document, "复制用户名", "secondary", () => {
          void navigator.clipboard.writeText(c.user_name).then(
            () => flash("已复制用户名"),
            () => flash("复制失败"),
          );
        }),
        siteUrl(c) ? button(document, "打开网站", "secondary", () => void chrome.tabs.create({ url: siteUrl(c) })) : null,
        del,
      ),
      status,
    );
  }

  function showSettings(): void {
    topbar.hidden = true;
    view.replaceChildren(
      backBar("设置"),
      settingsPanel(
        document,
        state.settings,
        async (next) => {
          state.settings = next;
          await saveSettings(next);
        },
        policy.autoLogin,
      ),
    );
  }
}

// ---------------------------------------------------------------- boot

async function main(): Promise<void> {
  const [config, settings, policy, hostname] = await Promise.all([loadConfig(), loadSettings(), loadPolicy(), activeTabHostname()]);
  if (config) renderMain(config, settings, policy, hostname);
  else renderLogin();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (CONFIG_KEY in changes || MANAGED_KEY in changes)) void main();
});

void main();

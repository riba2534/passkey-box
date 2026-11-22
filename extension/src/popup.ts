// Toolbar popup: login when unconfigured, otherwise a 1Password-style passkey list.

import { describeError, ServerClient, type Credential, type Field } from "./lib/api";
import { CONFIG_KEY, type Config, type Settings } from "./lib/config";
import { verifyLogin } from "./lib/login";
import { MANAGED_KEY, type ManagedPolicy } from "./lib/managed";
import {
  accountName,
  credentialTitle,
  detailFields,
  fieldLabel,
  fieldLink,
  fieldText,
  groupCode,
  groupCredentials,
  removeAction,
  serverHost,
  sharedLabel,
  siteUrl,
  tabHostname,
} from "./lib/popup-model";
import { clearConfig, loadConfig, loadPolicy, loadSettings, saveConfig, saveSettings } from "./lib/storage";
import { parseTotp, totp } from "./lib/totp";
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

function copy(text: string, done: string): void {
  void navigator.clipboard.writeText(text).then(
    () => flash(done),
    () => flash("复制失败"),
  );
}

// A detail view refreshes its one-time codes every second until another view replaces it, which calls
// leaveView() first. Closing the popup ends its page and the timer with it.
let stopTimer = (): void => undefined;

function leaveView(): void {
  stopTimer();
  stopTimer = () => undefined;
}

/** Calls `tick` now and then at the start of every second, until the returned function is called. */
function everySecond(tick: (now: number) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    const now = Date.now();
    tick(now);
    timer = setTimeout(run, 1000 - (now % 1000));
  };
  run();
  return () => clearTimeout(timer);
}

/** A custom field's row: label, value and buttons. A TOTP field adds the update of its code to `ticks`. */
function fieldRow(f: Field, ticks: Array<(now: number) => void>): HTMLElement {
  const label = fieldLabel(f);
  const value = h(document, "span", { class: "field-value" }, fieldText(f));
  const actions = h(document, "span", { class: "field-actions" });
  if (f.type === "totp") {
    const params = parseTotp(f.value);
    if (!params) {
      value.textContent = "无法识别的密钥";
    } else {
      let code = "";
      const remaining = h(document, "span", { class: "totp-remaining" });
      const copyCode = button(document, "复制", "ghost", () => copy(code, "已复制验证码"));
      copyCode.disabled = true;
      value.classList.add("totp-code");
      actions.append(remaining, copyCode);
      ticks.push((now) => {
        void totp(params, now).then((next) => {
          code = next.code;
          value.textContent = groupCode(next.code);
          remaining.textContent = `${next.remaining} 秒`;
          copyCode.disabled = false;
        });
      });
    }
  } else if (f.value) {
    if (f.type === "password") {
      let revealed = false;
      const toggle = button(document, "显示", "ghost", () => {
        revealed = !revealed;
        value.textContent = fieldText(f, revealed);
        toggle.textContent = revealed ? "隐藏" : "显示";
      });
      actions.append(toggle);
    }
    const link = fieldLink(f);
    if (link) actions.append(button(document, "打开", "ghost", () => void chrome.tabs.create({ url: link })));
    actions.append(button(document, "复制", "ghost", () => copy(f.value, `已复制${label}`)));
  }
  return h(
    document,
    "div",
    { class: "field-row", "data-field-type": f.type },
    h(document, "dt", {}, label),
    h(document, "dd", {}, value, actions),
  );
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
  leaveView();
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
    leaveView();
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
    leaveView();
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
    // Servers before 0.7.0 send no fields.
    const extra = c.fields ?? [];
    const ticks: Array<(now: number) => void> = [];
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
      ...(extra.length ? [h(document, "dl", { class: "fields custom-fields" }, ...extra.map((f) => fieldRow(f, ticks)))] : []),
      h(
        document,
        "div",
        { class: "detail-actions" },
        button(document, "复制用户名", "secondary", () => copy(c.user_name, "已复制用户名")),
        siteUrl(c) ? button(document, "打开网站", "secondary", () => void chrome.tabs.create({ url: siteUrl(c) })) : null,
        del,
      ),
      status,
    );
    if (ticks.length) stopTimer = everySecond((now) => ticks.forEach((tick) => tick(now)));
  }

  function showSettings(): void {
    leaveView();
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

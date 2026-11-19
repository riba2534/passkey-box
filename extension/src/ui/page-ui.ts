// In-page dialogs and toasts (CONTRACT 4.6), rendered in an open shadow root on <passkey-box-ui>.

import type { ContentUI, UiChoice } from "../lib/router";
import type { CandidateSummary, Op, ToastKind } from "../lib/protocol";
import { avatar } from "./avatar";
import { h, icon } from "./dom";
import { CHECK, CHEVRON, INFO, KEY_OUTLINE, WARNING } from "./icons";
import logoUrl from "../assets/logo-64.png";
import { logo } from "./logo";

export const HOST_TAG = "passkey-box-ui";
export const TOAST_MS = 3000;
const TOAST_FADE_MS = 200;

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif';

const PAGE_UI_CSS = `
:host { all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647; display: block; }
.stack { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; font: 14px/1.45 ${FONT}; color: #1b1f24; -webkit-font-smoothing: antialiased; }
.card { box-sizing: border-box; width: 360px; max-width: calc(100vw - 32px); background: #fff; border-radius: 12px; overflow: hidden;
  box-shadow: 0 12px 32px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .08), 0 0 0 1px rgba(15, 23, 42, .06); animation: pkb-in .18s ease-out; }
.head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px; border-bottom: 1px solid #eef0f3; }
.logo { width: 28px; height: 28px; flex: none; display: block; }
.head-text { min-width: 0; }
.brand { font-size: 12px; line-height: 16px; color: #6b7280; font-weight: 500; }
.title { font-size: 14px; line-height: 20px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.title .rp { color: #4b5563; font-weight: 500; }
.body { padding: 6px 8px 8px; max-height: 320px; overflow-y: auto; }
.hint { padding: 4px 8px 6px; font-size: 12px; color: #6b7280; }
.account { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
.account:hover { background: #eef5ff; }
.account:focus-visible { background: #eef5ff; outline: 2px solid #0572EC; outline-offset: -2px; }
.avatar { width: 32px; height: 32px; border-radius: 50%; color: #fff; font-size: 14px; font-weight: 600; display: flex; align-items: center; justify-content: center; flex: none; }
.account-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.name, .user { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.name { font-weight: 600; color: #1b1f24; }
.user { font-size: 12px; color: #6b7280; }
.go { width: 16px; height: 16px; color: #9ca3af; flex: none; }
.message { display: flex; gap: 12px; padding: 14px 16px 16px; align-items: flex-start; }
.message-icon { width: 22px; height: 22px; flex: none; color: #6b7280; margin-top: 1px; }
.message-title { font-weight: 600; }
.message-text { margin-top: 2px; font-size: 13px; color: #4b5563; word-break: break-word; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 10px 16px; border-top: 1px solid #eef0f3; background: #fafbfc; }
.link { all: unset; cursor: pointer; color: #0572EC; font-size: 13px; font-weight: 500; }
.link:hover { text-decoration: underline; }
.btn { all: unset; cursor: pointer; padding: 5px 14px; border-radius: 6px; border: 1px solid #d0d7de; background: #fff; color: #1b1f24; font-size: 13px; font-weight: 500; }
.btn:hover { background: #f3f4f6; }
.link:focus-visible, .btn:focus-visible { outline: 2px solid #0572EC; outline-offset: 2px; }
.toast { box-sizing: border-box; display: flex; align-items: center; gap: 10px; max-width: 360px; padding: 10px 14px 10px 12px; background: #fff; border-radius: 10px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, .14), 0 0 0 1px rgba(15, 23, 42, .06); font-size: 13px; font-weight: 500; animation: pkb-in .18s ease-out;
  transition: opacity ${TOAST_FADE_MS}ms ease, transform ${TOAST_FADE_MS}ms ease; }
.toast.leaving { opacity: 0; transform: translateY(-6px); }
.toast-icon { width: 20px; height: 20px; flex: none; }
.toast-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@keyframes pkb-in { from { opacity: 0; transform: translateY(-8px) scale(.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .card, .toast { animation: none; transition: none; } }
`;

interface OpenDialog {
  el: HTMLElement;
  resolve(choice: UiChoice): void;
}

export interface PageUI extends ContentUI {
  /** The shadow root, once something has been shown. */
  root(): ShadowRoot | null;
}

export function createPageUI(doc: Document = document): PageUI {
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let stack: HTMLElement | null = null;
  const dialogs = new Map<string, OpenDialog>();

  function ensureStack(): HTMLElement {
    if (!host || !shadow || !stack) {
      host = doc.createElement(HOST_TAG);
      shadow = host.attachShadow({ mode: "open" });
      const style = h(doc, "style");
      style.textContent = PAGE_UI_CSS;
      stack = h(doc, "div", { class: "stack" });
      shadow.append(style, stack);
    }
    if (!host.isConnected) (doc.documentElement ?? doc).appendChild(host);
    return stack;
  }

  function header(title: string, rpId: string): HTMLElement {
    return h(
      doc,
      "header",
      { class: "head" },
      // Inlined as a data URL, so the page UI needs no web_accessible_resources.
      logo(doc, "logo", logoUrl),
      h(
        doc,
        "div",
        { class: "head-text" },
        h(doc, "div", { class: "brand" }, "Passkey Box"),
        h(doc, "div", { class: "title", title: `${title} · ${rpId}` }, `${title} · `, h(doc, "span", { class: "rp" }, rpId)),
      ),
    );
  }

  function footer(): HTMLElement {
    return h(
      doc,
      "footer",
      { class: "foot" },
      h(doc, "button", { type: "button", class: "link", "data-pkb-action": "fallback" }, "使用其他方式"),
      h(doc, "button", { type: "button", class: "btn", "data-pkb-action": "cancel" }, "取消"),
    );
  }

  function message(spec: typeof INFO, title: string, text: string): HTMLElement {
    return h(
      doc,
      "div",
      { class: "message" },
      icon(doc, spec, "message-icon"),
      h(doc, "div", {}, h(doc, "div", { class: "message-title" }, title), h(doc, "div", { class: "message-text" }, text)),
    );
  }

  function finish(id: string, choice: UiChoice): void {
    const open = dialogs.get(id);
    if (!open) return;
    dialogs.delete(id);
    open.el.remove();
    open.resolve(choice);
  }

  function showDialog(id: string, kind: "picker" | "empty" | "error", label: string, ...content: HTMLElement[]): Promise<UiChoice> {
    finish(id, { kind: "closed" });
    const card = h(doc, "section", { class: "card", role: "dialog", "aria-label": label, "data-pkb-dialog": kind }, ...content, footer());
    card.addEventListener("click", (event) => {
      const target = (event.target as Element | null)?.closest?.("[data-pkb-action],[data-pkb-credential-id]");
      if (!target) return;
      const credentialId = target.getAttribute("data-pkb-credential-id");
      const action = target.getAttribute("data-pkb-action");
      if (credentialId !== null) finish(id, { kind: "select", credentialId });
      else if (action === "fallback") finish(id, { kind: "fallback" });
      else if (action === "cancel") finish(id, { kind: "cancel" });
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Escape") finish(id, { kind: "cancel" });
    });
    const promise = new Promise<UiChoice>((resolve) => dialogs.set(id, { el: card, resolve }));
    ensureStack().appendChild(card);
    return promise;
  }

  function accountButton(c: CandidateSummary): HTMLElement {
    const display = c.user_display_name && c.user_display_name !== c.user_name ? c.user_display_name : "";
    const primary = display || c.user_name || "（无用户名）";
    return h(
      doc,
      "button",
      { type: "button", class: "account", "data-pkb-credential-id": c.id, title: c.user_name },
      avatar(doc, primary, primary),
      h(
        doc,
        "span",
        { class: "account-text" },
        h(doc, "span", { class: "name" }, primary),
        display ? h(doc, "span", { class: "user" }, c.user_name) : null,
      ),
      icon(doc, CHEVRON, "go"),
    );
  }

  return {
    root: () => shadow,

    showPicker(id, rpId, candidates) {
      return showDialog(
        id,
        "picker",
        "选择通行密钥",
        header("使用通行密钥登录", rpId),
        h(doc, "div", { class: "body" }, h(doc, "div", { class: "hint" }, "选择要登录的账号"), ...candidates.map(accountButton)),
      );
    },

    showEmpty(id, rpId) {
      return showDialog(
        id,
        "empty",
        "未找到通行密钥",
        header("使用通行密钥登录", rpId),
        message(KEY_OUTLINE, "未找到通行密钥", `Passkey Box 中没有可用于 ${rpId} 的通行密钥。`),
      );
    },

    showError(id, op: Op, rpId, text) {
      return showDialog(
        id,
        "error",
        "Passkey Box 出错",
        header(op === "create" ? "创建通行密钥" : "使用通行密钥登录", rpId),
        message(WARNING, op === "create" ? "无法保存通行密钥" : "无法获取通行密钥", text),
      );
    },

    close(id) {
      finish(id, { kind: "closed" });
    },

    toast(kind: ToastKind, text: string) {
      const el = h(
        doc,
        "div",
        { class: "toast", role: "status", "data-pkb-toast": kind },
        icon(doc, kind === "exists" ? INFO : CHECK, "toast-icon"),
        h(doc, "span", { class: "toast-text" }, text),
      );
      ensureStack().appendChild(el);
      setTimeout(() => el.classList.add("leaving"), TOAST_MS - TOAST_FADE_MS);
      setTimeout(() => el.remove(), TOAST_MS);
    },
  };
}

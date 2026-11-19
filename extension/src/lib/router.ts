// ISOLATED world request routing: page request → background → UI → page result.

import type {
  BackgroundRequest,
  BackgroundResponse,
  CallerInfo,
  CandidateSummary,
  Op,
  PageResult,
  ToastKind,
  ToContent,
  ToPage,
} from "./protocol";
import { PAGE_CHANNEL, requestedRpId } from "./protocol";
import { effectiveRpId } from "./rpid";

export type UiChoice = { kind: "select"; credentialId: string } | { kind: "cancel" } | { kind: "fallback" } | { kind: "closed" };

export interface ContentUI {
  showPicker(id: string, rpId: string, candidates: CandidateSummary[]): Promise<UiChoice>;
  showEmpty(id: string, rpId: string): Promise<UiChoice>;
  showError(id: string, op: Op, rpId: string, message: string): Promise<UiChoice>;
  close(id: string): void;
  toast(kind: ToastKind, text: string): void;
}

export interface ContentDeps {
  send(request: BackgroundRequest): Promise<BackgroundResponse | undefined>;
  post(message: ToPage): void;
  caller(): CallerInfo;
  ui: ContentUI;
}

export const NOT_ALLOWED_MESSAGE =
  "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.";

export function toastText(kind: ToastKind, userName: string): string {
  if (kind === "signed-in") return userName ? `已使用通行密钥登录 · ${userName}` : "已使用通行密钥登录";
  if (kind === "saved") return userName ? `通行密钥已保存 · ${userName}` : "通行密钥已保存";
  return "该账号的通行密钥已保存在 Passkey Box 中";
}

export function createContentRouter(deps: ContentDeps): { handle(message: ToContent): Promise<void> } {
  const active = new Set<string>();

  function reply(id: string, result: PageResult): void {
    if (!active.delete(id)) return;
    deps.post({ channel: PAGE_CHANNEL, dir: "to-page", kind: "response", id, result });
  }

  async function call(request: BackgroundRequest): Promise<BackgroundResponse> {
    try {
      const response = await deps.send(request);
      return response ?? { action: "error", message: "扩展后台没有响应，请刷新页面后重试。" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { action: "error", message: `无法连接扩展后台：${message}。请刷新页面后重试。` };
    }
  }

  async function handle(message: ToContent): Promise<void> {
    const { id } = message;
    if (message.kind === "abort") {
      active.delete(id);
      deps.ui.close(id);
      return;
    }
    if (active.has(id)) return;
    active.add(id);

    const caller = deps.caller();
    const op: Op = message.op;
    const request: BackgroundRequest =
      message.op === "create"
        ? { type: "pkb:create", caller, options: message.options }
        : { type: "pkb:get", caller, options: message.options, ...(message.mediation ? { mediation: message.mediation } : {}) };
    // The background derives the same rpId from the same request; dialogs only need it for display.
    const rpId = effectiveRpId(requestedRpId(message.options), caller.hostname);

    let response = await call(request);
    while (active.has(id)) {
      let choice: UiChoice;
      switch (response.action) {
        case "fallback":
          return reply(id, { type: "fallback" });
        case "success":
          deps.ui.toast(response.toast, toastText(response.toast, response.userName));
          return reply(id, { type: "success", credential: response.credential });
        case "reject":
          if (response.toast) deps.ui.toast(response.toast, toastText(response.toast, ""));
          return reply(id, { type: "error", name: response.name, message: response.message });
        case "pending":
          return; // stays active until the page aborts
        case "picker":
          choice = await deps.ui.showPicker(id, rpId, response.candidates);
          break;
        case "empty":
          choice = await deps.ui.showEmpty(id, rpId);
          break;
        case "error":
          choice = await deps.ui.showError(id, op, rpId, response.message);
          break;
      }
      if (!active.has(id) || choice.kind === "closed") return;
      if (choice.kind === "cancel") return reply(id, { type: "error", name: "NotAllowedError", message: NOT_ALLOWED_MESSAGE });
      if (choice.kind === "fallback") return reply(id, { type: "fallback" });
      if (request.type !== "pkb:get") return reply(id, { type: "error", name: "NotAllowedError", message: NOT_ALLOWED_MESSAGE });
      response = await call({ ...request, credentialId: choice.credentialId });
    }
  }

  return { handle };
}

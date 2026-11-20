// Trusted extension page. Only a click in this page may open its native WebAuthn prompt.

import { base64urlToBytes } from "./lib/base64url";
import { h } from "./ui/dom";
import { LOGO_FILE, logo } from "./ui/logo";

type Failure = { error: string };
type DeviceStatus = { enrolled: boolean };
type Enrollment = { challenge: string; userId: string };
type Verification = {
  challenge: string;
  credentialId: string;
  site: string;
  operation: "create" | "get";
};
type Outcome = { ok: boolean; error?: string };
type ViewState = "loading" | "ready" | "pending" | "enrolled" | "verified" | "cancelled" | "error";

const app = document.getElementById("app")!;
const query = new URLSearchParams(location.search);
const isVerification = query.has("request");
const heading = isVerification ? "使用受信设备验证" : "设置受信设备";
const message = h(document, "p", { id: "status", class: "status", role: "status", "aria-live": "polite" });
const requestDetails = h(document, "p", { hidden: "" });
const actions = h(document, "div", { class: "detail-actions" });
actions.style.alignItems = "center";
const back = h(document, "a", { class: "btn ghost", href: "options.html" }, "返回设置");

function setStatus(state: ViewState, copy: string): void {
  message.dataset.state = state;
  message.className = state === "error" ? "form-error" : state === "enrolled" || state === "verified" ? "status ok" : "status";
  message.textContent = copy;
}

function primary(id: string, label: string): HTMLButtonElement {
  const control = h(document, "button", { id, type: "button", class: "btn primary", disabled: "" }, label);
  actions.append(control);
  return control;
}

async function readResponse<T>(request: object): Promise<T> {
  const result = (await chrome.runtime.sendMessage(request)) as T | Failure | undefined;
  if (result === undefined || result === null || typeof result !== "object") {
    throw new Error("设备验证服务暂时不可用。");
  }
  if ("error" in result && typeof result.error === "string" && result.error) throw new Error(result.error);
  return result as T;
}

function credentialJSON(credential: Credential | null): ReturnType<PublicKeyCredential["toJSON"]> {
  if (!(credential instanceof PublicKeyCredential)) {
    throw new DOMException("浏览器未返回设备凭据。", "NotAllowedError");
  }
  if (typeof credential.toJSON !== "function") {
    throw new Error("此浏览器版本不支持发送原生设备凭据。");
  }
  return credential.toJSON();
}

function describe(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "设备验证未完成。";
}

function nativeCancelled(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
}

async function enroll(): Promise<void> {
  const enrollButton = primary("enroll", "添加受信设备");
  actions.append(back);

  try {
    const status = await readResponse<DeviceStatus>({ type: "pkb:device:status" });
    if (typeof status.enrolled !== "boolean") throw new Error("无法读取设备验证状态。");
    if (status.enrolled) {
      enrollButton.hidden = true;
      setStatus("enrolled", "当前浏览器已设置受信设备。");
      return;
    }
    setStatus("ready", "使用设备解锁或安全密钥。之后使用服务器上的通行密钥时，此浏览器会要求设备验证。");
    enrollButton.disabled = false;
  } catch (error) {
    setStatus("error", describe(error));
    return;
  }

  const controller = new AbortController();
  window.addEventListener("pagehide", () => controller.abort(), { once: true });
  enrollButton.addEventListener("click", (event) => {
    if (!event.isTrusted || enrollButton.disabled) return;
    enrollButton.disabled = true;
    setStatus("pending", "请在浏览器的设备验证提示中继续。");
    void (async () => {
      try {
        const options = await readResponse<Enrollment>({ type: "pkb:device:enroll-begin" });
        const credential = await navigator.credentials.create({
          signal: controller.signal,
          publicKey: {
            challenge: base64urlToBytes(options.challenge),
            rp: { name: "Passkey Box" },
            user: {
              id: base64urlToBytes(options.userId),
              name: "trusted-device",
              displayName: "Passkey Box 受信设备",
            },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { residentKey: "discouraged", userVerification: "required" },
            attestation: "none",
            timeout: 60_000,
          },
        });
        if (controller.signal.aborted) return;
        const result = await readResponse<Outcome>({
          type: "pkb:device:enroll-complete",
          credential: credentialJSON(credential),
        });
        if (result.ok !== true) throw new Error("未能注册受信设备。");
        enrollButton.hidden = true;
        setStatus("enrolled", "受信设备已设置。");
      } catch (error) {
        const cancelled = nativeCancelled(error);
        setStatus(cancelled ? "cancelled" : "error", cancelled ? "设备注册已取消。" : describe(error));
        enrollButton.disabled = false;
      }
    })();
  });
}

async function verify(requestId: string): Promise<void> {
  const verifyButton = primary("verify", "验证设备");
  const cancelButton = h(document, "button", { id: "cancel", class: "btn secondary", type: "button" }, "取消");
  actions.append(cancelButton);

  const controller = new AbortController();
  let phase: "loading" | "ready" | "prompt" | "submitting" | "finished" = "loading";
  let request: Verification;

  function cancel(state: "cancelled" | "error", copy: string): void {
    if (phase === "finished") return;
    phase = "finished";
    controller.abort();
    verifyButton.disabled = true;
    cancelButton.disabled = true;
    setStatus(state, copy);
    void chrome.runtime.sendMessage({ type: "pkb:device:cancel", requestId }).catch(() => {});
  }

  window.addEventListener("pagehide", () => {
    if (phase !== "submitting") cancel("cancelled", "验证已取消。");
  }, { once: true });

  cancelButton.addEventListener("click", (event) => {
    if (event.isTrusted && phase !== "submitting") cancel("cancelled", "验证已取消。你可以回到原网站。");
  });

  try {
    request = await readResponse<Verification>({ type: "pkb:device:request", requestId });
    if (controller.signal.aborted) return;
    if (!request.site || (request.operation !== "create" && request.operation !== "get")) {
      throw new Error("无法确认验证请求的来源。");
    }
    const site = h(document, "bdi", { id: "device-site", dir: "ltr" }, request.site);
    site.style.overflowWrap = "anywhere";
    requestDetails.replaceChildren(
      h(document, "strong", {}, site),
      request.operation === "create" ? " 请求创建通行密钥。" : " 请求使用通行密钥。",
    );
    requestDetails.hidden = false;
    phase = "ready";
    setStatus("ready", "确认网站后，用已注册的设备完成验证。");
    verifyButton.disabled = false;
  } catch (error) {
    cancel("error", describe(error));
    return;
  }

  verifyButton.addEventListener("click", (event) => {
    if (!event.isTrusted || phase !== "ready") return;
    phase = "prompt";
    verifyButton.disabled = true;
    setStatus("pending", "请完成浏览器的设备验证。");
    void (async () => {
      try {
        const credential = await navigator.credentials.get({
          signal: controller.signal,
          publicKey: {
            challenge: base64urlToBytes(request.challenge),
            allowCredentials: [{ type: "public-key", id: base64urlToBytes(request.credentialId) }],
            userVerification: "required",
            timeout: 60_000,
          },
        });
        if (phase !== "prompt") return;
        const json = credentialJSON(credential);
        phase = "submitting";
        cancelButton.disabled = true;
        const result = await readResponse<Outcome>({ type: "pkb:device:complete", requestId, credential: json });
        if (result.ok !== true) throw new Error("未能确认设备验证。");
        phase = "finished";
        setStatus("verified", "设备验证已完成。可以回到原网站。");
      } catch (error) {
        const cancelled = nativeCancelled(error);
        cancel(cancelled ? "cancelled" : "error", cancelled ? "验证已取消。你可以回到原网站。" : describe(error));
      }
    })();
  });
}

app.replaceChildren(
  h(document, "header", { class: "options-head" }, logo(document, "options-logo", LOGO_FILE), h(document, "h1", {}, "Passkey Box")),
  h(document, "section", { class: "card" }, h(document, "h2", {}, heading), requestDetails, message, actions),
);
setStatus("loading", isVerification ? "正在读取验证请求…" : "正在检查设备验证状态…");

if (window.top !== window.self) {
  setStatus("error", "请在单独的 Passkey Box 扩展页面中继续。");
} else if (!("PublicKeyCredential" in window) || !navigator.credentials) {
  setStatus("error", "此浏览器不支持原生设备验证。");
  if (!isVerification) actions.append(back);
} else if (isVerification) {
  const requestId = query.get("request");
  if (requestId) void verify(requestId);
  else setStatus("error", "此验证请求无效。请回到原网站重试。");
} else {
  void enroll();
}

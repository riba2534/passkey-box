import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { base64urlToBytes, bytesToBase64url } from "./base64url";

export const DEVICE_KEY = "pkb_device";
const TIMEOUT_MS = 90_000;

export interface DeviceOperation {
  site: string;
  operation: "create" | "get";
}

export type DeviceResult = "verified" | "not-enrolled" | "cancelled";

interface DeviceCredential {
  id: string;
  publicKey: string;
  counter: number;
}

interface Enrollment {
  challenge: string;
  documentId: string;
  expires: number;
}

interface Pending extends DeviceOperation {
  id: string;
  challenge: string;
  credential: DeviceCredential;
  windowId?: number;
  finish(approved: boolean): void;
}

type DeviceMessage =
  | { type: "pkb:device:status" }
  | { type: "pkb:device:enroll-begin" }
  | { type: "pkb:device:enroll-complete"; credential: RegistrationResponseJSON }
  | { type: "pkb:device:request" | "pkb:device:cancel"; requestId: string }
  | { type: "pkb:device:complete"; requestId: string; credential: AuthenticationResponseJSON };

function randomChallenge(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isDeviceMessage(value: unknown): value is DeviceMessage {
  const type = (value as { type?: unknown } | null)?.type;
  return typeof type === "string" && type.startsWith("pkb:device:");
}

export class DeviceVerification {
  private readonly page = chrome.runtime.getURL("device.html");
  // Chromium uses the serialized extension origin as the default RP ID.
  private readonly origin = this.page.slice(0, this.page.lastIndexOf("/"));
  private enrollment: Enrollment | undefined;
  private enrolling = false;
  private checking = false;
  private pending: Pending | undefined;

  constructor() {
    chrome.windows.onRemoved.addListener((windowId) => {
      if (this.pending?.windowId === windowId) this.pending.finish(false);
    });
  }

  private async getCredential(): Promise<DeviceCredential | undefined> {
    return (await chrome.storage.local.get(DEVICE_KEY))[DEVICE_KEY] as DeviceCredential | undefined;
  }

  async authorize(operation: DeviceOperation, signal: AbortSignal): Promise<DeviceResult> {
    if (signal.aborted || this.pending || this.checking) return "cancelled";
    const credential = await this.getCredential();
    if (signal.aborted || this.pending || this.checking) return "cancelled";
    if (!credential) return "not-enrolled";
    const id = randomChallenge();
    const approved = await new Promise<boolean>((resolve) => {
      const finish = (verified: boolean) => {
        if (this.pending !== request) return;
        this.pending = undefined;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (request.windowId !== undefined) void chrome.windows.remove(request.windowId).catch(() => undefined);
        resolve(verified);
      };
      const cancel = () => finish(false);
      const request: Pending = { ...operation, id, challenge: randomChallenge(), credential, finish };
      this.pending = request;
      const timer = setTimeout(cancel, TIMEOUT_MS);
      signal.addEventListener("abort", cancel, { once: true });

      void chrome.windows.create({ url: this.requestURL(id), type: "popup", width: 440, height: 415, focused: true }).then(
        (window) => {
          if (this.pending === request && window?.id !== undefined) request.windowId = window.id;
          else if (window?.id !== undefined) void chrome.windows.remove(window.id).catch(() => undefined);
          else cancel();
        },
        cancel,
      );
    });
    return approved && !signal.aborted ? "verified" : "cancelled";
  }

  private requestURL(id: string): string {
    return `${this.page}?request=${id}`;
  }

  async handle(message: DeviceMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.documentId) return undefined;
    switch (message.type) {
      case "pkb:device:status":
        if (sender.url !== this.page && sender.url !== chrome.runtime.getURL("options.html")) return undefined;
        return { enrolled: !!(await this.getCredential()) };
      case "pkb:device:enroll-begin":
      case "pkb:device:enroll-complete":
        if (sender.url !== this.page) return undefined;
        return message.type === "pkb:device:enroll-begin"
          ? this.beginEnrollment(sender.documentId)
          : this.completeEnrollment(sender.documentId, message.credential);
      case "pkb:device:request":
      case "pkb:device:cancel":
      case "pkb:device:complete": {
        const request = this.pending;
        if (!request || request.id !== message.requestId || sender.url !== this.requestURL(request.id)) {
          return { ok: false, error: "验证请求已失效，请回到网站重试。" };
        }
        if (message.type === "pkb:device:request") {
          return {
            challenge: request.challenge,
            credentialId: request.credential.id,
            site: request.site,
            operation: request.operation,
          };
        }
        if (message.type === "pkb:device:cancel") {
          request.finish(false);
          return { ok: true };
        }
        if (message.type === "pkb:device:complete") return this.completeRequest(request, message.credential);
        return undefined;
      }
    }
  }

  private async beginEnrollment(documentId: string): Promise<unknown> {
    if ((await this.getCredential()) || this.enrolling) return { error: "此浏览器已设置设备验证。" };
    const challenge = randomChallenge();
    this.enrollment = { challenge, documentId, expires: Date.now() + TIMEOUT_MS };
    return { challenge, userId: randomChallenge() };
  }

  private async completeEnrollment(documentId: string, response: RegistrationResponseJSON): Promise<unknown> {
    const enrollment = this.enrollment;
    if (!enrollment || enrollment.documentId !== documentId || enrollment.expires <= Date.now() || this.enrolling) {
      return { ok: false, error: "设备设置请求已失效，请重试。" };
    }
    this.enrollment = undefined;
    this.enrolling = true;
    try {
      if (await this.getCredential()) return { ok: false, error: "此浏览器已设置设备验证。" };
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: enrollment.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.origin,
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7],
      });
      if (!result.verified || !result.registrationInfo.userVerified) {
        return { ok: false, error: "设备未完成用户验证。" };
      }
      const { id, publicKey, counter } = result.registrationInfo.credential;
      await chrome.storage.local.set({ [DEVICE_KEY]: { id, publicKey: bytesToBase64url(publicKey), counter } });
      return { ok: true };
    } catch {
      return { ok: false, error: "无法验证设备返回的注册凭据，请重试。" };
    } finally {
      this.enrolling = false;
    }
  }

  private async completeRequest(request: Pending, response: AuthenticationResponseJSON): Promise<unknown> {
    if (this.checking) return { ok: false, error: "该验证请求已提交。" };
    this.checking = true;
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: request.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.origin,
        credential: {
          id: request.credential.id,
          publicKey: base64urlToBytes(request.credential.publicKey),
          counter: request.credential.counter,
        },
        requireUserVerification: true,
      });
      if (this.pending !== request || !result.verified || !result.authenticationInfo.userVerified) {
        request.finish(false);
        return { ok: false, error: "设备未完成本次用户验证。" };
      }
      await chrome.storage.local.set({
        [DEVICE_KEY]: { ...request.credential, counter: result.authenticationInfo.newCounter },
      });
      if (this.pending !== request) return { ok: false, error: "本次验证已取消。" };
      request.finish(true);
      return { ok: true };
    } catch {
      request.finish(false);
      return { ok: false, error: "无法验证设备返回的签名，请回到网站重试。" };
    } finally {
      this.checking = false;
    }
  }
}

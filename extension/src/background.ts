import { describeError, ServerClient } from "./lib/api";
import { isHttpOrigin } from "./lib/caller";
import { CONFIG_KEY } from "./lib/config";
import { DeviceVerification, isDeviceMessage } from "./lib/device-verification";
import { handleRequest } from "./lib/handler";
import type { BackgroundRequest, BackgroundResponse } from "./lib/protocol";
import { loadConfig, loadSettings } from "./lib/storage";

const device = new DeviceVerification();
const tasks = new Map<string, { tabId: number; controller: AbortController }>();
const trustedStorage = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

function abortTabTasks(tabId?: number): void {
  for (const task of tasks.values()) {
    if (tabId === undefined || task.tabId === tabId) task.controller.abort();
  }
}

chrome.tabs.onRemoved.addListener((tabId) => abortTabTasks(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" || change.url) abortTabTasks(tabId);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && CONFIG_KEY in changes) abortTabTasks();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, reply: (response?: unknown) => void) => {
  if (isDeviceMessage(message)) {
    void trustedStorage.then(() => device.handle(message, sender)).then(reply, () => {
      reply({ ok: false, error: "设备验证暂不可用，请重试。" });
    });
    return true;
  }

  const request = message as (BackgroundRequest | { type: "pkb:abort" }) & { requestId?: string };
  if (request?.type !== "pkb:create" && request?.type !== "pkb:get" && request?.type !== "pkb:abort") return false;
  const tabId = sender.tab?.id;
  const origin = sender.origin;
  // Let Chromium enforce Permissions Policy and cross-origin WebAuthn rules in subframes.
  if (tabId === undefined || sender.frameId !== 0 || !sender.documentId || !origin || !isHttpOrigin(origin) ||
      typeof request.requestId !== "string" || request.requestId.length === 0 || request.requestId.length > 128) {
    reply({ action: "fallback" } satisfies BackgroundResponse);
    return false;
  }
  const key = `${sender.documentId}:${request.requestId}`;
  if (request.type === "pkb:abort") {
    tasks.get(key)?.controller.abort();
    reply();
    return false;
  }
  if ((request.type === "pkb:get" && request.mediation === "conditional" && !sender.tab?.active) || tasks.has(key)) {
    reply({ action: "pending" } satisfies BackgroundResponse);
    return false;
  }

  const controller = new AbortController();
  tasks.set(key, { tabId, controller });
  const caller = { origin, hostname: new URL(origin).hostname, crossOrigin: false };
  void trustedStorage.then(() => handleRequest({ ...request, caller }, {
    loadConfig,
    loadSettings,
    store: (config) => new ServerClient(config),
    authorize: (operation) => device.authorize(operation, controller.signal),
    signal: controller.signal,
  })).then(reply, (error: unknown) => {
    reply({ action: "error", message: describeError(error) } satisfies BackgroundResponse);
  }).finally(() => tasks.delete(key));
  return true;
});

import { describeError, ServerClient } from "./lib/api";
import { isHttpOrigin } from "./lib/caller";
import { CONFIG_KEY, type Config } from "./lib/config";
import { handleRequest } from "./lib/handler";
import { applyManagedConfig, MANAGED_CONFIG_FILE, readManagedConfig, sameConfig } from "./lib/managed";
import type { BackgroundRequest, BackgroundResponse } from "./lib/protocol";
import { loadConfig, loadOwned, loadPolicy, loadSettings, rememberOwned, saveConfig, savePolicy } from "./lib/storage";

const tasks = new Map<string, { tabId: number; controller: AbortController }>();
const trustedStorage = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let managedConfig: Config | null = null;
// Requests wait until a managed account and policy (managed-config.json) have been stored.
const ready = trustedStorage
  .then(() => readManagedConfig(chrome.runtime.getURL(MANAGED_CONFIG_FILE)))
  .then((managed) => {
    managedConfig = managed?.account ?? null;
    return managed && applyManagedConfig(managed, { loadConfig, saveConfig, loadPolicy, savePolicy });
  })
  .catch(() => undefined);

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
  if (area !== "local" || !(CONFIG_KEY in changes)) return;
  // Signing in with the managed account at startup must not cancel requests waiting for it.
  if (managedConfig && sameConfig(changes[CONFIG_KEY]?.newValue, managedConfig)) return;
  abortTabTasks();
});

chrome.runtime.onMessage.addListener((message: unknown, sender, reply: (response?: unknown) => void) => {
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
  void ready.then(() => handleRequest({ ...request, caller }, {
    loadConfig,
    loadSettings,
    loadPolicy,
    store: (config) => new ServerClient(config),
    owned: { load: loadOwned, remember: rememberOwned },
    signal: controller.signal,
  })).then(reply, (error: unknown) => {
    reply({ action: "error", message: describeError(error) } satisfies BackgroundResponse);
  }).finally(() => tasks.delete(key));
  return true;
});

// Service worker: reads config, talks to the Passkey Box server, generates keys and signs.

import { describeError, ServerClient } from "./lib/api";
import { handleRequest } from "./lib/handler";
import type { BackgroundRequest, BackgroundResponse } from "./lib/protocol";
import { loadConfig, loadSettings } from "./lib/storage";

function isBackgroundRequest(message: unknown): message is BackgroundRequest {
  const type = (message as { type?: unknown } | null)?.type;
  return type === "pkb:create" || type === "pkb:get";
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (r: BackgroundResponse) => void) => {
  if (!isBackgroundRequest(message)) return false;
  handleRequest(message, {
    loadConfig,
    loadSettings,
    store: (config) => new ServerClient(config),
  }).then(sendResponse, (err: unknown) => {
    sendResponse({ action: "error", rpId: "", message: describeError(err) });
  });
  return true;
});

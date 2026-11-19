// ISOLATED world, document_start: relays page requests to the background and renders the in-page UI.

import { callerInfo } from "./lib/caller";
import type { BackgroundRequest, BackgroundResponse } from "./lib/protocol";
import { isToContent } from "./lib/protocol";
import { createContentRouter } from "./lib/router";
import { createPageUI } from "./ui/page-ui";

if (window.isSecureContext) {
  const router = createContentRouter({
    send: (request: BackgroundRequest) => chrome.runtime.sendMessage<BackgroundRequest, BackgroundResponse>(request),
    post: (message) => window.postMessage(message, "*"),
    caller: () => callerInfo(location, window.origin),
    ui: createPageUI(document),
  });
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || !isToContent(event.data)) return;
    void router.handle(event.data);
  });
}

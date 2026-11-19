// MAIN world, document_start: replaces navigator.credentials.create/get for the page.

import { installInterceptor, type PageGlobals } from "./lib/interceptor";
import { isToPage, type ToContent, type ToPage } from "./lib/protocol";

(() => {
  if (typeof CredentialsContainer === "undefined" || typeof PublicKeyCredential === "undefined") return;
  const post = window.postMessage.bind(window);
  const addListener = window.addEventListener.bind(window);
  const self = window;

  installInterceptor(window as unknown as PageGlobals, {
    send(message: ToContent) {
      post(message, "*");
    },
    onMessage(handler: (message: ToPage) => void) {
      addListener("message", (event: MessageEvent) => {
        if (event.source === self && isToPage(event.data)) handler(event.data);
      });
    },
  });
})();

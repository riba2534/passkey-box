// Brand logo, generated from docs/brand/icon-master.png by scripts/make-icons.py.

import { h } from "./dom";

/** Extension pages (popup, options) load this file from the package. */
export const LOGO_FILE = "icons/logo-128.png";

export function logo(doc: Document, className: string, src: string): HTMLImageElement {
  return h(doc, "img", { class: className, src, alt: "", draggable: "false" });
}

// Icon geometry shared by the in-page UI, popup and options page.

import type { IconSpec } from "./dom";

export const BRAND_BLUE = "#0572EC";

export const CHECK: IconSpec = {
  viewBox: "0 0 24 24",
  shapes: [
    ["circle", { cx: 12, cy: 12, r: 11, fill: "#1A9F5B" }],
    ["path", { d: "M7 12.5l3.2 3.2L17 9", fill: "none", stroke: "#fff", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" }],
  ],
};

export const INFO: IconSpec = {
  viewBox: "0 0 24 24",
  shapes: [
    ["circle", { cx: 12, cy: 12, r: 11, fill: BRAND_BLUE }],
    ["rect", { x: 10.8, y: 10.5, width: 2.4, height: 7, rx: 1.2, fill: "#fff" }],
    ["circle", { cx: 12, cy: 7.2, r: 1.5, fill: "#fff" }],
  ],
};

export const WARNING: IconSpec = {
  viewBox: "0 0 24 24",
  shapes: [
    ["circle", { cx: 12, cy: 12, r: 11, fill: "#E5484D" }],
    ["rect", { x: 10.8, y: 5.8, width: 2.4, height: 8, rx: 1.2, fill: "#fff" }],
    ["circle", { cx: 12, cy: 17.4, r: 1.5, fill: "#fff" }],
  ],
};

export const KEY_OUTLINE: IconSpec = {
  viewBox: "0 0 24 24",
  shapes: [
    ["circle", { cx: 8, cy: 12, r: 4.5, fill: "none", stroke: "currentColor", "stroke-width": 1.8 }],
    ["path", { d: "M12.5 12H21M18 12v3.5M15.2 12v2.5", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round" }],
  ],
};

export const CHEVRON: IconSpec = {
  viewBox: "0 0 24 24",
  shapes: [["path", { d: "M9 6l6 6-6 6", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }]],
};

export const BACK: IconSpec = {
  viewBox: "0 0 24 24",
  shapes: [["path", { d: "M15 6l-6 6 6 6", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }]],
};

export const SEARCH: IconSpec = {
  viewBox: "0 0 24 24",
  shapes: [
    ["circle", { cx: 11, cy: 11, r: 6.5, fill: "none", stroke: "currentColor", "stroke-width": 2 }],
    ["path", { d: "M16 16l4.5 4.5", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }],
  ],
};

export const GEAR: IconSpec = {
  viewBox: "0 0 24 24",
  shapes: [
    ["circle", { cx: 12, cy: 12, r: 3, fill: "none", stroke: "currentColor", "stroke-width": 1.8 }],
    [
      "path",
      {
        d: "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.8,
        "stroke-linejoin": "round",
      },
    ],
  ],
};

// Coloured letter avatars, 1Password style.

import { h } from "./dom";

export const AVATAR_COLORS = [
  "#0572EC",
  "#7B61FF",
  "#E5484D",
  "#F76B15",
  "#12A594",
  "#D6409F",
  "#3E63DD",
  "#8E4EC6",
  "#0090FF",
  "#30A46C",
] as const;

export function avatarColor(seed: string): string {
  let hash = 0;
  for (const ch of seed.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export function avatarLetter(text: string): string {
  const first = Array.from(text.trim())[0];
  return first ? first.toUpperCase() : "?";
}

export function avatar(doc: Document, seed: string, label: string, className = "avatar"): HTMLElement {
  const el = h(doc, "span", { class: className }, avatarLetter(label));
  el.style.backgroundColor = avatarColor(seed);
  return el;
}

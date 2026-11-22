// Pure helpers behind the popup's credential list and detail views.

import { sharedBy, type Credential } from "./api";
import { hostMatchesRpId } from "./rpid";

export function credentialTitle(c: Pick<Credential, "rp_name" | "rp_id">): string {
  return c.rp_name.trim() || c.rp_id;
}

/** The list row's subtitle. */
export function accountName(c: Pick<Credential, "user_name" | "user_display_name">): string {
  return c.user_name || c.user_display_name || "（无用户名）";
}

/** "共享自 <owner>" after the subtitle of a passkey another user shared; null for the user's own. */
export function sharedLabel(c: Pick<Credential, "access" | "owner">): string | null {
  const owner = sharedBy(c);
  return owner === undefined ? null : `共享自 ${owner}`;
}

/** Rows of the detail view; a shared passkey also names its owner. */
export function detailFields(c: Credential): Array<[string, string]> {
  const owner = sharedBy(c);
  return [
    ["网站", c.rp_id],
    ["用户名", c.user_name || "—"],
    ["显示名", c.user_display_name || "—"],
    ...(owner === undefined ? [] : [["所有者", owner] as [string, string]]),
    ["创建时间", formatTime(c.created_at, "—")],
    ["最近使用", formatTime(c.last_used_at)],
  ];
}

export interface RemoveAction {
  label: string;
  done: string;
  failed: string;
}

/** DELETE /credentials/{id} deletes the user's own passkey but only leaves a shared one. */
export function removeAction(c: Pick<Credential, "access">): RemoveAction {
  return c.access === "shared"
    ? { label: "移除共享", done: "已移除共享", failed: "移除共享失败" }
    : { label: "删除", done: "已删除通行密钥", failed: "删除失败" };
}

/** Hostname of an http(s) tab URL, or "" for chrome://, file:, about: and invalid URLs. */
export function tabHostname(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : "";
  } catch {
    return "";
  }
}

export function matchesQuery(c: Credential, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [c.rp_id, c.rp_name, c.user_name, c.user_display_name, c.label].some((f) => (f ?? "").toLowerCase().includes(q));
}

export interface PopupGroups {
  /** Credentials usable on the current tab (hostname equals rp_id or ends with "." + rp_id). */
  current: Credential[];
  all: Credential[];
}

export function groupCredentials(credentials: Credential[], hostname: string, query: string): PopupGroups {
  const all = credentials.filter((c) => matchesQuery(c, query));
  const current = hostname ? all.filter((c) => hostMatchesRpId(hostname, c.rp_id)) : [];
  return { current, all };
}

/** URL opened by "打开网站": the registration origin, else https://<rp_id>. */
export function siteUrl(c: Pick<Credential, "origin" | "rp_id">): string {
  if (c.origin && /^https?:\/\//i.test(c.origin)) return c.origin;
  return `https://${c.rp_id}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** RFC 3339 → "YYYY-MM-DD HH:mm" in local time; null → fallback text. */
export function formatTime(value: string | null | undefined, empty = "从未使用"): string {
  if (!value) return empty;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

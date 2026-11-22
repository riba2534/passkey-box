// Managed sign-in: a launcher that loads an unpacked copy of the extension (such as AnyBrowser)
// can place managed-config.json next to manifest.json. At startup the extension stores the
// launcher's sign-in policy from the file and, when the file holds a complete account, signs in
// with it, replacing any stored account. A file with only the policy keeps the stored account, so
// a profile whose launcher account was removed keeps its last account under the launcher's
// policy. A missing file, or one that is not a JSON object, leaves both as they were; signing out
// keeps the policy.

import { isConfigComplete, normalizeServerUrl, type Config } from "./config";

export const MANAGED_CONFIG_FILE = "managed-config.json";
export const MANAGED_KEY = "pkb_managed";

/**
 * any        – automatic sign-in as the settings allow
 * owned-only – only with a passkey this browser profile registered or used; other accounts are
 *              chosen in the picker once, which records them for this profile
 */
export type AutoLoginPolicy = "any" | "owned-only";

/** What the launcher decides besides the account, kept in chrome.storage.local under MANAGED_KEY. */
export interface ManagedPolicy {
  autoLogin: AutoLoginPolicy;
}

export interface ManagedConfig {
  /** null when the file holds no complete account: nothing to sign in with. */
  account: Config | null;
  policy: ManagedPolicy;
}

/** Reads the policy fields of managed-config.json or of the stored copy; missing or unknown values mean "any". */
export function normalizePolicy(value: unknown): ManagedPolicy {
  const fields = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { autoLogin: fields["autoLogin"] === "owned-only" ? "owned-only" : "any" };
}

type FetchFile = (url: string) => Promise<Pick<Response, "ok" | "json">>;

/** The account in managed-config.json, or null unless all three fields are usable. */
function managedAccount(fields: Record<string, unknown>): Config | null {
  const account = {
    serverUrl: typeof fields["serverUrl"] === "string" ? normalizeServerUrl(fields["serverUrl"]) : "",
    username: typeof fields["username"] === "string" ? fields["username"].trim() : "",
    password: typeof fields["password"] === "string" ? fields["password"] : "",
  };
  if (!isConfigComplete(account)) return null;
  try {
    const { protocol } = new URL(account.serverUrl);
    if (protocol !== "http:" && protocol !== "https:") return null;
  } catch {
    return null;
  }
  return account;
}

/** Reads the managed policy and account; a missing file or one that is not a JSON object yields null. */
export async function readManagedConfig(url: string, fetchFile: FetchFile = (u) => fetch(u, { cache: "no-store" })): Promise<ManagedConfig | null> {
  let value: unknown;
  try {
    const response = await fetchFile(url);
    if (!response.ok) return null;
    value = await response.json();
  } catch {
    // Chromium rejects requests for files the extension package does not contain.
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  return { account: managedAccount(fields), policy: normalizePolicy(fields) };
}

export function sameConfig(a: unknown, b: Config): boolean {
  return isConfigComplete(a) && a.serverUrl === b.serverUrl && a.username === b.username && a.password === b.password;
}

/** Stores the managed policy, and the account if there is one, unless already stored. Returns whether it saved. */
export async function applyManagedConfig(
  managed: ManagedConfig,
  storage: {
    loadConfig(): Promise<Config | null>;
    saveConfig(config: Config): Promise<void>;
    loadPolicy(): Promise<ManagedPolicy>;
    savePolicy(policy: ManagedPolicy): Promise<void>;
  },
): Promise<boolean> {
  const [config, policy] = await Promise.all([storage.loadConfig(), storage.loadPolicy()]);
  const writes: Array<Promise<void>> = [];
  if (managed.account && !sameConfig(config, managed.account)) writes.push(storage.saveConfig(managed.account));
  if (policy.autoLogin !== managed.policy.autoLogin) writes.push(storage.savePolicy(managed.policy));
  await Promise.all(writes);
  return writes.length > 0;
}

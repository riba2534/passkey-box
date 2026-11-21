// Managed sign-in: a launcher that loads an unpacked copy of the extension (such as AnyBrowser)
// can place managed-config.json next to manifest.json. When the file holds a complete account,
// the extension signs in with it at startup, replacing any stored account.

import { isConfigComplete, normalizeServerUrl, type Config } from "./config";

export const MANAGED_CONFIG_FILE = "managed-config.json";

type FetchFile = (url: string) => Promise<Pick<Response, "ok" | "json">>;

/** Reads the managed account; a missing, unreadable or incomplete file yields null. */
export async function readManagedConfig(url: string, fetchFile: FetchFile = (u) => fetch(u, { cache: "no-store" })): Promise<Config | null> {
  let value: unknown;
  try {
    const response = await fetchFile(url);
    if (!response.ok) return null;
    value = await response.json();
  } catch {
    // Chromium rejects requests for files the extension package does not contain.
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  const config = {
    serverUrl: typeof fields["serverUrl"] === "string" ? normalizeServerUrl(fields["serverUrl"]) : "",
    username: typeof fields["username"] === "string" ? fields["username"].trim() : "",
    password: typeof fields["password"] === "string" ? fields["password"] : "",
  };
  if (!isConfigComplete(config)) return null;
  try {
    const { protocol } = new URL(config.serverUrl);
    if (protocol !== "http:" && protocol !== "https:") return null;
  } catch {
    return null;
  }
  return config;
}

export function sameConfig(a: unknown, b: Config): boolean {
  return isConfigComplete(a) && a.serverUrl === b.serverUrl && a.username === b.username && a.password === b.password;
}

/** Stores the managed account unless it is already the stored one. Returns whether it saved. */
export async function applyManagedConfig(
  managed: Config,
  storage: { loadConfig(): Promise<Config | null>; saveConfig(config: Config): Promise<void> },
): Promise<boolean> {
  if (sameConfig(await storage.loadConfig(), managed)) return false;
  await storage.saveConfig(managed);
  return true;
}

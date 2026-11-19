// Extension configuration shapes and pure helpers (storage access lives in storage.ts).

export const CONFIG_KEY = "pkb_config";
export const SETTINGS_KEY = "pkb_settings";

export interface Config {
  serverUrl: string;
  username: string;
  password: string;
}

export interface Settings {
  /** 只匹配到一个时自动登录 */
  autoLoginSingle: boolean;
  /** 页面打开时自动登录 */
  conditionalAutoLogin: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  autoLoginSingle: true,
  conditionalAutoLogin: true,
});

/** Trims, adds https:// when no scheme is present, and drops trailing slashes. */
export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  if (!url) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "https://" + url;
  return url.replace(/\/+$/, "");
}

/** A config is usable only when all three fields are non-empty strings. */
export function isConfigComplete(value: unknown): value is Config {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return [c["serverUrl"], c["username"], c["password"]].every((v) => typeof v === "string" && v !== "");
}

/** Missing or non-boolean settings fall back to true. */
export function normalizeSettings(value: unknown): Settings {
  const s = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    autoLoginSingle: typeof s["autoLoginSingle"] === "boolean" ? s["autoLoginSingle"] : DEFAULT_SETTINGS.autoLoginSingle,
    conditionalAutoLogin:
      typeof s["conditionalAutoLogin"] === "boolean" ? s["conditionalAutoLogin"] : DEFAULT_SETTINGS.conditionalAutoLogin,
  };
}

// chrome.storage.local access for pkb_config / pkb_settings (CONTRACT 4.3).

import { CONFIG_KEY, SETTINGS_KEY, isConfigComplete, normalizeSettings, type Config, type Settings } from "./config";

export async function loadConfig(): Promise<Config | null> {
  const value = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY];
  return isConfigComplete(value) ? { serverUrl: value.serverUrl, username: value.username, password: value.password } : null;
}

export async function saveConfig(config: Config): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
}

export async function clearConfig(): Promise<void> {
  await chrome.storage.local.remove(CONFIG_KEY);
}

export async function loadSettings(): Promise<Settings> {
  return normalizeSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isConfigComplete, normalizeServerUrl, normalizeSettings } from "../src/lib/config";

describe("normalizeServerUrl", () => {
  it.each([
    ["", ""],
    ["   ", ""],
    ["https://pk.example.com", "https://pk.example.com"],
    ["  https://pk.example.com/  ", "https://pk.example.com"],
    ["https://pk.example.com///", "https://pk.example.com"],
    ["pk.example.com", "https://pk.example.com"],
    ["pk.example.com:8443/", "https://pk.example.com:8443"],
    ["localhost:8080", "https://localhost:8080"],
    ["http://127.0.0.1:18411", "http://127.0.0.1:18411"],
    ["HTTP://Example.com/base/", "HTTP://Example.com/base"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });
});

describe("isConfigComplete", () => {
  it("requires three non-empty strings", () => {
    expect(isConfigComplete({ serverUrl: "http://a", username: "u", password: "p" })).toBe(true);
    expect(isConfigComplete({ serverUrl: "http://a", username: "u", password: "" })).toBe(false);
    expect(isConfigComplete({ serverUrl: "http://a", username: "u" })).toBe(false);
    expect(isConfigComplete({ serverUrl: 1, username: "u", password: "p" })).toBe(false);
    expect(isConfigComplete(undefined)).toBe(false);
    expect(isConfigComplete("x")).toBe(false);
  });
});

describe("normalizeSettings", () => {
  it("defaults missing values to true", () => {
    expect(DEFAULT_SETTINGS).toEqual({ autoLoginSingle: true, conditionalAutoLogin: true });
    expect(normalizeSettings(undefined)).toEqual({ autoLoginSingle: true, conditionalAutoLogin: true });
    expect(normalizeSettings({})).toEqual({ autoLoginSingle: true, conditionalAutoLogin: true });
    expect(normalizeSettings({ autoLoginSingle: false })).toEqual({ autoLoginSingle: false, conditionalAutoLogin: true });
    expect(normalizeSettings({ conditionalAutoLogin: false, autoLoginSingle: "no" })).toEqual({
      autoLoginSingle: true,
      conditionalAutoLogin: false,
    });
  });
});

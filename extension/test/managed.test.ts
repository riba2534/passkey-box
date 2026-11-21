import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/lib/config";
import { applyManagedConfig, readManagedConfig, sameConfig } from "../src/lib/managed";

const file = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });
const account: Config = { serverUrl: "https://pk.example.com", username: "alice", password: "pw" };

describe("readManagedConfig", () => {
  it("normalizes a complete account", async () => {
    const read = await readManagedConfig("x", file({ serverUrl: " pk.example.com/ ", username: " alice ", password: "pw" }));
    expect(read).toEqual(account);
  });

  it("ignores a missing file", async () => {
    expect(await readManagedConfig("x", async () => Promise.reject(new TypeError("Failed to fetch")))).toBeNull();
    expect(await readManagedConfig("x", file({}, false))).toBeNull();
  });

  it("ignores malformed or incomplete content", async () => {
    const broken = async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError("bad json")) });
    expect(await readManagedConfig("x", broken)).toBeNull();
    expect(await readManagedConfig("x", file(null))).toBeNull();
    expect(await readManagedConfig("x", file("text"))).toBeNull();
    expect(await readManagedConfig("x", file({ serverUrl: "https://pk.example.com", username: "alice" }))).toBeNull();
    expect(await readManagedConfig("x", file({ serverUrl: "https://pk.example.com", username: " ", password: "pw" }))).toBeNull();
    expect(await readManagedConfig("x", file({ serverUrl: "https://pk.example.com", username: "alice", password: 1 }))).toBeNull();
  });

  it("accepts only http(s) servers", async () => {
    expect(await readManagedConfig("x", file({ ...account, serverUrl: "ftp://pk.example.com" }))).toBeNull();
    expect(await readManagedConfig("x", file({ ...account, serverUrl: "http://exa mple" }))).toBeNull();
    expect(await readManagedConfig("x", file({ ...account, serverUrl: "http://127.0.0.1:8080" }))).toEqual({
      ...account,
      serverUrl: "http://127.0.0.1:8080",
    });
  });
});

describe("applyManagedConfig", () => {
  it("saves when nothing or a different account is stored", async () => {
    for (const stored of [null, { ...account, password: "old" }, { ...account, username: "bob" }]) {
      const saveConfig = vi.fn(async () => undefined);
      expect(await applyManagedConfig(account, { loadConfig: async () => stored, saveConfig })).toBe(true);
      expect(saveConfig).toHaveBeenCalledWith(account);
    }
  });

  it("leaves an identical stored account alone", async () => {
    const saveConfig = vi.fn(async () => undefined);
    expect(await applyManagedConfig(account, { loadConfig: async () => ({ ...account }), saveConfig })).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("sameConfig compares every field", () => {
    expect(sameConfig({ ...account }, account)).toBe(true);
    expect(sameConfig({ ...account, serverUrl: "https://other" }, account)).toBe(false);
    expect(sameConfig(undefined, account)).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/lib/config";
import { applyManagedConfig, normalizePolicy, readManagedConfig, sameConfig, type ManagedPolicy } from "../src/lib/managed";

const file = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });
const account: Config = { serverUrl: "https://pk.example.com", username: "alice", password: "pw" };
const any: ManagedPolicy = { autoLogin: "any" };
const ownedOnly: ManagedPolicy = { autoLogin: "owned-only" };

describe("readManagedConfig", () => {
  it("normalizes a complete account", async () => {
    const read = await readManagedConfig("x", file({ serverUrl: " pk.example.com/ ", username: " alice ", password: "pw" }));
    expect(read).toEqual({ account, policy: any });
  });

  it("reads the autoLogin policy; missing or unknown values mean any", async () => {
    const policyOf = async (fields: Record<string, unknown>) => (await readManagedConfig("x", file({ ...account, ...fields })))?.policy;
    expect(await policyOf({ autoLogin: "owned-only" })).toEqual(ownedOnly);
    expect(await policyOf({ autoLogin: "any" })).toEqual(any);
    expect(await policyOf({})).toEqual(any);
    for (const autoLogin of ["Owned-Only", "owned_only", " owned-only", "none", "", true, 1, null, ["owned-only"], { autoLogin: "owned-only" }]) {
      expect(await policyOf({ autoLogin })).toEqual(any);
    }
  });

  it("reads the policy without a complete account", async () => {
    // AnyBrowser writes only the policy for a profile without an account (0.4.0 ignored such a file).
    expect(await readManagedConfig("x", file({ autoLogin: "owned-only" }))).toEqual({ account: null, policy: ownedOnly });
    expect(await readManagedConfig("x", file({ ...account, password: "", autoLogin: "owned-only" }))).toEqual({
      account: null,
      policy: ownedOnly,
    });
    expect(await readManagedConfig("x", file({ autoLogin: "unknown" }))).toEqual({ account: null, policy: any });
    expect(await readManagedConfig("x", file({}))).toEqual({ account: null, policy: any });
  });

  it("ignores a missing file", async () => {
    expect(await readManagedConfig("x", async () => Promise.reject(new TypeError("Failed to fetch")))).toBeNull();
    expect(await readManagedConfig("x", file({}, false))).toBeNull();
  });

  it("ignores content that is not a JSON object", async () => {
    const broken = async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError("bad json")) });
    expect(await readManagedConfig("x", broken)).toBeNull();
    expect(await readManagedConfig("x", file(null))).toBeNull();
    expect(await readManagedConfig("x", file("text"))).toBeNull();
    expect(await readManagedConfig("x", file([{ ...account, autoLogin: "owned-only" }]))).toBeNull();
  });

  it("has no account to sign in with when it is incomplete", async () => {
    const accountOf = async (fields: unknown) => (await readManagedConfig("x", file(fields)))?.account;
    expect(await accountOf({ serverUrl: "https://pk.example.com", username: "alice" })).toBeNull();
    expect(await accountOf({ serverUrl: "https://pk.example.com", username: " ", password: "pw" })).toBeNull();
    expect(await accountOf({ serverUrl: "https://pk.example.com", username: "alice", password: 1 })).toBeNull();
  });

  it("accepts only http(s) servers", async () => {
    expect((await readManagedConfig("x", file({ ...account, serverUrl: "ftp://pk.example.com" })))?.account).toBeNull();
    expect((await readManagedConfig("x", file({ ...account, serverUrl: "http://exa mple" })))?.account).toBeNull();
    expect((await readManagedConfig("x", file({ ...account, serverUrl: "http://127.0.0.1:8080" })))?.account).toEqual({
      ...account,
      serverUrl: "http://127.0.0.1:8080",
    });
  });
});

describe("normalizePolicy", () => {
  it("reads the stored policy the same way", () => {
    expect(normalizePolicy({ autoLogin: "owned-only" })).toEqual(ownedOnly);
    expect(normalizePolicy({ autoLogin: "any" })).toEqual(any);
    for (const stored of [undefined, null, "owned-only", [], {}, { autoLogin: "other" }]) expect(normalizePolicy(stored)).toEqual(any);
  });
});

describe("applyManagedConfig", () => {
  const storage = (stored: { config?: Config | null; policy?: ManagedPolicy } = {}) => ({
    loadConfig: async () => stored.config ?? null,
    saveConfig: vi.fn(async (_: Config) => undefined),
    loadPolicy: async () => stored.policy ?? any,
    savePolicy: vi.fn(async (_: ManagedPolicy) => undefined),
  });

  it("saves when nothing or a different account is stored", async () => {
    for (const stored of [null, { ...account, password: "old" }, { ...account, username: "bob" }]) {
      const s = storage({ config: stored });
      expect(await applyManagedConfig({ account, policy: any }, s)).toBe(true);
      expect(s.saveConfig).toHaveBeenCalledWith(account);
      expect(s.savePolicy).not.toHaveBeenCalled();
    }
  });

  it("leaves an identical stored account and policy alone", async () => {
    for (const policy of [any, ownedOnly]) {
      const s = storage({ config: { ...account }, policy: { ...policy } });
      expect(await applyManagedConfig({ account, policy }, s)).toBe(false);
      expect(s.saveConfig).not.toHaveBeenCalled();
      expect(s.savePolicy).not.toHaveBeenCalled();
    }
  });

  it("stores a changed policy with the same account", async () => {
    const enable = storage({ config: { ...account }, policy: any });
    expect(await applyManagedConfig({ account, policy: ownedOnly }, enable)).toBe(true);
    expect(enable.savePolicy).toHaveBeenCalledWith(ownedOnly);
    expect(enable.saveConfig).not.toHaveBeenCalled();

    // A file without autoLogin (or with "any") turns owned-only off again.
    const disable = storage({ config: { ...account }, policy: ownedOnly });
    expect(await applyManagedConfig({ account, policy: any }, disable)).toBe(true);
    expect(disable.savePolicy).toHaveBeenCalledWith(any);
  });

  it("a file with only the policy stores it and keeps the stored account", async () => {
    for (const stored of [{ ...account, username: "bob" }, null]) {
      const s = storage({ config: stored, policy: any });
      expect(await applyManagedConfig({ account: null, policy: ownedOnly }, s)).toBe(true);
      expect(s.savePolicy).toHaveBeenCalledWith(ownedOnly);
      expect(s.saveConfig).not.toHaveBeenCalled();
    }
    const unchanged = storage({ config: { ...account }, policy: ownedOnly });
    expect(await applyManagedConfig({ account: null, policy: ownedOnly }, unchanged)).toBe(false);
    expect(unchanged.savePolicy).not.toHaveBeenCalled();
  });

  it("stores account and policy together for a new account", async () => {
    const s = storage({ config: { ...account, username: "bob" }, policy: any });
    expect(await applyManagedConfig({ account, policy: ownedOnly }, s)).toBe(true);
    expect(s.saveConfig).toHaveBeenCalledWith(account);
    expect(s.savePolicy).toHaveBeenCalledWith(ownedOnly);
  });

  it("sameConfig compares every field", () => {
    expect(sameConfig({ ...account }, account)).toBe(true);
    expect(sameConfig({ ...account, serverUrl: "https://other" }, account)).toBe(false);
    expect(sameConfig(undefined, account)).toBe(false);
  });
});

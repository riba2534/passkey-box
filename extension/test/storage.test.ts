import { beforeEach, describe, expect, it, vi } from "vitest";
import { OWNED_KEY } from "../src/lib/owned";
import { loadOwned, rememberOwned } from "../src/lib/storage";

let data: Record<string, unknown>;
const local = {
  get: vi.fn(async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {})),
  // Writes complete later, like chrome.storage, so unserialized read-modify-writes would overwrite each other.
  set: vi.fn(async (items: Record<string, unknown>) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    Object.assign(data, structuredClone(items));
  }),
};
vi.stubGlobal("chrome", { storage: { local } });

beforeEach(() => {
  data = {};
  local.set.mockClear();
});

describe("pkb_owned storage", () => {
  it("stores remembered credentials as an id → time object", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    await rememberOwned("a");
    now.mockRestore();
    expect(data[OWNED_KEY]).toEqual({ a: 1234 });
    expect(await loadOwned()).toEqual(new Map([["a", 1234]]));
  });

  it("keeps every credential remembered concurrently", async () => {
    await Promise.all([rememberOwned("a"), rememberOwned("b"), rememberOwned("c")]);
    expect(Object.keys(data[OWNED_KEY] as object).sort()).toEqual(["a", "b", "c"]);
  });

  it("a failed write does not block later ones", async () => {
    local.set.mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(rememberOwned("a")).rejects.toThrow("quota exceeded");
    await rememberOwned("b");
    expect(Object.keys(data[OWNED_KEY] as object)).toEqual(["b"]);
  });
});

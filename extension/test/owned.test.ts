import { describe, expect, it } from "vitest";
import { normalizeOwned, OWNED_LIMIT, rememberCredential } from "../src/lib/owned";

describe("normalizeOwned", () => {
  it("reads id → time entries", () => {
    expect(normalizeOwned({ a: 1, b: 2 })).toEqual(new Map([["a", 1], ["b", 2]]));
  });

  it("skips malformed values", () => {
    for (const value of [undefined, null, "a", 1, ["a"]]) expect(normalizeOwned(value).size).toBe(0);
    expect(normalizeOwned({ a: "1", b: null, c: Number.NaN, d: Infinity, "": 1, e: 5 })).toEqual(new Map([["e", 5]]));
  });
});

describe("rememberCredential", () => {
  it("adds new credentials and refreshes known ones", () => {
    let owned = rememberCredential(new Map(), "a", 1);
    owned = rememberCredential(owned, "b", 2);
    owned = rememberCredential(owned, "a", 3);
    expect(owned).toEqual(new Map([["a", 3], ["b", 2]]));
  });

  it("drops the oldest entries beyond the limit", () => {
    let owned = new Map<string, number>();
    for (let i = 1; i <= 5; i++) owned = rememberCredential(owned, `c${i}`, i, 3);
    expect([...owned.keys()].sort()).toEqual(["c3", "c4", "c5"]);
    owned = rememberCredential(owned, "c3", 6, 3);
    owned = rememberCredential(owned, "c6", 7, 3);
    expect([...owned.keys()].sort()).toEqual(["c3", "c5", "c6"]);
  });

  it("keeps the remembered credential even if the clock went back", () => {
    const owned = rememberCredential(new Map([["a", 100], ["b", 200]]), "c", 1, 2);
    expect(owned).toEqual(new Map([["c", 1], ["b", 200]]));
  });

  it("holds at most OWNED_LIMIT credentials by default", () => {
    let owned = new Map<string, number>();
    for (let i = 0; i < OWNED_LIMIT + 20; i++) owned = rememberCredential(owned, `id${i}`, i);
    expect(owned.size).toBe(OWNED_LIMIT);
    expect(owned.has("id19")).toBe(false);
    expect(owned.has("id20")).toBe(true);
    expect(owned.has(`id${OWNED_LIMIT + 19}`)).toBe(true);
  });
});

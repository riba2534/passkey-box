import { describe, expect, it } from "vitest";
import type { Settings } from "../src/lib/config";
import { decideGet, filterByAllowList, hasExcludedCredential, rankOwnedFirst, selectAlgorithm } from "../src/lib/decision";
import { effectiveRpId, hostMatchesRpId, isIpAddress } from "../src/lib/rpid";

const on: Settings = { autoLoginSingle: true, conditionalAutoLogin: true };
const off: Settings = { autoLoginSingle: false, conditionalAutoLogin: false };

describe("decideGet (modal / non-conditional)", () => {
  it.each([undefined, "optional", "required", "silent"])("mediation %s", (mediation) => {
    expect(decideGet(0, mediation, on)).toBe("empty");
    expect(decideGet(1, mediation, on)).toBe("auto");
    expect(decideGet(2, mediation, on)).toBe("picker");
    expect(decideGet(5, mediation, on)).toBe("picker");
  });

  it("one candidate without autoLoginSingle shows the picker", () => {
    expect(decideGet(1, undefined, { ...on, autoLoginSingle: false })).toBe("picker");
    expect(decideGet(0, undefined, off)).toBe("empty");
  });

  it("conditionalAutoLogin does not affect modal requests", () => {
    expect(decideGet(1, undefined, { autoLoginSingle: true, conditionalAutoLogin: false })).toBe("auto");
  });
});

describe("decideGet (conditional)", () => {
  it("auto-signs one candidate, picks among many, waits on none", () => {
    expect(decideGet(0, "conditional", on)).toBe("pending");
    expect(decideGet(1, "conditional", on)).toBe("auto");
    expect(decideGet(3, "conditional", on)).toBe("picker");
  });

  it("stays pending when conditionalAutoLogin is off", () => {
    const s = { autoLoginSingle: true, conditionalAutoLogin: false };
    expect(decideGet(0, "conditional", s)).toBe("pending");
    expect(decideGet(1, "conditional", s)).toBe("pending");
    expect(decideGet(3, "conditional", s)).toBe("pending");
  });

  it("ignores autoLoginSingle", () => {
    expect(decideGet(1, "conditional", { autoLoginSingle: false, conditionalAutoLogin: true })).toBe("auto");
  });
});

describe("decideGet with credentials of this browser profile", () => {
  it("one of several counts as the only candidate", () => {
    expect(decideGet(3, undefined, on, 1)).toBe("auto");
    expect(decideGet(3, "conditional", on, 1)).toBe("auto");
  });

  it("only applies with autoLoginSingle, for modal and conditional requests alike", () => {
    const choose = { autoLoginSingle: false, conditionalAutoLogin: true };
    expect(decideGet(3, undefined, choose, 1)).toBe("picker");
    expect(decideGet(3, "conditional", choose, 1)).toBe("picker");
    // A conditional request with a single candidate still signs in, as before.
    expect(decideGet(1, "conditional", choose, 1)).toBe("auto");
    expect(decideGet(1, "conditional", choose, 0)).toBe("auto");
  });

  it("conditional requests still follow conditionalAutoLogin", () => {
    expect(decideGet(3, "conditional", { autoLoginSingle: true, conditionalAutoLogin: false }, 1)).toBe("pending");
  });

  it("none or several of them keep the picker; one candidate is unaffected", () => {
    expect(decideGet(3, undefined, on, 0)).toBe("picker");
    expect(decideGet(3, undefined, on, 2)).toBe("picker");
    expect(decideGet(3, "conditional", on, 3)).toBe("picker");
    expect(decideGet(1, undefined, on, 1)).toBe("auto");
    expect(decideGet(1, undefined, on, 0)).toBe("auto");
  });
});

describe("rankOwnedFirst", () => {
  const creds = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("puts credentials of this profile first, most recent first, keeping the rest in order", () => {
    const owned = new Map([["c", 10], ["d", 30], ["x", 50]]);
    expect(rankOwnedFirst(creds, owned).map((c) => c.id)).toEqual(["d", "c", "a", "b"]);
  });

  it("keeps the order without a record", () => {
    expect(rankOwnedFirst(creds, new Map())).toEqual(creds);
  });
});

describe("candidate filters", () => {
  const creds = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("filterByAllowList keeps all for an empty list and filters otherwise", () => {
    expect(filterByAllowList(creds, [])).toEqual(creds);
    expect(filterByAllowList(creds, undefined)).toEqual(creds);
    expect(filterByAllowList(creds, ["c", "x", "a"])).toEqual([{ id: "a" }, { id: "c" }]);
    expect(filterByAllowList(creds, ["x"])).toEqual([]);
  });

  it("hasExcludedCredential", () => {
    expect(hasExcludedCredential(creds, [])).toBe(false);
    expect(hasExcludedCredential(creds, undefined)).toBe(false);
    expect(hasExcludedCredential(creds, ["x", "b"])).toBe(true);
    expect(hasExcludedCredential(creds, ["x"])).toBe(false);
  });
});

describe("selectAlgorithm", () => {
  it.each([
    [[], -7],
    [undefined, -7],
    [[{ type: "public-key", alg: -7 }], -7],
    [[{ type: "public-key", alg: -257 }, { type: "public-key", alg: -7 }], -7],
    [[{ type: "public-key", alg: -8 }, { type: "public-key", alg: -257 }], -257],
    [[{ type: "public-key", alg: -8 }], null],
    [[{ type: "other", alg: -7 }], null],
  ])("%j → %s", (params, expected) => {
    expect(selectAlgorithm(params as Array<{ type: string; alg: number }> | undefined)).toBe(expected);
  });
});

describe("rpId", () => {
  it("defaults to the page hostname", () => {
    expect(effectiveRpId(undefined, "login.example.com")).toBe("login.example.com");
    expect(effectiveRpId(null, "localhost")).toBe("localhost");
    expect(effectiveRpId("example.com", "login.example.com")).toBe("example.com");
  });

  it("allows equal hosts and registrable suffixes only", () => {
    expect(hostMatchesRpId("example.com", "example.com")).toBe(true);
    expect(hostMatchesRpId("login.example.com", "example.com")).toBe(true);
    expect(hostMatchesRpId("Login.Example.com", "example.COM")).toBe(true);
    expect(hostMatchesRpId("localhost", "localhost")).toBe(true);
    expect(hostMatchesRpId("badexample.com", "example.com")).toBe(false);
    expect(hostMatchesRpId("example.com", "login.example.com")).toBe(false);
    expect(hostMatchesRpId("example.org", "example.com")).toBe(false);
    expect(hostMatchesRpId("example.com", "")).toBe(false);
    expect(hostMatchesRpId("", "example.com")).toBe(false);
  });

  it("rpIds without a dot only match the identical host", () => {
    expect(hostMatchesRpId("localhost", "localhost")).toBe(true);
    expect(hostMatchesRpId("LocalHost", "localhost")).toBe(true);
    expect(hostMatchesRpId("a.com", "com")).toBe(false);
    expect(hostMatchesRpId("example.co.uk", "co.uk")).toBe(false);
    expect(hostMatchesRpId("example.github.io", "github.io")).toBe(false);
    expect(hostMatchesRpId("login.example.co.uk", "example.co.uk")).toBe(true);
    expect(hostMatchesRpId("app.localhost", "localhost")).toBe(false);
    expect(hostMatchesRpId("intranet", "intranet")).toBe(true);
    expect(hostMatchesRpId("a.b.example", "example")).toBe(false);
  });

  it("IP address hosts only match exactly", () => {
    expect(hostMatchesRpId("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(hostMatchesRpId("127.0.0.1", "0.0.1")).toBe(false);
    expect(hostMatchesRpId("192.168.1.10", "168.1.10")).toBe(false);
    expect(hostMatchesRpId("[::1]", "[::1]")).toBe(true);
    expect(hostMatchesRpId("[2001:db8::1]", "db8::1]")).toBe(false);
    expect(hostMatchesRpId("2001:db8::1.2.3", "2.3")).toBe(false);
    expect(isIpAddress("10.0.0.1")).toBe(true);
    expect(isIpAddress("[::1]")).toBe(true);
    expect(isIpAddress("::1")).toBe(true);
    expect(isIpAddress("example.com")).toBe(false);
    expect(isIpAddress("1.2.3.example")).toBe(false);
  });
});

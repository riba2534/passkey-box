import { describe, expect, it } from "vitest";
import type { Credential } from "../src/lib/api";
import {
  credentialTitle,
  formatTime,
  groupCredentials,
  matchesQuery,
  serverHost,
  siteUrl,
  tabHostname,
} from "../src/lib/popup-model";

function cred(over: Partial<Credential>): Credential {
  return {
    id: "id",
    rp_id: "example.com",
    rp_name: "",
    user_handle: "aA",
    user_name: "user",
    user_display_name: "",
    alg: -7,
    private_key: "",
    public_key: "",
    sign_count: 0,
    label: "",
    origin: "",
    created_at: "2026-11-20T03:30:00Z",
    last_used_at: null,
    use_count: 0,
    ...over,
  };
}

describe("popup model", () => {
  const list = [
    cred({ id: "1", rp_id: "github.com", rp_name: "GitHub", user_name: "alice" }),
    cred({ id: "2", rp_id: "example.com", user_name: "bob", user_display_name: "Bobby" }),
    cred({ id: "3", rp_id: "login.example.com", user_name: "carol", label: "工作号" }),
  ];

  it("groups credentials usable on the current tab", () => {
    expect(groupCredentials(list, "login.example.com", "").current.map((c) => c.id)).toEqual(["2", "3"]);
    expect(groupCredentials(list, "www.github.com", "").current.map((c) => c.id)).toEqual(["1"]);
    expect(groupCredentials(list, "example.org", "").current).toEqual([]);
    expect(groupCredentials(list, "", "").current).toEqual([]);
    expect(groupCredentials(list, "", "").all).toHaveLength(3);
  });

  it("search matches site, names and label case-insensitively", () => {
    expect(matchesQuery(list[0]!, "git")).toBe(true);
    expect(matchesQuery(list[1]!, "BOBBY")).toBe(true);
    expect(matchesQuery(list[2]!, "工作")).toBe(true);
    expect(matchesQuery(list[2]!, "zzz")).toBe(false);
    const g = groupCredentials(list, "login.example.com", "carol");
    expect(g.all.map((c) => c.id)).toEqual(["3"]);
    expect(g.current.map((c) => c.id)).toEqual(["3"]);
  });

  it("titles, URLs and hosts", () => {
    expect(credentialTitle(list[0]!)).toBe("GitHub");
    expect(credentialTitle(list[1]!)).toBe("example.com");
    expect(siteUrl(cred({ origin: "http://localhost:18411", rp_id: "localhost" }))).toBe("http://localhost:18411");
    expect(siteUrl(cred({ origin: "", rp_id: "github.com" }))).toBe("https://github.com");
    expect(tabHostname("https://login.example.com/path?q=1")).toBe("login.example.com");
    expect(tabHostname("chrome://extensions")).toBe("");
    expect(tabHostname(undefined)).toBe("");
    expect(tabHostname("not a url")).toBe("");
    expect(serverHost("http://127.0.0.1:18411")).toBe("127.0.0.1:18411");
    expect(serverHost("weird")).toBe("weird");
  });

  it("formats times in local time", () => {
    expect(formatTime(null)).toBe("从未使用");
    expect(formatTime(null, "—")).toBe("—");
    expect(formatTime("garbage")).toBe("garbage");
    const d = new Date(2026, 10, 20, 9, 5);
    expect(formatTime(d.toISOString())).toBe("2026-11-20 09:05");
  });
});

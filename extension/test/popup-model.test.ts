import { describe, expect, it } from "vitest";
import type { Field, FieldType } from "../src/lib/api";
import {
  accountName,
  credentialTitle,
  customFields,
  detailFields,
  fieldLabel,
  fieldLink,
  fieldText,
  formatTime,
  groupCode,
  groupCredentials,
  matchesQuery,
  removeAction,
  serverHost,
  sharedLabel,
  siteUrl,
  tabHostname,
} from "../src/lib/popup-model";
import { cred } from "./fixtures";

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
    expect(siteUrl(cred({ origin: "https://login.GitHub.com", rp_id: "github.com" }))).toBe("https://login.GitHub.com");
    expect(tabHostname("https://login.example.com/path?q=1")).toBe("login.example.com");
    expect(tabHostname("chrome://extensions")).toBe("");
    expect(tabHostname(undefined)).toBe("");
    expect(tabHostname("not a url")).toBe("");
    expect(serverHost("http://127.0.0.1:18411")).toBe("127.0.0.1:18411");
    expect(serverHost("weird")).toBe("weird");
  });

  it("打开网站 never leaves the passkey's site, whatever origin another user wrote", () => {
    for (const origin of [
      "https://evil.example",
      "https://github.com.evil.example",
      "https://evilgithub.com",
      "https://github.com@evil.example",
      "http://evil.example/https://github.com",
      "javascript:alert(1)//github.com",
      "ftp://github.com",
      "not a url",
    ]) {
      expect([origin, siteUrl(cred({ origin, rp_id: "github.com" }))]).toEqual([origin, "https://github.com"]);
    }
    // Subdomain matching follows WebAuthn: not for IP addresses or rp_ids without a dot.
    expect(siteUrl(cred({ origin: "http://evil.localhost:1", rp_id: "localhost" }))).toBe("https://localhost");
    expect(siteUrl(cred({ origin: "http://127.0.0.1:8080", rp_id: "0.0.1" }))).toBe("https://0.0.1");
    // An RP ID that is not a bare host name would send the fallback link elsewhere.
    for (const rp_id of ["github.com@evil.com", "github.com/x", "github.com:1@evil.com", "a b"]) {
      expect([rp_id, siteUrl(cred({ origin: "https://evil.com", rp_id }))]).toEqual([rp_id, ""]);
    }
  });

  it("formats times in local time", () => {
    expect(formatTime(null)).toBe("从未使用");
    expect(formatTime(null, "—")).toBe("—");
    expect(formatTime("garbage")).toBe("garbage");
    const d = new Date(2026, 10, 20, 9, 5);
    expect(formatTime(d.toISOString())).toBe("2026-11-20 09:05");
  });

  it("subtitles name the account", () => {
    expect(accountName(cred({ user_name: "alice", user_display_name: "Alice" }))).toBe("alice");
    expect(accountName(cred({ user_name: "", user_display_name: "Alice" }))).toBe("Alice");
    expect(accountName(cred({ user_name: "", user_display_name: "" }))).toBe("（无用户名）");
  });
});

describe("popup model: passkeys shared by other users", () => {
  const owner = { id: 1, username: "alice" };
  const own = cred({ id: "own", owner, access: "owner", shared_at: null, last_used_at: "2026-11-21T00:00:00Z" });
  const shared = cred({ id: "in", owner: { id: 2, username: "bob" }, access: "shared", shared_at: "2026-11-21T00:00:00Z" });
  // Servers before 0.6.0 send none of owner, access and shared_at.
  const legacy = cred({ id: "old", last_used_at: "2026-11-21T00:00:00Z" });

  it("marks only shared passkeys with their owner", () => {
    expect(sharedLabel(shared)).toBe("共享自 bob");
    expect(sharedLabel(own)).toBeNull();
    expect(sharedLabel(legacy)).toBeNull();
  });

  it("details of a shared passkey add its owner", () => {
    expect(detailFields(shared)).toEqual([
      ["网站", "example.com"],
      ["用户名", "user"],
      ["显示名", "—"],
      ["所有者", "bob"],
      ["创建时间", formatTime("2026-11-20T03:30:00Z")],
      ["最近使用", "从未使用"],
    ]);
    expect(detailFields(own).map(([k]) => k)).toEqual(["网站", "用户名", "显示名", "创建时间", "最近使用"]);
    expect(detailFields(legacy)).toEqual([
      ["网站", "example.com"],
      ["用户名", "user"],
      ["显示名", "—"],
      ["创建时间", formatTime("2026-11-20T03:30:00Z")],
      ["最近使用", formatTime("2026-11-21T00:00:00Z")],
    ]);
  });

  it("removing a shared passkey leaves the share; an own passkey is deleted as before", () => {
    expect(removeAction(shared)).toEqual({ label: "移除共享", done: "已移除共享", failed: "移除共享失败" });
    const deletion = { label: "删除", done: "已删除通行密钥", failed: "删除失败" };
    expect(removeAction(own)).toEqual(deletion);
    expect(removeAction(legacy)).toEqual(deletion);
    // The server decides what DELETE does, even if it did not name the owner.
    expect(removeAction(cred({ access: "shared" })).label).toBe("移除共享");
  });
});

describe("popup model: custom fields", () => {
  const field = (type: FieldType, value: string, label = ""): Field => ({ id: "x", label, type, value });

  it("are the server's list, or none from a server before 0.7.0", () => {
    const list = [field("text", "a"), field("totp", "GE")];
    expect(customFields(cred({ fields: list }))).toBe(list);
    expect(customFields(cred({}))).toEqual([]);
  });

  it("are named by their label, else by their type", () => {
    expect(fieldLabel(field("password", "", "  恢复码 "))).toBe("恢复码");
    const names = (["text", "password", "url", "email", "phone", "date", "multiline", "totp"] as const).map((t) => fieldLabel(field(t, "", " ")));
    expect(names).toEqual(["文本", "密码", "网址", "邮箱", "电话", "日期", "多行文本", "一次性密码"]);
    // A type from a newer server.
    for (const type of ["passport", "constructor", "__proto__"]) expect(fieldLabel(field(type as FieldType, ""))).toBe("字段");
  });

  it("show their value; passwords until revealed and TOTP secrets never", () => {
    expect(fieldText(field("text", "E-1024"))).toBe("E-1024");
    expect(fieldText(field("multiline", "a\nb"))).toBe("a\nb");
    expect(fieldText(field("password", "hunter2"))).toBe("••••••••");
    expect(fieldText(field("password", "hunter2"), true)).toBe("hunter2");
    expect(fieldText(field("totp", "GEZDGNBV"))).toBe("••••••••");
    expect(fieldText(field("totp", "GEZDGNBV"), true)).toBe("••••••••");
    expect(fieldText(field("text", ""))).toBe("—");
    expect(fieldText(field("password", ""))).toBe("—");
  });

  it("link only http(s) URLs of url fields", () => {
    expect(fieldLink(field("url", "https://admin.example.com/login?a=1"))).toBe("https://admin.example.com/login?a=1");
    expect(fieldLink(field("url", " HTTP://Example.com "))).toBe("http://example.com/");
    for (const value of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "chrome://settings", "ftp://example.com", "example.com", "not a url", ""]) {
      expect([value, fieldLink(field("url", value))]).toEqual([value, null]);
    }
    for (const type of ["text", "email", "multiline"] as const) expect(fieldLink(field(type, "https://example.com"))).toBeNull();
  });

  it("group one-time codes in two", () => {
    expect(groupCode("123456")).toBe("123 456");
    expect(groupCode("1234567")).toBe("1234 567");
    expect(groupCode("12345678")).toBe("1234 5678");
  });
});

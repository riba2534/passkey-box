import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../src/lib/api";
import { verifyLogin } from "../src/lib/login";
import { fakeFetch, json } from "./fixtures";

describe("verifyLogin", () => {
  it("normalizes the server URL and returns the config on success", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { user: { id: 1, username: "alice" } }));
    const result = await verifyLogin({ serverUrl: " pk.example.com/ ", username: " alice ", password: "pw" }, fn);
    expect(result).toEqual({
      ok: true,
      config: { serverUrl: "https://pk.example.com", username: "alice", password: "pw" },
      user: { id: 1, username: "alice" },
    });
    expect(calls[0]!.url).toBe("https://pk.example.com/api/v1/me");
  });

  it("validates input before calling the server", async () => {
    const fetchSpy = vi.fn<FetchLike>();
    expect(await verifyLogin({ serverUrl: "", username: "a", password: "b" }, fetchSpy)).toEqual({ ok: false, message: "请填写服务器地址" });
    expect(await verifyLogin({ serverUrl: "h", username: " ", password: "b" }, fetchSpy)).toEqual({ ok: false, message: "请填写用户名" });
    expect(await verifyLogin({ serverUrl: "h", username: "a", password: "" }, fetchSpy)).toEqual({ ok: false, message: "请填写密码" });
    expect(await verifyLogin({ serverUrl: "ftp://h", username: "a", password: "b" }, fetchSpy)).toEqual({
      ok: false,
      message: "服务器地址只支持 http 或 https",
    });
    expect(await verifyLogin({ serverUrl: "http://exa mple", username: "a", password: "b" }, fetchSpy)).toEqual({
      ok: false,
      message: "服务器地址格式不正确",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("explains failures", async () => {
    const { fn } = fakeFetch(() => json(401, { error: { code: "unauthorized", message: "x" } }));
    expect(await verifyLogin({ serverUrl: "http://h", username: "a", password: "b" }, fn)).toEqual({
      ok: false,
      message: "用户名或密码错误",
    });
    const down = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await verifyLogin({ serverUrl: "127.0.0.1:18411", username: "a", password: "b" }, down.fn)).toEqual({
      ok: false,
      message: "无法连接服务器 https://127.0.0.1:18411：Failed to fetch",
    });
    const odd = fakeFetch(() => json(200, { hello: 1 }));
    expect(await verifyLogin({ serverUrl: "http://h", username: "a", password: "b" }, odd.fn)).toMatchObject({ ok: false });
  });
});

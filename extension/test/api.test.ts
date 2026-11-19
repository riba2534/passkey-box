import { describe, expect, it } from "vitest";
import { ApiError, basicAuthHeader, describeError, ServerClient } from "../src/lib/api";
import { fakeFetch, json } from "./fixtures";

const config = { serverUrl: "http://127.0.0.1:18411", username: "alice", password: "secret" };

describe("basicAuthHeader", () => {
  it("encodes username:password as UTF-8 base64", () => {
    expect(basicAuthHeader("alice", "secret")).toBe("Basic " + Buffer.from("alice:secret").toString("base64"));
    expect(basicAuthHeader("用户", "pässwörd:1")).toBe("Basic " + Buffer.from("用户:pässwörd:1", "utf8").toString("base64"));
    expect(basicAuthHeader("a", "b?")).toBe("Basic " + Buffer.from("a:b?").toString("base64"));
  });
});

describe("ServerClient", () => {
  it("GET /api/v1/me with Basic auth", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { user: { id: 1, username: "alice" } }));
    const user = await new ServerClient(config, fn).me();
    expect(user.username).toBe("alice");
    expect(calls[0]!.url).toBe("http://127.0.0.1:18411/api/v1/me");
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe(basicAuthHeader("alice", "secret"));
  });

  it("tolerates a trailing slash in serverUrl", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { credentials: [] }));
    await new ServerClient({ ...config, serverUrl: "http://h:1/" }, fn).listCredentials();
    expect(calls[0]!.url).toBe("http://h:1/api/v1/credentials");
  });

  it("lists credentials filtered by encoded rp_id", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { credentials: [{ id: "x" }] }));
    const list = await new ServerClient(config, fn).listCredentials("a b&c.com");
    expect(list).toEqual([{ id: "x" }]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:18411/api/v1/credentials?rp_id=a%20b%26c.com");
  });

  it("POSTs new credentials as JSON", async () => {
    const { fn, calls } = fakeFetch(() => json(201, { credential: { id: "n" } }));
    const body = {
      id: "n",
      rp_id: "x.com",
      rp_name: "X",
      user_handle: "aGk",
      user_name: "u",
      user_display_name: "U",
      alg: -7,
      private_key: "k",
      public_key: "p",
      origin: "https://x.com",
      label: "",
    };
    await new ServerClient(config, fn).createCredential(body);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(body);
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("use and delete handle 204 and escape IDs", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const client = new ServerClient(config, fn);
    await client.useCredential("a/b");
    await client.deleteCredential("c");
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", "http://127.0.0.1:18411/api/v1/credentials/a%2Fb/use"],
      ["DELETE", "http://127.0.0.1:18411/api/v1/credentials/c"],
    ]);
  });

  it("parses API errors", async () => {
    const { fn } = fakeFetch(() => json(401, { error: { code: "unauthorized", message: "bad credentials" } }));
    const err = await new ServerClient(config, fn).me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: "unauthorized", message: "bad credentials" });
    expect(describeError(err)).toBe("用户名或密码错误");
  });

  it("reports network failures and non-JSON responses", async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const err = await new ServerClient(config, down.fn).me().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: "network" });
    expect(describeError(err)).toBe("无法连接服务器：Failed to fetch");

    const html = fakeFetch(() => new Response("<html>", { status: 200 }));
    expect(describeError(await new ServerClient(config, html.fn).me().catch((e: unknown) => e))).toContain("不是 JSON");

    const notFound = fakeFetch(() => new Response("nope", { status: 404 }));
    expect(describeError(await new ServerClient(config, notFound.fn).me().catch((e: unknown) => e))).toBe(
      "服务器地址不正确（接口不存在）",
    );

    const boom = fakeFetch(() => json(500, { error: { code: "internal", message: "db locked" } }));
    expect(describeError(await new ServerClient(config, boom.fn).me().catch((e: unknown) => e))).toBe(
      "服务器返回错误（500）：db locked",
    );
  });
});

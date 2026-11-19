// Validates server address + account by calling GET /api/v1/me.

import { ApiError, describeError, ServerClient, type FetchLike, type User } from "./api";
import { normalizeServerUrl, type Config } from "./config";

export type LoginResult = { ok: true; config: Config; user: User } | { ok: false; message: string };

export async function verifyLogin(
  input: { serverUrl: string; username: string; password: string },
  fetchImpl?: FetchLike,
): Promise<LoginResult> {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const username = input.username.trim();
  const password = input.password;
  if (!serverUrl) return { ok: false, message: "请填写服务器地址" };
  try {
    const u = new URL(serverUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, message: "服务器地址只支持 http 或 https" };
  } catch {
    return { ok: false, message: "服务器地址格式不正确" };
  }
  if (!username) return { ok: false, message: "请填写用户名" };
  if (!password) return { ok: false, message: "请填写密码" };
  const config: Config = { serverUrl, username, password };
  try {
    const user = await new ServerClient(config, fetchImpl).me();
    if (!user || typeof user.username !== "string") return { ok: false, message: "服务器返回的数据不正确，请检查服务器地址" };
    return { ok: true, config, user };
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      return { ok: false, message: `无法连接服务器 ${serverUrl}：${err.message}` };
    }
    return { ok: false, message: describeError(err) };
  }
}

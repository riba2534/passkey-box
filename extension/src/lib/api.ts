// Passkey Box server client (docs/API.md). Every request carries HTTP Basic credentials.

import { bytesToBase64url, utf8 } from "./base64url";
import type { Config } from "./config";

export interface User {
  id: number;
  username: string;
  is_admin: boolean;
  created_at: string;
  credential_count: number;
  last_used_at: string | null;
}

export interface Credential {
  id: string;
  rp_id: string;
  rp_name: string;
  user_handle: string;
  user_name: string;
  user_display_name: string;
  alg: number;
  private_key: string;
  public_key: string;
  sign_count: number;
  label: string;
  origin: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
}

export interface NewCredential {
  id: string;
  rp_id: string;
  rp_name: string;
  user_handle: string;
  user_name: string;
  user_display_name: string;
  alg: number;
  private_key: string;
  public_key: string;
  origin: string;
  label: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 for network failures */
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** `Basic base64(utf8(username + ":" + password))` */
export function basicAuthHeader(username: string, password: string): string {
  const b64 = bytesToBase64url(utf8(`${username}:${password}`)).replace(/-/g, "+").replace(/_/g, "/");
  return "Basic " + b64 + "=".repeat((4 - (b64.length % 4)) % 4);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ServerClient {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: basicAuthHeader(this.config.username, this.config.password),
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.serverUrl.replace(/\/+$/, "") + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
      });
    } catch (err) {
      throw new ApiError(err instanceof Error ? err.message : String(err), 0, "network");
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(err?.message || `HTTP ${res.status}`, res.status, err?.code || "http_error");
    }
    if (data === undefined) throw new ApiError("服务器返回的不是 JSON", res.status, "bad_response");
    return data as T;
  }

  async me(): Promise<User> {
    return (await this.request<{ user: User }>("GET", "/api/v1/me")).user;
  }

  async listCredentials(rpId?: string): Promise<Credential[]> {
    const query = rpId === undefined ? "" : `?rp_id=${encodeURIComponent(rpId)}`;
    return (await this.request<{ credentials: Credential[] }>("GET", `/api/v1/credentials${query}`)).credentials ?? [];
  }

  async createCredential(credential: NewCredential): Promise<Credential> {
    return (await this.request<{ credential: Credential }>("POST", "/api/v1/credentials", credential)).credential;
  }

  async useCredential(id: string): Promise<void> {
    await this.request<void>("POST", `/api/v1/credentials/${encodeURIComponent(id)}/use`);
  }

  async deleteCredential(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/v1/credentials/${encodeURIComponent(id)}`);
  }
}

/** Human readable (Chinese) explanation for UI. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return `无法连接服务器：${err.message}`;
    if (err.status === 401) return "用户名或密码错误";
    if (err.status === 404 && err.code !== "not_found") return "服务器地址不正确（接口不存在）";
    return `服务器返回错误（${err.status}）：${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

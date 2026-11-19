// Thin client for the Passkey Box server API (docs/API.md), used from the test process.

export type Account = { username: string; password: string };
export type TestUser = Account & { id: number };

export type User = {
  id: number;
  username: string;
  is_admin: boolean;
  created_at: string;
  credential_count: number;
  last_used_at: string | null;
};

export type Credential = {
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
};

export class PkbApi {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async request<T>(account: Account, method: string, path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${account.username}:${account.password}`, 'utf8').toString('base64');
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${auth}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} as ${account.username} -> ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async me(account: Account): Promise<User> {
    return (await this.request<{ user: User }>(account, 'GET', '/api/v1/me')).user;
  }

  async createUser(admin: Account, user: Account): Promise<User> {
    const body = { username: user.username, password: user.password, is_admin: false };
    return (await this.request<{ user: User }>(admin, 'POST', '/api/v1/admin/users', body)).user;
  }

  async listCredentials(account: Account, rpId?: string): Promise<Credential[]> {
    const query = rpId === undefined ? '' : `?rp_id=${encodeURIComponent(rpId)}`;
    return (await this.request<{ credentials: Credential[] }>(account, 'GET', `/api/v1/credentials${query}`)).credentials;
  }

  async deleteCredential(account: Account, id: string): Promise<void> {
    await this.request(account, 'DELETE', `/api/v1/credentials/${encodeURIComponent(id)}`);
  }

  async clearCredentials(account: Account): Promise<void> {
    for (const credential of await this.listCredentials(account)) {
      await this.deleteCredential(account, credential.id);
    }
  }
}

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

export type UserBrief = { id: number; username: string };
/** JSON number = user ID, JSON string = username. */
export type UserRef = number | string;

export type Share = { user: UserBrief; shared_at: string; shared_by: UserBrief | null; last_used_at: string | null };

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
  // Since 0.6.0.
  owner?: UserBrief;
  access?: 'owner' | 'shared';
  shared_at?: string | null;
  shared_with?: Share[];
};

export type CredentialBrief = { id: string; rp_id: string; user_name: string; owner: UserBrief };

export type Batch<T> = { dry_run: boolean; results: T[] };
export type ShareResult = { credential: CredentialBrief; user: UserBrief; status: string; warnings: string[] };
export type TransferResult = {
  credential: CredentialBrief;
  from: UserBrief;
  to: UserBrief;
  status: string;
  keep_access: boolean;
  warnings: string[];
};

/** Sharing and transfers as the owner (`/credentials/*`) or as an administrator (`/admin/credentials/*`). */
export type Scope = 'owner' | 'admin';
const credentialsPath = (scope: Scope) => (scope === 'admin' ? '/api/v1/admin/credentials' : '/api/v1/credentials');

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

  /** The caller's own credentials and the ones shared with them. */
  async listCredentials(account: Account, rpId?: string): Promise<Credential[]> {
    const query = rpId === undefined ? '' : `?rp_id=${encodeURIComponent(rpId)}`;
    return (await this.request<{ credentials: Credential[] }>(account, 'GET', `/api/v1/credentials${query}`)).credentials;
  }

  async getCredential(account: Account, id: string): Promise<Credential> {
    const path = `/api/v1/credentials/${encodeURIComponent(id)}`;
    return (await this.request<{ credential: Credential }>(account, 'GET', path)).credential;
  }

  /** Deletes an owned credential; for a shared one, leaves the share. */
  async deleteCredential(account: Account, id: string): Promise<void> {
    await this.request(account, 'DELETE', `/api/v1/credentials/${encodeURIComponent(id)}`);
  }

  async share(account: Account, ids: string[], users: UserRef[], scope: Scope = 'owner'): Promise<Batch<ShareResult>> {
    return this.request(account, 'POST', `${credentialsPath(scope)}/share`, { ids, users });
  }

  async unshare(account: Account, ids: string[], users: UserRef[] | 'all', scope: Scope = 'owner'): Promise<Batch<ShareResult>> {
    const body = users === 'all' ? { ids, all: true } : { ids, users };
    return this.request(account, 'POST', `${credentialsPath(scope)}/unshare`, body);
  }

  async transfer(
    account: Account,
    ids: string[],
    to: UserRef,
    options: { keepAccess?: boolean; scope?: Scope } = {},
  ): Promise<Batch<TransferResult>> {
    const body = { ids, to, keep_access: options.keepAccess ?? false };
    return this.request(account, 'POST', `${credentialsPath(options.scope ?? 'owner')}/transfer`, body);
  }

  /** Deletes every credential on the server, whoever owns it, with their shares. */
  async clearAllCredentials(admin: Account): Promise<void> {
    for (;;) {
      const { credentials } = await this.request<{ credentials: Credential[] }>(admin, 'GET', '/api/v1/admin/credentials?limit=500');
      if (credentials.length === 0) return;
      await this.request(admin, 'POST', '/api/v1/admin/credentials/batch-delete', { ids: credentials.map((c) => c.id) });
    }
  }
}

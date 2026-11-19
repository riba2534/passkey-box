// Helpers for the e2e test RP (e2e/rp). Element IDs are documented in rp/public/index.html,
// result strings in rp/public/client.js.

import { expect, type Locator, type Page } from '@playwright/test';
import { RP_API_URL, RP_ORIGIN } from './config.ts';

export type RpState = {
  rpId: string;
  origin: string;
  users: { name: string; userHandle: string; credentials: { id: string; counter: number; createdAt: string }[] }[];
};

export const rpApi = {
  async reset(): Promise<void> {
    const res = await fetch(`${RP_API_URL}/api/reset`, { method: 'POST' });
    if (!res.ok) throw new Error(`RP reset failed: ${res.status}`);
  },

  async state(): Promise<RpState> {
    const res = await fetch(`${RP_API_URL}/api/state`);
    if (!res.ok) throw new Error(`RP state failed: ${res.status}`);
    return (await res.json()) as RpState;
  },

  async user(name: string): Promise<RpState['users'][number]> {
    const user = (await this.state()).users.find((u) => u.name === name);
    if (!user) throw new Error(`RP has no user ${name}`);
    return user;
  },
};

export class RpPage {
  readonly page: Page;
  readonly username: Locator;
  readonly exclude: Locator;
  readonly result: Locator;

  constructor(page: Page) {
    this.page = page;
    this.username = page.locator('#username');
    this.exclude = page.locator('#exclude');
    this.result = page.locator('#result');
  }

  async goto(options: { conditional?: boolean } = {}): Promise<void> {
    await this.page.goto(options.conditional ? `${RP_ORIGIN}/?conditional=1` : `${RP_ORIGIN}/`);
  }

  async register(username: string, options: { exclude?: boolean } = {}): Promise<void> {
    await this.username.fill(username);
    await this.exclude.setChecked(options.exclude ?? false);
    await this.page.locator('#register').click();
  }

  /** Registers each username in turn and waits for its `registered:<name>` result. */
  async registerOk(...usernames: string[]): Promise<void> {
    for (const username of usernames) {
      await this.register(username);
      await this.expectResult(`registered:${username}`);
    }
  }

  /** Usernameless login: allowCredentials is empty. */
  async login(): Promise<void> {
    await this.page.locator('#login').click();
  }

  /** Username-first login: allowCredentials lists that user's credentials. */
  async loginWithUsername(username: string): Promise<void> {
    await this.username.fill(username);
    await this.page.locator('#login-username').click();
  }

  async expectResult(expected: string): Promise<void> {
    await expect(this.result).toHaveText(expected);
  }
}

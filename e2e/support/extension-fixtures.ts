// Fixtures for specs that drive the real Passkey Box extension against the real server.
// Each test gets a fresh persistent Chromium profile with the unpacked extension loaded,
// a reset test RP and empty credential lists for both test accounts.

import { chromium, expect, type Locator, type Page, test as base, type Worker } from '@playwright/test';
import { type Account, PkbApi } from './pkb-api.ts';
import { RpPage, rpApi } from './rp.ts';
import { readStackState, type StackState } from './stack.ts';
import { VirtualAuthenticator } from './virtual-authenticator.ts';

// chrome.* inside the extension service worker (CONTRACT §4.3).
declare const chrome: {
  storage: {
    local: {
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string[]): Promise<void>;
    };
  };
};

export type PkbSettings = { autoLoginSingle: boolean; conditionalAutoLogin: boolean };

export class PkbExtension {
  readonly worker: Worker;
  readonly serverUrl: string;

  constructor(worker: Worker, serverUrl: string) {
    this.worker = worker;
    this.serverUrl = serverUrl;
  }

  /** Writes pkb_config / pkb_settings, which is all the options page does. */
  async configure(account: Account, settings: Partial<PkbSettings> = {}): Promise<void> {
    await this.worker.evaluate((items) => chrome.storage.local.set(items), {
      pkb_config: { serverUrl: this.serverUrl, username: account.username, password: account.password },
      pkb_settings: { autoLoginSingle: true, conditionalAutoLogin: true, ...settings },
    });
  }

  async unconfigure(): Promise<void> {
    await this.worker.evaluate(() => chrome.storage.local.remove(['pkb_config', 'pkb_settings']));
  }
}

/** Selectors from CONTRACT §4.6. Playwright CSS locators pierce the open shadow root. */
export class PkbUi {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  dialog(kind?: 'picker' | 'empty' | 'error'): Locator {
    return this.page.locator(kind ? `[data-pkb-dialog="${kind}"]` : '[data-pkb-dialog]');
  }

  toast(kind: 'signed-in' | 'saved' | 'exists'): Locator {
    return this.page.locator(`[data-pkb-toast="${kind}"]`);
  }

  action(dialog: 'picker' | 'empty' | 'error', action: 'cancel' | 'fallback'): Locator {
    return this.dialog(dialog).locator(`[data-pkb-action="${action}"]`);
  }

  pickerAccounts(): Locator {
    return this.dialog('picker').locator('button[data-pkb-credential-id]');
  }

  async expectNoDialog(): Promise<void> {
    await expect(this.dialog()).toHaveCount(0);
  }
}

type Fixtures = {
  stack: StackState;
  pkb: PkbApi;
  cleanState: void;
  extension: PkbExtension;
  rp: RpPage;
  ui: PkbUi;
  /** Opt-in: catches anything that reaches Chrome's native WebAuthn implementation. */
  authenticator: VirtualAuthenticator;
};

export const test = base.extend<Fixtures>({
  stack: async ({}, use) => {
    await use(readStackState());
  },

  pkb: async ({ stack }, use) => {
    await use(new PkbApi(stack.serverUrl));
  },

  cleanState: [
    async ({ stack, pkb }, use) => {
      await Promise.all([rpApi.reset(), pkb.clearCredentials(stack.users.a), pkb.clearCredentials(stack.users.b)]);
      await use();
    },
    { auto: true },
  ],

  // The headless shell cannot load extensions; the "chromium" channel runs full Chromium headless.
  context: async ({ stack, headless }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless,
      args: [`--disable-extensions-except=${stack.extensionDist}`, `--load-extension=${stack.extensionDist}`],
    });
    await use(context);
    await context.close();
  },

  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()));
  },

  extension: async ({ context, stack }, use) => {
    const isExtensionWorker = (worker: Worker) => worker.url().startsWith('chrome-extension://');
    const worker =
      context.serviceWorkers().find(isExtensionWorker) ??
      (await context.waitForEvent('serviceworker', { predicate: isExtensionWorker }));
    await use(new PkbExtension(worker, stack.serverUrl));
  },

  rp: async ({ page }, use) => {
    await use(new RpPage(page));
  },

  ui: async ({ page }, use) => {
    await use(new PkbUi(page));
  },

  authenticator: async ({ page }, use) => {
    await use(await VirtualAuthenticator.attach(page));
  },
});

export { expect };

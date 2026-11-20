// Fixtures for specs that drive the real Passkey Box extension against the real server.
// Each test gets a fresh persistent Chromium profile with the unpacked extension loaded,
// a reset test RP and empty credential lists for both test accounts.

import { chromium, expect, type BrowserContext, type Locator, type Page, test as base, type Worker } from '@playwright/test';
import { type Account, PkbApi } from './pkb-api.ts';
import { RpPage, rpApi } from './rp.ts';
import { readStackState, type StackState } from './stack.ts';
import { type VirtualCredential, VirtualAuthenticator } from './virtual-authenticator.ts';

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
  readonly deviceUrl: URL;
  readonly context: BrowserContext;
  autoVerify = true;
  private deviceCredential?: VirtualCredential;
  private readonly handledPages = new WeakSet<Page>();
  private readonly approvals = new Set<Promise<void>>();
  private readonly approvalErrors: unknown[] = [];

  constructor(context: BrowserContext, worker: Worker, serverUrl: string) {
    this.context = context;
    this.worker = worker;
    this.serverUrl = serverUrl;
    this.deviceUrl = new URL('device.html', worker.url());
    context.on('page', this.watchPage);
  }

  /** Configure the test account and exercise device enrollment through the real extension page. */
  async configure(account: Account, settings: Partial<PkbSettings> = {}, { enroll = true } = {}): Promise<void> {
    await this.worker.evaluate((items) => chrome.storage.local.set(items), {
      pkb_config: { serverUrl: this.serverUrl, username: account.username, password: account.password },
      pkb_settings: { autoLoginSingle: true, conditionalAutoLogin: true, ...settings },
    });
    if (enroll && !this.deviceCredential) await this.enrollDevice();
  }

  async unconfigure(): Promise<void> {
    await this.worker.evaluate(() => chrome.storage.local.remove(['pkb_config', 'pkb_settings']));
  }

  isVerificationUrl = (url: URL): boolean =>
    url.protocol === this.deviceUrl.protocol &&
    url.host === this.deviceUrl.host &&
    url.pathname === this.deviceUrl.pathname &&
    url.searchParams.has('request');

  async waitForVerification(): Promise<Page> {
    const active = this.context.pages().find((page) => this.isNewVerificationPage(page));
    const page = active ?? await this.context.waitForEvent('page', {
      predicate: (page) => page.waitForURL(this.isVerificationUrl, { timeout: 10_000 })
        .then(() => this.isNewVerificationPage(page), () => false),
      timeout: 10_000,
    });
    this.handledPages.add(page);
    return page;
  }

  /** The page RP has its own authenticator; only the extension popup receives this credential. */
  async addDeviceAuthenticator(page: Page): Promise<VirtualAuthenticator> {
    if (!this.isVerificationUrl(new URL(page.url()))) {
      throw new Error('Device credentials belong only to the extension verification page.');
    }
    const credential = this.deviceCredential;
    if (!credential) throw new Error('The extension fixture has no enrolled device credential.');
    const authenticator = await VirtualAuthenticator.attach(page);
    await authenticator.addCredential(credential);
    authenticator.session.on('WebAuthn.credentialAsserted', ({ credential: assertedCredential }) => {
      if (this.deviceCredential?.credentialId === assertedCredential.credentialId &&
          this.deviceCredential.signCount <= assertedCredential.signCount) {
        this.deviceCredential = assertedCredential;
      }
    });
    return authenticator;
  }

  async finish(): Promise<void> {
    this.context.off('page', this.watchPage);
    await Promise.all(this.approvals);
    if (this.approvalErrors.length) throw new AggregateError(this.approvalErrors, 'Device fixture approval failed');
  }

  private async enrollDevice(): Promise<void> {
    const setup = await this.context.newPage();
    try {
      await setup.goto(this.deviceUrl.href);
      const authenticator = await VirtualAuthenticator.attach(setup);
      await setup.locator('#enroll').click();
      await expect(setup.locator('#status')).toHaveAttribute('data-state', 'enrolled');
      const credentials = await authenticator.credentials();
      expect(credentials).toHaveLength(1);
      const [credential] = credentials;
      expect(credential?.rpId).toBe(`${this.deviceUrl.protocol}//${this.deviceUrl.host}`);
      this.deviceCredential = credential;
    } finally {
      await setup.close();
    }
  }

  private isNewVerificationPage(page: Page): boolean {
    const url = URL.parse(page.url());
    return url !== null && this.isVerificationUrl(url) && !this.handledPages.has(page);
  }

  private watchPage = (page: Page): void => {
    const check = (): void => {
      if (!this.isNewVerificationPage(page)) return;
      page.off('framenavigated', check);
      if (!this.autoVerify) return;
      this.handledPages.add(page);
      const approval = this.approve(page).catch((error) => { this.approvalErrors.push(error); });
      this.approvals.add(approval);
      void approval.then(() => this.approvals.delete(approval));
    };
    page.on('framenavigated', check);
    check();
  };

  private async approve(page: Page): Promise<void> {
    await this.addDeviceAuthenticator(page);
    await page.locator('#verify').click();
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
    const driver = new PkbExtension(context, worker, stack.serverUrl);
    try {
      await use(driver);
    } finally {
      await driver.finish();
    }
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

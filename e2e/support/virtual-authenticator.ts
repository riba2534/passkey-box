// Chrome DevTools Protocol virtual authenticator. Once attached to a page target, every call
// that reaches Chrome's native WebAuthn implementation is served by it, so its credential list
// tells us whether the native implementation was used.

import type { CDPSession, Page } from '@playwright/test';

export type VirtualCredential = {
  credentialId: string; // standard base64
  isResidentCredential: boolean;
  rpId?: string;
  userHandle?: string; // standard base64
  signCount: number;
};

export type NativeOperation = 'credentialAdded' | 'credentialAsserted';

export class VirtualAuthenticator {
  readonly session: CDPSession;
  readonly authenticatorId: string;
  /** Every create/get the native implementation completed with this authenticator, in order. */
  readonly operations: NativeOperation[] = [];

  private constructor(session: CDPSession, authenticatorId: string) {
    this.session = session;
    this.authenticatorId = authenticatorId;
    session.on('WebAuthn.credentialAdded', () => this.operations.push('credentialAdded'));
    session.on('WebAuthn.credentialAsserted', () => this.operations.push('credentialAsserted'));
  }

  static async attach(page: Page): Promise<VirtualAuthenticator> {
    const session = await page.context().newCDPSession(page);
    await session.send('WebAuthn.enable', { enableUI: false });
    const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        ctap2Version: 'ctap2_1',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    return new VirtualAuthenticator(session, authenticatorId);
  }

  async credentials(): Promise<VirtualCredential[]> {
    const { credentials } = await this.session.send('WebAuthn.getCredentials', {
      authenticatorId: this.authenticatorId,
    });
    return credentials;
  }
}

/** CDP encodes binary as standard base64; the RP and the Passkey Box API use base64url. */
export function base64ToBase64url(value: string): string {
  return Buffer.from(value, 'base64').toString('base64url');
}

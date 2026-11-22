import { STACK_STATE_FILE } from './config.ts';
import type { Account, TestUser } from './pkb-api.ts';
import { type ProcessInfo, readJsonFile } from './process.ts';

/** Written by tests/setup/stack.setup.ts into /tmp/pkb-e2e/stack/state.json. */
export type StackState = ProcessInfo & {
  serverUrl: string;
  extensionDist: string;
  /** manifest.json version of the extension under test. */
  extensionVersion: string;
  /** Loaded from PKB_E2E_EXTENSION_DIR instead of built from extension/. */
  extensionPrebuilt: boolean;
  /** The bootstrap administrator; tests use it to clear every credential before each test. */
  admin: Account;
  /** Two ordinary Passkey Box accounts. */
  users: { a: TestUser; b: TestUser };
};

export function readStackState(): StackState {
  const state = readJsonFile<Partial<StackState>>(STACK_STATE_FILE);
  if (!state?.users || !state.admin || !state.serverUrl || !state.extensionDist || !state.extensionVersion) {
    throw new Error(`${STACK_STATE_FILE} is missing or incomplete; run these specs through the "extension" project`);
  }
  return state as StackState;
}

/**
 * Whether the extension under test has the behaviour or UI that `version` introduced. The build of
 * extension/ always has the current behaviour, even before its manifest version is raised.
 */
export function extensionSince(stack: StackState, version: string): boolean {
  if (!stack.extensionPrebuilt) return true;
  const parse = (v: string) => v.split('.').map(Number);
  const [have, want] = [parse(stack.extensionVersion), parse(version)];
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const diff = (have[i] ?? 0) - (want[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

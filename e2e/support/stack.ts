import { STACK_STATE_FILE } from './config.ts';
import type { TestUser } from './pkb-api.ts';
import { type ProcessInfo, readJsonFile } from './process.ts';

/** Written by tests/setup/stack.setup.ts into /tmp/pkb-e2e/stack/state.json. */
export type StackState = ProcessInfo & {
  serverUrl: string;
  extensionDist: string;
  /** Two ordinary Passkey Box accounts; tests clear their credentials before each test. */
  users: { a: TestUser; b: TestUser };
};

export function readStackState(): StackState {
  const state = readJsonFile<Partial<StackState>>(STACK_STATE_FILE);
  if (!state?.users || !state.serverUrl || !state.extensionDist) {
    throw new Error(`${STACK_STATE_FILE} is missing or incomplete; run these specs through the "extension" project`);
  }
  return state as StackState;
}

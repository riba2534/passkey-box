import { test as teardown } from '@playwright/test';
import { STACK_STATE_FILE, STACK_TMP } from '../../support/config.ts';
import { stopService } from '../../support/process.ts';

teardown('stop the Passkey Box server', () => stopService(STACK_STATE_FILE, STACK_TMP));

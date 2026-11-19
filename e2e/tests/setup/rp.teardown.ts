import { test as teardown } from '@playwright/test';
import { RP_STATE_FILE, RP_TMP } from '../../support/config.ts';
import { stopService } from '../../support/process.ts';

teardown('stop the test RP', () => stopService(RP_STATE_FILE, RP_TMP));

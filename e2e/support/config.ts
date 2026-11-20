import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(E2E_DIR, '..');
export const SERVER_DIR = path.join(REPO_ROOT, 'server');
export const EXTENSION_DIR = path.join(REPO_ROOT, 'extension');
export const EXTENSION_DIST = path.join(EXTENSION_DIR, 'dist');

/** Everything the suite writes at runtime lives under here (never inside the repo). */
export const TMP_ROOT = process.env.PKB_E2E_TMP_ROOT ?? '/tmp/pkb-e2e';
export const RP_TMP = path.join(TMP_ROOT, 'rp');
export const STACK_TMP = path.join(TMP_ROOT, 'stack');
export const RP_STATE_FILE = path.join(RP_TMP, 'state.json');
export const STACK_STATE_FILE = path.join(STACK_TMP, 'state.json');
/** Set PKB_E2E_KEEP_TMP=1 to keep logs and the database after the run. */
export const KEEP_TMP = process.env.PKB_E2E_KEEP_TMP === '1';

export const SERVER_PORT = Number(process.env.PKB_E2E_SERVER_PORT ?? 18421);
export const RP_PORT = Number(process.env.PKB_E2E_RP_PORT ?? 18422);

/** Passkey Box server, as written into pkb_config.serverUrl. */
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
/** Origin the browser uses for the test RP (rpId "localhost"). */
export const RP_ORIGIN = `http://localhost:${RP_PORT}`;
export const RP_ID = 'localhost';
/** Same RP, addressed from Node (avoids localhost -> ::1 resolution). */
export const RP_API_URL = `http://127.0.0.1:${RP_PORT}`;

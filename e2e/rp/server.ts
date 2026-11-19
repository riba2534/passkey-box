// Minimal WebAuthn relying party used by the e2e suite.
//
// Runs with Node's built-in type stripping: `node rp/server.ts`.
// Environment: RP_PORT (default 18422), RP_HOST (default 127.0.0.1).
// The page is meant to be opened as http://localhost:<port> (rpId "localhost").
//
// All state is in memory. POST /api/reset wipes it.

import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';

const PORT = Number(process.env.RP_PORT ?? 18422);
const HOST = process.env.RP_HOST ?? '127.0.0.1';
const RP_ID = 'localhost';
const RP_NAME = 'Passkey Box E2E RP';
const ORIGIN = `http://localhost:${PORT}`;
const PUBLIC_DIR = new URL('./public/', import.meta.url);

type StoredCredential = WebAuthnCredential & { createdAt: string };

type User = {
  name: string;
  /** WebAuthn user.id (user handle), base64url. Stable for the lifetime of the RP state. */
  handle: string;
  credentials: StoredCredential[];
};

type Flow =
  | { kind: 'register'; challenge: string; user: User }
  | { kind: 'login'; challenge: string; user: User | null };

const usersByName = new Map<string, User>();
const usersByHandle = new Map<string, User>();
const flows = new Map<string, Flow>();

class RpError extends Error {
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

function reset(): void {
  usersByName.clear();
  usersByHandle.clear();
  flows.clear();
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new RpError(400, 'missing-username');
  return raw.trim();
}

function getOrCreateUser(name: string): User {
  const key = name.toLowerCase();
  let user = usersByName.get(key);
  if (!user) {
    user = { name, handle: randomBytes(16).toString('base64url'), credentials: [] };
    usersByName.set(key, user);
    usersByHandle.set(user.handle, user);
  }
  return user;
}

function findCredential(id: string): { user: User; credential: StoredCredential } | null {
  for (const user of usersByName.values()) {
    const credential = user.credentials.find((c) => c.id === id);
    if (credential) return { user, credential };
  }
  return null;
}

function takeFlow<K extends Flow['kind']>(flowId: unknown, kind: K): Extract<Flow, { kind: K }> {
  if (typeof flowId !== 'string') throw new RpError(400, 'missing-flow');
  const flow = flows.get(flowId);
  flows.delete(flowId);
  if (!flow || flow.kind !== kind) throw new RpError(400, 'unknown-flow');
  return flow as Extract<Flow, { kind: K }>;
}

function newFlow(flow: Flow): string {
  const id = randomUUID();
  flows.set(id, flow);
  return id;
}

async function registerOptions(body: { username?: unknown; exclude?: unknown }) {
  const user = getOrCreateUser(normalizeName(body.username));
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.name,
    userDisplayName: user.name,
    userID: Buffer.from(user.handle, 'base64url'),
    attestationType: 'none',
    supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials:
      body.exclude === true
        ? user.credentials.map((c) => ({ id: c.id, transports: c.transports }))
        : [],
  });
  const flowId = newFlow({ kind: 'register', challenge: options.challenge, user });
  return { flowId, options };
}

async function registerVerify(body: { flowId?: unknown; response?: unknown }) {
  const flow = takeFlow(body.flowId, 'register');
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: flow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });
  } catch (err) {
    console.error('[rp] registration verification threw:', err);
    throw new RpError(400, 'registration-invalid');
  }
  if (!verification.verified) throw new RpError(400, 'registration-not-verified');
  const { credential } = verification.registrationInfo;
  if (findCredential(credential.id)) throw new RpError(409, 'credential-exists');
  flow.user.credentials.push({ ...credential, createdAt: new Date().toISOString() });
  return { username: flow.user.name, credentialId: credential.id };
}

async function loginOptions(body: { username?: unknown }) {
  let user: User | null = null;
  if (body.username !== undefined) {
    user = usersByName.get(normalizeName(body.username).toLowerCase()) ?? null;
    if (!user) throw new RpError(404, 'unknown-user');
    if (user.credentials.length === 0) throw new RpError(404, 'no-credentials');
  }
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'preferred',
    allowCredentials: user ? user.credentials.map((c) => ({ id: c.id, transports: c.transports })) : [],
  });
  const flowId = newFlow({ kind: 'login', challenge: options.challenge, user });
  return { flowId, options };
}

async function loginVerify(body: { flowId?: unknown; response?: unknown }) {
  const flow = takeFlow(body.flowId, 'login');
  const response = body.response as AuthenticationResponseJSON;
  const found = typeof response?.id === 'string' ? findCredential(response.id) : null;
  if (!found) throw new RpError(400, 'unknown-credential');
  if (flow.user && flow.user !== found.user) throw new RpError(400, 'credential-not-allowed');

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: found.credential,
      requireUserVerification: false,
    });
  } catch (err) {
    console.error('[rp] authentication verification threw:', err);
    throw new RpError(400, 'assertion-invalid');
  }
  if (!verification.verified) throw new RpError(400, 'assertion-not-verified');
  found.credential.counter = verification.authenticationInfo.newCounter;

  // The username shown to the page comes from userHandle, like a real usernameless login.
  const userHandle = response.response.userHandle;
  if (!userHandle) throw new RpError(400, 'missing-user-handle');
  const user = usersByHandle.get(userHandle);
  if (!user) throw new RpError(400, 'unknown-user-handle');
  if (user !== found.user) throw new RpError(400, 'user-handle-mismatch');
  return { username: user.name, credentialId: found.credential.id };
}

function snapshot() {
  return {
    rpId: RP_ID,
    origin: ORIGIN,
    users: [...usersByName.values()].map((u) => ({
      name: u.name,
      userHandle: u.handle,
      credentials: u.credentials.map((c) => ({ id: c.id, counter: c.counter, createdAt: c.createdAt })),
    })),
  };
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new RpError(400, 'invalid-json');
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/client.js': { file: 'client.js', type: 'text/javascript; charset=utf-8' },
};

const API: Record<string, (body: Record<string, unknown>) => Promise<unknown> | unknown> = {
  'POST /api/register/options': registerOptions,
  'POST /api/register/verify': registerVerify,
  'POST /api/login/options': loginOptions,
  'POST /api/login/verify': loginVerify,
  'POST /api/reset': () => {
    reset();
    return { ok: true };
  },
  'GET /api/state': snapshot,
  'GET /healthz': () => ({ status: 'ok' }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  const route = `${req.method} ${url.pathname}`;
  try {
    const handler = API[route];
    if (handler) {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const result = await handler(body);
      console.log(`[rp] ${route} -> 200`);
      send(res, 200, result);
      return;
    }
    const asset = req.method === 'GET' ? STATIC[url.pathname] : undefined;
    if (asset) {
      const content = await readFile(new URL(asset.file, PUBLIC_DIR));
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(content);
      return;
    }
    send(res, 404, { error: 'not-found' });
  } catch (err) {
    if (err instanceof RpError) {
      console.log(`[rp] ${route} -> ${err.status} ${err.message}`);
      send(res, err.status, { error: err.message });
      return;
    }
    console.error(`[rp] ${route} -> 500`, err);
    send(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[rp] listening on http://${HOST}:${PORT} (open ${ORIGIN}, rpId ${RP_ID})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}

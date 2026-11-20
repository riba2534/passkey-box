// Browser side of the e2e test RP. Deliberately framework-free and close to what a
// typical site does: fetch JSON options, call navigator.credentials.*, post the result back.
//
// #result values:
//   idle | pending:<register|login|login-username|conditional>
//   registered:<username>        server verified the attestation
//   authenticated:<username>     server verified the assertion; username resolved via userHandle
//   error:<name>                 navigator.credentials.* rejected (DOMException name)
//   rejected:<code>              the RP server refused the request or response
//   conditional-unavailable      isConditionalMediationAvailable() was false

const $ = (selector) => document.querySelector(selector);
const settings = new URLSearchParams(location.search);
const requireUV = settings.get('uv') === 'required';

class RpRejection extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function toBuffer(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
}

function toBase64url(buffer) {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function creationOptions(json) {
  return {
    ...json,
    challenge: toBuffer(json.challenge),
    user: { ...json.user, id: toBuffer(json.user.id) },
    excludeCredentials: (json.excludeCredentials ?? []).map((c) => ({ ...c, id: toBuffer(c.id) })),
  };
}

function requestOptions(json) {
  return {
    ...json,
    challenge: toBuffer(json.challenge),
    allowCredentials: (json.allowCredentials ?? []).map((c) => ({ ...c, id: toBuffer(c.id) })),
  };
}

function registrationJSON(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

function authenticationJSON(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      userHandle: response.userHandle ? toBase64url(response.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new RpRejection(data.error ?? `http-${res.status}`);
  return data;
}

function setResult(text) {
  $('#result').textContent = text;
  console.log(`[rp-page] ${text}`);
}

function describe(err) {
  if (err instanceof RpRejection) return `rejected:${err.code}`;
  if (err && typeof err === 'object' && 'name' in err) return `error:${err.name}`;
  return `error:${String(err)}`;
}

// Only one WebAuthn request can be in flight; like real sites, a button click
// supersedes the pending conditional (autofill) request.
let conditional = null;

function abortConditional() {
  if (conditional) {
    conditional.abort();
    conditional = null;
  }
}

async function register() {
  abortConditional();
  const username = $('#username').value;
  const { flowId, options } = await api('/api/register/options', { username, exclude: $('#exclude').checked, requireUV });
  const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
  const result = await api('/api/register/verify', { flowId, response: registrationJSON(credential) });
  return `registered:${result.username}`;
}

async function login(username) {
  abortConditional();
  const { flowId, options } = await api('/api/login/options', username === null ? { requireUV } : { username, requireUV });
  const credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
  const result = await api('/api/login/verify', { flowId, response: authenticationJSON(credential) });
  return `authenticated:${result.username}`;
}

async function startConditional() {
  if (!(await PublicKeyCredential.isConditionalMediationAvailable?.())) {
    setResult('conditional-unavailable');
    return;
  }
  const controller = new AbortController();
  conditional = controller;
  setResult('pending:conditional');
  try {
    const { flowId, options } = await api('/api/login/options', { requireUV });
    const credential = await navigator.credentials.get({
      publicKey: requestOptions(options),
      mediation: 'conditional',
      signal: controller.signal,
    });
    if (conditional === controller) conditional = null;
    const result = await api('/api/login/verify', { flowId, response: authenticationJSON(credential) });
    setResult(`authenticated:${result.username}`);
  } catch (err) {
    if (controller.signal.aborted) return;
    setResult(describe(err));
  }
}

async function run(label, action) {
  setResult(`pending:${label}`);
  try {
    setResult(await action());
  } catch (err) {
    setResult(describe(err));
  }
}

$('#register').addEventListener('click', () => run('register', register));
$('#login').addEventListener('click', () => run('login', () => login(null)));
$('#login-username').addEventListener('click', () => run('login-username', () => login($('#username').value)));

if (settings.get('conditional') === '1') {
  startConditional();
}

// MAIN-world interception of navigator.credentials.create/get (CONTRACT 4.4/4.5).
// Kept free of direct `window` access so it can be unit tested with fake globals.

import { toPublicKeyCredential, type CredentialRealm } from "./credential-object";
import { PAGE_CHANNEL, type PageRequest, type PageResult, type ToContent, type ToPage } from "./protocol";
import { serializeCreationOptions, serializeRequestOptions } from "./serialize";

export interface PageTransport {
  send(message: ToContent): void;
  onMessage(handler: (message: ToPage) => void): void;
}

type StaticMethod = (...args: unknown[]) => Promise<unknown>;

export interface PageGlobals extends CredentialRealm {
  isSecureContext: boolean;
  CredentialsContainer: { prototype: object };
  PublicKeyCredential: { prototype: object } & Record<string, unknown>;
  DOMException: typeof DOMException;
}

type Op = "create" | "get";
type NativeFn = (this: unknown, options?: unknown) => Promise<unknown>;

interface Pending {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  fallback(): Promise<unknown>;
  cleanup(): void;
}

export const CAPABILITY_OVERRIDES = {
  passkeyPlatformAuthenticator: true,
  userVerifyingPlatformAuthenticator: true,
  conditionalGet: true,
  conditionalCreate: true,
} as const;

function abortReason(signal: AbortSignal, g: PageGlobals): unknown {
  return signal.reason !== undefined ? signal.reason : new g.DOMException("The operation was aborted.", "AbortError");
}

function replaceMethod(target: object, name: string, fn: unknown): void {
  const desc = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, {
    value: fn,
    writable: desc?.writable ?? true,
    enumerable: desc?.enumerable ?? true,
    configurable: true,
  });
}

/** Returns false (and changes nothing) outside secure contexts. */
export function installInterceptor(
  g: PageGlobals,
  transport: PageTransport,
  newId: () => string = () => globalThis.crypto.randomUUID(),
): boolean {
  if (!g.isSecureContext) return false;

  const proto = g.CredentialsContainer.prototype as Record<string, NativeFn>;
  const nativeCreate = proto["create"]!;
  const nativeGet = proto["get"]!;
  const pending = new Map<string, Pending>();

  transport.onMessage((message) => {
    const entry = pending.get(message.id);
    if (!entry || message.kind !== "response") return;
    pending.delete(message.id);
    entry.cleanup();
    settle(entry, message.result);
  });

  function settle(entry: Pending, result: PageResult): void {
    if (result.type === "success") {
      try {
        entry.resolve(toPublicKeyCredential(result.credential, g));
      } catch (err) {
        entry.reject(err);
      }
    } else if (result.type === "error") {
      entry.reject(new g.DOMException(result.message, result.name));
    } else {
      entry.resolve(entry.fallback());
    }
  }

  function intercept(op: Op, self: unknown, options: unknown, native: NativeFn): Promise<unknown> {
    const opts = options as { publicKey?: unknown; signal?: AbortSignal; mediation?: unknown } | null | undefined;
    if (!opts || typeof opts !== "object" || opts.publicKey === undefined || opts.publicKey === null) {
      return Reflect.apply(native, self, [options]) as Promise<unknown>;
    }
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal, g));

    let request: PageRequest;
    try {
      request =
        op === "create"
          ? { op, options: serializeCreationOptions(opts.publicKey) }
          : { op, options: serializeRequestOptions(opts.publicKey) };
    } catch (err) {
      return Promise.reject(err);
    }
    if (typeof opts.mediation === "string") request.mediation = opts.mediation;

    const id = newId();
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (!pending.delete(id)) return;
        cleanup();
        transport.send({ channel: PAGE_CHANNEL, dir: "to-content", kind: "abort", id });
        reject(abortReason(signal!, g));
      };
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort);
      pending.set(id, {
        resolve,
        reject,
        cleanup,
        fallback: () => Reflect.apply(native, self, [options]) as Promise<unknown>,
      });
      transport.send({ channel: PAGE_CHANNEL, dir: "to-content", kind: "request", id, ...request });
    });
  }

  const methods = {
    create(this: unknown, options?: unknown): Promise<unknown> {
      return intercept("create", this, options, nativeCreate);
    },
    get(this: unknown, options?: unknown): Promise<unknown> {
      return intercept("get", this, options, nativeGet);
    },
  };
  replaceMethod(proto, "create", methods.create);
  replaceMethod(proto, "get", methods.get);

  const PKC = g.PublicKeyCredential;
  const nativeCapabilities = PKC["getClientCapabilities"] as StaticMethod | undefined;
  const statics = {
    isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean> {
      return Promise.resolve(true);
    },
    isConditionalMediationAvailable(): Promise<boolean> {
      return Promise.resolve(true);
    },
    async getClientCapabilities(): Promise<Record<string, boolean>> {
      let base: Record<string, boolean> = {};
      try {
        base = ((await nativeCapabilities!.call(PKC)) as Record<string, boolean>) ?? {};
      } catch {
        base = {};
      }
      return { ...base, ...CAPABILITY_OVERRIDES };
    },
  };
  replaceMethod(PKC, "isUserVerifyingPlatformAuthenticatorAvailable", statics.isUserVerifyingPlatformAuthenticatorAvailable);
  replaceMethod(PKC, "isConditionalMediationAvailable", statics.isConditionalMediationAvailable);
  if (typeof nativeCapabilities === "function") replaceMethod(PKC, "getClientCapabilities", statics.getClientCapabilities);
  return true;
}

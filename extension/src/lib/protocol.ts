// Message shapes exchanged between inject (MAIN world), content (ISOLATED world) and background.

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "./authenticator";

export const PAGE_CHANNEL = "passkey-box";

export interface CredentialDescriptorJSON {
  type: string;
  id: string;
  transports?: string[];
}

export interface CreationOptionsJSON {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: string; alg: number }>;
  timeout?: number;
  excludeCredentials: CredentialDescriptorJSON[];
  attestation?: string;
  extensions: { credProps?: boolean };
}

export interface RequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials: CredentialDescriptorJSON[];
  userVerification?: string;
}

export type CredentialJSON = RegistrationResponseJSON | AuthenticationResponseJSON;

// ---------------------------------------------------------------- page <-> content (window.postMessage)

export type PageRequest =
  | { op: "create"; options: CreationOptionsJSON; mediation?: string }
  | { op: "get"; options: RequestOptionsJSON; mediation?: string };

export type PageResult =
  | { type: "success"; credential: CredentialJSON }
  | { type: "error"; name: string; message: string }
  | { type: "fallback" };

export type ToContent =
  | ({ channel: typeof PAGE_CHANNEL; dir: "to-content"; kind: "request"; id: string } & PageRequest)
  | { channel: typeof PAGE_CHANNEL; dir: "to-content"; kind: "abort"; id: string };

export interface ToPage {
  channel: typeof PAGE_CHANNEL;
  dir: "to-page";
  kind: "response";
  id: string;
  result: PageResult;
}

export function isToContent(data: unknown): data is ToContent {
  const d = data as Partial<ToContent> | null;
  return !!d && typeof d === "object" && d.channel === PAGE_CHANNEL && d.dir === "to-content" && typeof d.id === "string";
}

export function isToPage(data: unknown): data is ToPage {
  const d = data as Partial<ToPage> | null;
  return !!d && typeof d === "object" && d.channel === PAGE_CHANNEL && d.dir === "to-page" && typeof d.id === "string";
}

// ---------------------------------------------------------------- content <-> background (runtime messages)

export interface CallerInfo {
  origin: string;
  hostname: string;
  crossOrigin: boolean;
  topOrigin?: string;
}

export type BackgroundRequest =
  | { type: "pkb:create"; caller: CallerInfo; options: CreationOptionsJSON }
  | {
      type: "pkb:get";
      caller: CallerInfo;
      options: RequestOptionsJSON;
      mediation?: string;
      /** Set after the user picked an account in the picker. */
      credentialId?: string;
    };

export interface CandidateSummary {
  id: string;
  user_name: string;
  user_display_name: string;
  rp_id: string;
}

export type ToastKind = "signed-in" | "saved" | "exists";

export type BackgroundResponse =
  | { action: "fallback" }
  | { action: "success"; credential: CredentialJSON; toast: ToastKind; userName: string }
  | { action: "reject"; name: string; message: string; toast?: ToastKind }
  | { action: "picker"; rpId: string; candidates: CandidateSummary[] }
  | { action: "empty"; rpId: string }
  | { action: "pending" }
  | { action: "error"; rpId: string; message: string };

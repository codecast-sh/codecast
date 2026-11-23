// Touch ID inside the desktop app (convex/deviceKeys.ts): Electron runs no
// platform passkeys, so the app holds a Secure Enclave key
// (electron/deviceKey.js) that signs a presence challenge after the system
// prompt, and a gated press never leaves the app for a browser.
//
// The first credential sets up here at once. With a passkey elsewhere and no
// key in this app yet, setting one up spends an add_passkey grant confirmed
// another way (the browser, the phone) once; every confirm after that is the
// system prompt alone. A build with no signer, or a person who would rather
// not set up, answers UNAVAILABLE and the caller hands off as before.
//
// Pure, with the signer and the Convex calls passed in, so it is testable.

import { PRESENCE_PHRASE, type PasskeyMeta, type PresenceAction, type PresenceGrant } from "@codecast/shared/contracts/secrets";

export const UNAVAILABLE = Symbol("device key unavailable");

export type Signed = { signature: string; credential_id: string } | { error: string } | { cancelled: true };

export interface DeviceKeySigner {
  status: () => Promise<{ available: boolean; credential_id: string | null; name?: string }>;
  /** A new key and its signature over the register challenge; kept only after `keep`. */
  create: (a: { challenge: string; reason: string }) => Promise<Signed | ({ public_key: string } & Signed)>;
  keep: (credentialId: string) => Promise<unknown>;
  sign: (a: { challenge: string; reason: string }) => Promise<Signed>;
}

type Begun = { challenge_id: string; options: { challenge: string }; grant?: PresenceGrant; label?: string } | { error: string; needs_passkey?: boolean };

export interface DeviceKeyDeps {
  signer: DeviceKeySigner;
  /** What this app is called in a key's name: "Codecast app", "iPhone". */
  appName: string;
  list: () => Promise<PasskeyMeta[]>;
  begin: (action: PresenceAction, target: string, from?: string) => Promise<Begun>;
  registrationBegin: (grant?: PresenceGrant, from?: string) => Promise<Begun>;
  register: (challengeId: string, publicKey: string, signature: string, name: string) => Promise<{ error: string } | { credential_id: string }>;
  confirm: (challengeId: string, credentialId: string, signature: string) => Promise<{ error: string } | { granted: true }>;
  /** Earn a grant the old way (browser, phone): used once, to set up a key when another credential exists. */
  confirmElsewhere: (action: PresenceAction, target: string) => Promise<PresenceGrant | null>;
  /** Offer setting up this app's key: "setup", "elsewhere" (hand this one off instead), or "cancel". */
  offerSetUp: () => Promise<"setup" | "elsewhere" | "cancel">;
  /** Say why something failed. */
  fail: (message: string) => void;
}

const failed = (r: unknown): r is { error: string } => !!r && typeof r === "object" && "error" in r;
const cancelled = (r: unknown): r is { cancelled: true } => !!r && typeof r === "object" && "cancelled" in r;

/** Set up this app's key, spending `grant` when another credential exists: true once the server stored it. */
async function setUp(deps: DeviceKeyDeps, name: string | undefined, grant?: PresenceGrant): Promise<boolean> {
  const begun = await deps.registrationBegin(grant, name);
  if (failed(begun)) return (deps.fail(begun.error), false);
  const made = await deps.signer.create({ challenge: begun.options.challenge, reason: "set up Touch ID for Codecast" });
  if (cancelled(made)) return false;
  if (failed(made) || !("public_key" in made)) return (deps.fail(failed(made) ? made.error : "Touch ID did not finish"), false);
  const stored = await deps.register(begun.challenge_id, made.public_key, made.signature, name ? `${deps.appName} on ${name}` : deps.appName);
  if (failed(stored)) return (deps.fail(stored.error), false);
  await deps.signer.keep(stored.credential_id);
  return true;
}

/**
 * Make sure this app holds a key the server knows: true when it does (or now
 * does), false when the person cancelled or it was refused, UNAVAILABLE when
 * there is no signer here or they chose to hand off. `offer` false skips the
 * question (the person asked for it in Settings).
 */
export async function ensureDeviceKey(deps: DeviceKeyDeps, offer = true): Promise<{ name?: string; credential_id: string } | false | typeof UNAVAILABLE> {
  const status = await deps.signer.status().catch(() => null);
  if (!status?.available) return UNAVAILABLE;
  const keys = await deps.list();
  if (status.credential_id && keys.some((k) => k.device_key === status.credential_id)) return { name: status.name, credential_id: status.credential_id };
  if (keys.length) {
    const choice = offer ? await deps.offerSetUp() : "setup";
    if (choice === "cancel") return false;
    if (choice === "elsewhere") return UNAVAILABLE;
    const grant = await deps.confirmElsewhere("add_passkey", "self");
    if (!grant || !(await setUp(deps, status.name, grant))) return false;
  } else if (!(await setUp(deps, status.name))) {
    return false;
  }
  const now = await deps.signer.status();
  return now.credential_id ? { name: now.name, credential_id: now.credential_id } : false;
}

/**
 * The grant string once the person confirmed `action` on `target` with this
 * app's key, null when they cancelled or it was refused (said through
 * `fail`), or UNAVAILABLE when the caller should hand off instead.
 */
export async function confirmWithDeviceKey(action: PresenceAction, target: string, deps: DeviceKeyDeps): Promise<PresenceGrant | null | typeof UNAVAILABLE> {
  const key = await ensureDeviceKey(deps);
  if (key === UNAVAILABLE) return UNAVAILABLE;
  if (!key) return null;
  const begun = await deps.begin(action, target, key.name);
  if (failed(begun)) return (deps.fail(begun.error), null);
  const reason = begun.label ? `${PRESENCE_PHRASE[action]}: ${begun.label}` : PRESENCE_PHRASE[action];
  const signed = await deps.signer.sign({ challenge: begun.options.challenge, reason });
  if (cancelled(signed)) return null;
  if (failed(signed)) return (deps.fail(signed.error), null);
  const done = await deps.confirm(begun.challenge_id, signed.credential_id, signed.signature);
  if (failed(done)) return (deps.fail(done.error), null);
  return begun.grant ?? null;
}

// Touch ID on the phone, run by the phone: the platform passkey sheet
// (lib/nativePasskey) answers the same challenge the web's /confirm page would
// (convex/passkeys.ts), and the app finishes it with the same server calls,
// so no page opens. With no passkey yet it sets one up first, then confirms.
//
// UNCONFIGURED means this binary cannot run a ceremony for codecast.sh (an OS
// without passkeys, or an associated domain the OS has not verified): the
// caller hands off to /confirm instead.
//
// Pure (no React Native) so passkeyCeremony.test.ts runs it under bun.

import type { PresenceAction, PresenceGrant } from '@codecast/shared/contracts/secrets';

type Json = Record<string, any>;

export type Begun = { challenge_id: string; options: Json; grant?: PresenceGrant } | { error: string; needs_passkey?: boolean };

export interface NativePasskeyDeps {
  begin: (action: PresenceAction, target: string) => Promise<Begun>;
  enroll: (grant?: PresenceGrant) => Promise<Begun>;
  /** The platform's assertion and registration; they throw what the passkey library throws. */
  get: (request: Json) => Promise<Json>;
  create: (request: Json) => Promise<Json>;
  finishPresence: (challengeId: string, response: Json) => Promise<{ error: string } | { granted: true }>;
  finishRegistration: (challengeId: string, response: Json, name: string) => Promise<{ error: string } | { id: string }>;
  /** What a passkey made here is called until its owner renames it. */
  name: string;
}

export const UNCONFIGURED = Symbol('passkeys unconfigured');
type Unconfigured = typeof UNCONFIGURED;

const b64url = (s: unknown) => (typeof s === 'string' ? s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : s);

const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'hybrid', 'internal']);

function descriptor(d: Json): Json {
  const transports = Array.isArray(d.transports) ? d.transports.filter((t: string) => TRANSPORTS.has(t)) : undefined;
  return { id: b64url(d.id), type: 'public-key', ...(transports?.length ? { transports } : {}) };
}

/** The server's generateAuthenticationOptions JSON, cut to what the native sheet reads. */
export function toGetRequest(o: Json): Json {
  return {
    challenge: b64url(o.challenge),
    rpId: o.rpId,
    ...(o.timeout ? { timeout: o.timeout } : {}),
    ...(o.userVerification ? { userVerification: o.userVerification } : {}),
    ...(o.allowCredentials?.length ? { allowCredentials: o.allowCredentials.map(descriptor) } : {}),
  };
}

/**
 * The server's generateRegistrationOptions JSON, cut to what the native sheet
 * reads. "none" attestation is dropped: the iOS bridge maps it to direct.
 */
export function toCreateRequest(o: Json): Json {
  return {
    rp: o.rp,
    user: { ...o.user, id: b64url(o.user?.id) },
    challenge: b64url(o.challenge),
    pubKeyCredParams: o.pubKeyCredParams,
    ...(o.timeout ? { timeout: o.timeout } : {}),
    ...(o.authenticatorSelection ? { authenticatorSelection: o.authenticatorSelection } : {}),
    ...(o.attestation && o.attestation !== 'none' ? { attestation: o.attestation } : {}),
    ...(o.excludeCredentials?.length ? { excludeCredentials: o.excludeCredentials.map(descriptor) } : {}),
  };
}

/** A native credential as the WebAuthn JSON @simplewebauthn/server verifies: base64url throughout, rawId, type and extension results present. */
export function toResponseJSON(c: Json): Json {
  const id = b64url(c.id ?? c.rawId);
  const response: Json = {};
  for (const [k, v] of Object.entries(c.response ?? {})) response[k] = k === 'transports' || k === 'publicKeyAlgorithm' ? v : b64url(v);
  return {
    ...c,
    id,
    rawId: b64url(c.rawId ?? id),
    type: 'public-key',
    response,
    clientExtensionResults: c.clientExtensionResults ?? {},
  };
}

const UNCONFIGURED_CODES = new Set(['NotSupported', 'BadConfiguration']);
const UNCONFIGURED_TEXT = /not associated with domain|cannot be validated|associated domain|asset ?links/i;
const CANCEL_CODES = new Set(['UserCancelled', 'Interrupted']);
const SAID: Record<string, string> = {
  NoCredentials: 'No Codecast passkey on this phone',
  CredentialAlreadyExists: 'This phone already has a Codecast passkey',
  TimedOut: 'Touch ID timed out',
};

/** What a failed ceremony means: the person cancelling, a binary that cannot run one, or the words to show. */
export function classifyCeremonyError(e: unknown): 'cancel' | Unconfigured | string {
  const err = (e ?? {}) as { error?: string; code?: string; message?: string };
  const code = err.error ?? err.code ?? '';
  const message = err.message ?? '';
  if (CANCEL_CODES.has(code) || /cancel/i.test(code)) return 'cancel';
  if (UNCONFIGURED_CODES.has(code) || UNCONFIGURED_TEXT.test(message)) return UNCONFIGURED;
  return SAID[code] ?? (message || 'Touch ID did not finish');
}

async function ceremony(run: () => Promise<Json>): Promise<Json | null | Unconfigured> {
  try {
    return toResponseJSON(await run());
  } catch (e) {
    const meaning = classifyCeremonyError(e);
    if (meaning === 'cancel') return null;
    if (meaning === UNCONFIGURED) return UNCONFIGURED;
    throw new Error(meaning);
  }
}

/** Set up a passkey on this phone, spending `grant` when it is a second one: true once stored. */
async function enroll(deps: NativePasskeyDeps, grant?: PresenceGrant): Promise<true | null | Unconfigured> {
  const opened = await deps.enroll(grant);
  if ('error' in opened) throw new Error(opened.error);
  const response = await ceremony(() => deps.create(toCreateRequest(opened.options)));
  if (!response || response === UNCONFIGURED) return response;
  const stored = await deps.finishRegistration(opened.challenge_id, response, deps.name);
  if ('error' in stored) throw new Error(stored.error);
  return true;
}

/** The grant string once the person confirmed `action` on `target`, null when they cancelled. Throws with the server's words. */
export async function confirmPresenceNative(action: PresenceAction, target: string, deps: NativePasskeyDeps): Promise<PresenceGrant | null | Unconfigured> {
  let opened = await deps.begin(action, target);
  if ('needs_passkey' in opened && opened.needs_passkey) {
    const made = await enroll(deps);
    if (made !== true) return made;
    opened = await deps.begin(action, target);
  }
  if ('error' in opened) throw new Error(opened.error);
  const { challenge_id, grant, options } = opened;
  const response = await ceremony(() => deps.get(toGetRequest(options)));
  if (!response || response === UNCONFIGURED) return response;
  const done = await deps.finishPresence(challenge_id, response);
  if ('error' in done) throw new Error(done.error);
  return grant ?? null;
}

/** Settings' Add: the first passkey sets up at once; another first confirms add_passkey with one already there. True once stored. */
export async function addPasskeyNative(hasPasskeys: boolean, deps: NativePasskeyDeps): Promise<boolean | Unconfigured> {
  let grant: PresenceGrant | undefined;
  if (hasPasskeys) {
    const granted = await confirmPresenceNative('add_passkey', 'self', deps);
    if (granted === UNCONFIGURED) return UNCONFIGURED;
    if (!granted) return false;
    grant = granted;
  }
  const made = await enroll(deps, grant);
  return made === UNCONFIGURED ? UNCONFIGURED : made === true;
}

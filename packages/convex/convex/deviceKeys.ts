// Device keys (docs/architecture/vault.md "Touch ID"): the desktop app and the
// phone confirm a presence challenge without a browser. Each holds a P-256 key
// that signs only after Touch ID or Face ID: the Mac's in its Secure Enclave,
// the phone's in its keychain behind biometry. The key signs
// deviceKeyMessage(purpose, challenge); the server checks that signature
// against the public key stored in a `passkeys` row of kind device_key, and
// from there it is the same challenge, the same grant and the same gate as a
// WebAuthn passkey.
//
// Setting one up signs its own register challenge, so it takes the finger
// too, and a second credential spends an add_passkey grant at the begin like
// any passkey (passkeys.openChallenge). The caller must be signed in as the
// person who asked: a device key lives in a codecast app.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { action } from "./functions";
import { internal } from "./_generated/api";
import { deviceKeyMessage, type PresenceAction } from "@codecast/shared/contracts/secrets";

const MAX_NAME = 60;

/** A device key's credential id: its public key's SHA-256, base64url. */
export async function deviceKeyId(publicKey: Uint8Array): Promise<string> {
  return isoBase64URL.fromBuffer(new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)));
}

/** Whether `signature` (r||s, 64 bytes) is `publicKey`'s (an uncompressed P-256 point) over the message for this challenge. */
export async function verifyDeviceKey(publicKey: Uint8Array, signature: Uint8Array, purpose: "register" | "presence", challenge: string): Promise<boolean> {
  if (publicKey.length !== 65 || publicKey[0] !== 4 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, new TextEncoder().encode(deviceKeyMessage(purpose, challenge)));
  } catch {
    return false;
  }
}

const bytes = (b64url: string): Uint8Array | null => {
  try {
    return isoBase64URL.toBuffer(b64url);
  } catch {
    return null;
  }
};

/** The open challenge a signed-in caller may answer, or why not. */
async function openFor(ctx: any, challengeId: string, credentialId?: string) {
  const caller = await getAuthUserId(ctx);
  if (!caller) return { error: "Sign in to codecast to confirm with Touch ID" } as const;
  const got = await ctx.runQuery(internal.passkeys.ceremony, { challenge_id: challengeId, credential_id: credentialId });
  if (!got) return { error: "This confirmation is not open: start again" } as const;
  if (String(caller) !== String(got.row.user_id)) return { error: "This confirmation belongs to another account" } as const;
  return got as { row: any; passkey: any };
}

/**
 * Set up this device's key: its public key and its signature over the register
 * challenge, which proves the device holds it and the person was there.
 */
export const register = action({
  args: { challenge_id: v.string(), public_key: v.string(), signature: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ id: string; name: string; first: boolean; credential_id: string } | { error: string }> => {
    const got = await openFor(ctx, args.challenge_id);
    if ("error" in got) return got;
    if (got.row.purpose !== "register") return { error: "This confirmation is not open: start again" };
    const publicKey = bytes(args.public_key);
    const signature = bytes(args.signature);
    if (!publicKey || !signature || !(await verifyDeviceKey(publicKey, signature, "register", got.row.challenge))) {
      return { error: "Touch ID on this device could not be verified" };
    }
    const credential_id = await deviceKeyId(publicKey);
    const stored = await ctx.runMutation(internal.passkeys.storePasskey, {
      challenge_id: got.row._id,
      credential_id,
      public_key: isoBase64URL.fromBuffer(publicKey),
      counter: 0,
      name: args.name?.trim().slice(0, MAX_NAME) || "This device",
      kind: "device_key",
    });
    return "error" in stored ? stored : { ...stored, credential_id };
  },
});

/** Answer a presence challenge with this device's key: granted, the gate for its action and target passes once. */
export const confirm = action({
  args: { challenge_id: v.string(), credential_id: v.string(), signature: v.string() },
  handler: async (ctx, args): Promise<{ granted: true; action: PresenceAction; expires_at: number } | { error: string }> => {
    const got = await openFor(ctx, args.challenge_id, args.credential_id);
    if ("error" in got) return got;
    const { row, passkey } = got;
    if (row.purpose !== "presence") return { error: "This confirmation is not open: start again" };
    if (!passkey || passkey.kind !== "device_key") return { error: "Touch ID on this device is not set up for this account" };
    const publicKey = bytes(passkey.public_key);
    const signature = bytes(args.signature);
    if (!publicKey || !signature || !(await verifyDeviceKey(publicKey, signature, "presence", row.challenge))) {
      return { error: "Touch ID on this device could not be verified" };
    }
    return await ctx.runMutation(internal.passkeys.grantPresence, { challenge_id: row._id, passkey_id: passkey._id, counter: 0 });
  },
});

// The stored token and the credential it becomes on the wire.
//
// config.json holds the secret, encrypted for this machine. In memory,
// `config.auth_token` is what a request sends as `api_token`: the secret
// itself for an ordinary token, and `<secret>.<device_id>` for a token the
// server bound to a machine (the secret says so by its prefix; see
// @platform/auth tokenFormat). The device is computed here, at read time,
// never stored: a config copied to another machine presents that machine's
// id and the server refuses it, which is the whole point of the binding.
//
// Composed once, where the token is decrypted, rather than at the ~300 call
// sites that build request bodies or Convex args: a step every caller has to
// remember is a step the newest caller forgets. The writers strip the device
// back off, so nothing but the secret ever reaches the file.

import { isDeviceBoundToken, presentToken, splitPresentedToken } from "@platform/auth/cli";
export { isDeviceBoundToken } from "@platform/auth/cli";
import { deviceId } from "./remote/device.js";
import { decryptToken, encryptToken, isEncryptedToken } from "./tokenEncryption.js";

/**
 * Whether a mint (`cast auth`, `cast login`) asks the server to bind the new
 * token to this machine. OFF until decision sd-242 settles how remote hosts
 * get a token, because host provisioning copies this machine's token and a
 * bound one cannot be copied. Everything else stays live: the server enforces
 * the binding on any bound token, and a bound token already in a config is
 * presented with its device. Flipping this is the whole rollout.
 */
export const REQUEST_DEVICE_BOUND_TOKENS = false;

/** The device a mint names, or nothing while the switch above is off. */
export function mintDeviceId(): string | undefined {
  return REQUEST_DEVICE_BOUND_TOKENS ? deviceId() : undefined;
}

/** The plaintext secret behind what config.json stores, encrypted or not. Throws TokenDecryptError. */
export function secretFromStored(stored: string): string {
  return isEncryptedToken(stored) ? decryptToken(stored) : stored;
}

/** What a stored token is presented as on the wire. */
export function bearerFromStored(stored: string): string {
  const secret = secretFromStored(stored);
  return isDeviceBoundToken(secret) ? presentToken(secret, deviceId()) : secret;
}

/** What goes back into config.json for an in-memory token: the secret alone, encrypted. */
export function storedFromBearer(bearer: string): string {
  return isEncryptedToken(bearer) ? bearer : encryptToken(splitPresentedToken(bearer).secret);
}

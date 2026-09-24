// The shape of an API token on the wire. A leaf with no imports on purpose:
// the Convex side verifies with it and the CLI presents with it, and the CLI
// must reach it without pulling the Convex runtime into its bundle.
//
// A token's plaintext is opaque to everyone but this file. Two facts live in
// it:
//
//   - A bound token starts with DEVICE_BOUND_TOKEN_PREFIX. The server mints
//     the prefix when the mint names a device, and the prefix is part of the
//     secret (the stored hash covers it), so a client cannot remove it to
//     shed the binding. What the prefix buys is a client that knows, from the
//     credential alone, that it must present a device. A client that reads
//     an unmarked token sends it exactly as it always has, which is why no
//     token in the wild changes on the wire and no deploy order can lock a
//     machine out: a server that mints marks also accepts presentations.
//
//   - A presentation is `<secret>.<device_id>`. The device rides inside the
//     one field every authenticated function already accepts, `api_token`,
//     so the ~500 functions whose validators are closed objects need no new
//     argument and the HTTP edge, which strips unknown fields, forwards it
//     untouched. The separator cannot occur in a secret (hex plus the
//     prefix) or in a device id (hex).

export const DEVICE_BOUND_TOKEN_PREFIX = "bound_";

const PRESENTATION_SEPARATOR = ".";

/** Does this secret say "present me with a device"? Client side only; the server reads the row. */
export function isDeviceBoundToken(secret: string): boolean {
  return secret.startsWith(DEVICE_BOUND_TOKEN_PREFIX);
}

/** The credential a machine sends for a secret: the secret plus the device presenting it. */
export function presentToken(secret: string, deviceId: string): string {
  return `${secret}${PRESENTATION_SEPARATOR}${deviceId}`;
}

/** The secret and, when one was presented, the device id, from what arrived in `api_token`. */
export function splitPresentedToken(presented: string): { secret: string; deviceId?: string } {
  const at = presented.indexOf(PRESENTATION_SEPARATOR);
  if (at < 0) return { secret: presented };
  const deviceId = presented.slice(at + 1);
  return deviceId ? { secret: presented.slice(0, at), deviceId } : { secret: presented.slice(0, at) };
}

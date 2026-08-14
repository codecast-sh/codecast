// Fencing foreign text before an agent reads it.
//
// `cast cap show` prints publisher-controlled descriptions into a terminal an
// agent is reading. Escaping markup does nothing against "ignore previous
// instructions" — the defense that works is provenance: wrap the untrusted
// region in delimiters that NAME where the text came from, so a model (and a
// human) can see exactly where third-party content begins and ends, and the
// instructions inside it read as quoted material rather than as the
// conversation's own voice.
//
// The delimiter carries a nonce so embedded text cannot close the fence early:
// a description containing the literal closing tag would otherwise escape and
// speak with the terminal's authority.

import * as crypto from "crypto";

/**
 * Wrap one foreign string with its provenance.
 *
 * `provenance` names the source concretely — "marketplace claude-plugins-official",
 * "skill deploy on m1-mini" — because "untrusted content" alone teaches a reader
 * nothing about how much to distrust it.
 */
export function fenceForeignText(text: string, provenance: string): string {
  // 6 bytes of nonce: unguessable by embedded text, short enough to stay
  // readable. Uniqueness per call is all it needs — this is not a secret.
  const nonce = crypto.randomBytes(6).toString("base64url");
  const open = `<untrusted-${nonce} source="${provenance.replace(/"/g, "'")}">`;
  const close = `</untrusted-${nonce}>`;
  return `${open}\n${text}\n${close}`;
}

/**
 * Fence only when the text needs it.
 *
 * Builtin capabilities' own descriptions are ours; fencing them would train
 * readers that the delimiter is noise. The rule mirrors the store's trust
 * boundary: anything whose slug is not `builtin/` came from outside.
 */
export function fenceUnlessBuiltin(text: string, slug: string, provenance: string): string {
  return slug.startsWith("builtin/") ? text : fenceForeignText(text, provenance);
}

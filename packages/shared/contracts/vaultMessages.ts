import type { SecretKind } from "./secrets";
import { escapeTagAttr, stripInjectionNoise, unescapeTagAttr } from "./machineMessages";

// A person filled a secret an agent asked for (`cast vault request`): the
// line that wakes the asking session (convex secrets.fulfill). It names the
// secret and how to use it, never the value, which the agent reads with the
// CLI so it never enters the transcript.
export const VAULT_READY_TAG_RE = /<cast-vault-ready\s+id="([^"]*)"\s+name="([^"]*)"\s*\/>/;

export type VaultReadyMessage = { id: string; name: string; text: string };

/** `vars` are the variables `cast vault run` sets for it (secrets envFor). */
export function formatVaultReady(s: { short_id: string; name: string; kind: SecretKind; vars: string[]; sites?: string[]; has_otp?: boolean }): string {
  const vars = s.vars.join(" and ");
  const run = `\`cast vault run ${s.name} -- <command>\``;
  const how =
    s.kind === "signin" ? `\`cast browser open ${s.sites?.[0] ?? "<site>"}\` starts signed in.`
    : s.kind === "file" ? `${run} writes it to a private file and sets ${vars} to its path.`
    : `${run} sets ${vars} for that command; \`cast vault get ${s.name}\` prints it for a pipe.`;
  const otp = s.has_otp ? ` \`cast vault otp ${s.name}\` prints the current 2FA code.` : "";
  return `Vault: ${s.name} is ready. ${how}${otp}\n<cast-vault-ready id="${escapeTagAttr(s.short_id)}" name="${escapeTagAttr(s.name)}"/>`;
}

/** A person declined a secret an agent asked for: plain words to the asking session, which goes on without it. */
export function formatVaultDeclined(name: string): string {
  return `Vault: your request for ${name} was declined, so no value is coming. Go on without it, or ask in this conversation why.`;
}

export function parseVaultReady(rawContent: string | null | undefined): VaultReadyMessage | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  const match = text.match(VAULT_READY_TAG_RE);
  if (!match) return null;
  return { id: unescapeTagAttr(match[1]), name: unescapeTagAttr(match[2]), text: text.replace(VAULT_READY_TAG_RE, "").trim() };
}

// The SSH target a device advertises (devices.setDeviceSshHost), checked
// before it is stored.
/** Longest ssh target we accept — comfortably fits "user@some.long.host.name". */
const MAX_SSH_HOST_LENGTH = 128;

/**
 * Validate an SSH target, or return null for "no target".
 *
 * This string is concatenated into a shell command the user is invited to copy
 * and paste into their own terminal, so an ALLOWLIST is the only safe policy:
 * a blocklist of `;`/`$`/backtick/quote would still let through newlines,
 * `&&`, `|`, `<(…)` and the rest. Everything a real ssh target needs —
 * `user@host`, `host.example.com`, an IPv4/IPv6 literal, a `~/.ssh/config`
 * alias, an optional `:port` — is covered by letters, digits, and
 * `. - _ @ : [ ]`. Nothing in that set can end an argument or start a new
 * command, so the copied line means exactly what it reads as.
 *
 * Exported for direct unit testing: this is the only thing standing between a
 * hand-typed settings field and a command the user runs without reading.
 */
export function sanitizeSshHost(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_SSH_HOST_LENGTH) return null;
  if (!/^[A-Za-z0-9._@:\-[\]]+$/.test(trimmed)) return null;
  // A leading "-" would be read by ssh as a flag rather than a destination.
  if (trimmed.startsWith("-")) return null;
  return trimmed;
}

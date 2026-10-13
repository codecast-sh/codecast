// Secret redaction lives in secretRedaction.ts (conservative, typed markers).
// Re-exported here so existing import sites (syncService, daemon) keep working
// through the single shared chokepoint.
export { redactSecrets, containsSecrets } from "./secretRedaction.js";

/** Mask a config token for safe display in CLI output (not for transcripts). */
export function maskToken(token: string | undefined): string {
  if (!token) return "(not set)";
  if (token.length <= 8) return "*****";
  return `${token.slice(0, 3)}...${token.slice(-3)}`;
}

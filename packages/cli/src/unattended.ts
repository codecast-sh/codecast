// Unattended principal (docs/architecture/the-line.md L4). A hand started by
// the line runs with nobody at the keyboard: it launches permissive (the same
// bypass flags every daemon-started session gets), so the fence is the mandate
// in its briefing, the way a safe-mode trigger run carries SAFE_MODE_MANDATE
// (taskScheduler.ts). ONE string, prefixed to the first prompt by
// `cast spawn --unattended` and by the workflow runner's session nodes.
export const UNATTENDED_MANDATE =
  "This is an UNATTENDED run: no person is watching this session. Reversible actions run without asking. " +
  "Anything hard to reverse or in a protected decision category (spending money or quota, deleting or migrating data, " +
  "touching billing, auth or production, pushing to a shared branch, merging) goes through `cast decide` and waits. " +
  "Never ask an inline question; nobody will answer it. End your turn with the structured command your briefing names " +
  "(cast task handoff / cast task verdict), never with a bare summary.";

export function applyUnattended(prompt: string): string {
  return `${UNATTENDED_MANDATE}\n\n${prompt}`;
}

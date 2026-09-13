// Unattended principal (docs/architecture/the-line.md L4). A hand started by
// the line runs with nobody at the keyboard: it launches permissive (the same
// bypass flags every daemon-started session gets), so the fence is the mandate
// in its briefing, the way a safe-mode trigger run carries SAFE_MODE_MANDATE
// (taskScheduler.ts). ONE string, prefixed to the first prompt by
// `cast spawn --unattended` and by the workflow runner's session nodes. It
// states the principle; the role's configured decision categories carry the
// list of what is protected.
export const UNATTENDED_MANDATE =
  "This is an UNATTENDED run: no person is watching this session. Reversible actions run without asking. " +
  "Anything in a protected decision category goes through `cast decide` and waits for the answer. " +
  "Your own task branch is yours: committing and pushing it is part of the work. " +
  "Never ask an inline question; nobody will answer it. End your turn with the structured command your briefing names, " +
  "never with a bare summary.";

export function applyUnattended(prompt: string): string {
  return `${UNATTENDED_MANDATE}\n\n${prompt}`;
}

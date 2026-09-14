// The mandate every unattended run opens with: the CLI's `cast task start
// --spawn` and the line's nodes prefix it (packages/cli/src/unattended.ts),
// and the server prefixes it on a hand a role starts (convex/spawn.ts). One
// copy, so a hand and a spawned run read the same rules.
export const UNATTENDED_MANDATE =
  "This is an UNATTENDED run: no person is watching this session. Reversible actions run without asking. " +
  "Anything in a protected decision category goes through `cast decide` and waits for the answer. " +
  "Your own task branch is yours: committing and pushing it is part of the work. " +
  "Never ask an inline question; nobody will answer it. End your turn with the structured command your briefing names, " +
  "never with a bare summary.";

export function applyUnattended(prompt: string): string {
  return `${UNATTENDED_MANDATE}\n\n${prompt}`;
}

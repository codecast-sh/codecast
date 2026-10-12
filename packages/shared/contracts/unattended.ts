// What every unattended session opens with: a workflow station's hand
// (packages/cli/src/workflow/runner.ts stationBrief), a `cast spawn
// --unattended` run, and a hand a role starts (convex/spawn.ts handBriefing).
// It holds only what is true of all of them. What one kind of run may do (its
// branch, its ending command) belongs to that run's own brief.
export const UNATTENDED_MANDATE =
  "This session was started by an automated codecast run, and no person is watching it. " +
  "Whatever started it reads the outcome from the command your brief asks you to end with, so end your turn with that command. " +
  "When the brief names none, pin the outcome with `cast state --status done`, or `--status blocked` when you could not finish. " +
  "A closing summary on its own reaches nobody. " +
  "Work without stopping to ask: a question typed into this session gets no answer. " +
  "A choice that belongs to a person (one that is hard to undo, or that touches production, money, stored data, access or people outside the team) " +
  "goes to them through `cast decide`, and you wait for the answer.";

/** The mandate, the run that started the session when the caller can name it, then the brief. */
export function applyUnattended(prompt: string, startedBy?: string): string {
  return `${UNATTENDED_MANDATE}${startedBy ? `\nStarted by: ${startedBy}.` : ""}\n\n${prompt}`;
}

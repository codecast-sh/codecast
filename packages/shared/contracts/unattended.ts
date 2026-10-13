// How every unattended session opens: a workflow station's hand
// (packages/cli/src/workflow/runner.ts stationBrief), a `cast spawn
// --unattended` run, and a hand a role starts (convex/spawn.ts handBriefing).
// It says only what is true of all of them. What one kind of run may do (its
// branch, its ending command) belongs to that run's own brief.
export function unattendedOpening(startedBy = "an automated codecast run"): string {
  return [
    `You are running unattended: ${startedBy} started this session, and no person is watching it.`,
    "It reads only how your turn ends, so end with the command your brief names. If it names none, pin the outcome with `cast state --status done`, or `--status blocked` if you could not finish.",
    "Nobody answers a question asked here. A decision that is a person's to make (hard to undo, or touching production, money, stored data, access or people outside the team) goes through `cast decide`, and you wait for the answer.",
  ].join("\n");
}

/** The opening, then the brief. `startedBy` names the run when the caller knows it. */
export function applyUnattended(prompt: string, startedBy?: string): string {
  return `${unattendedOpening(startedBy)}\n\n${prompt}`;
}

// The opening of an unattended session (docs/architecture/the-line.md L11). A
// hand launches permissive, with the same bypass flags every daemon-started
// session gets, so the fence is the mandate in its briefing, the way a
// safe-mode trigger run carries SAFE_MODE_MANDATE (taskScheduler.ts). The text
// lives in the shared contracts so the server can open a role's hand with it
// (convex/spawn.ts handBriefing); re-exported here for the CLI's own callers.
export { UNATTENDED_MANDATE, applyUnattended } from "@codecast/shared/contracts";

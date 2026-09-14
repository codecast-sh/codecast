// Unattended principal (docs/architecture/the-line.md L4). A hand started by
// the line runs with nobody at the keyboard: it launches permissive (the same
// bypass flags every daemon-started session gets), so the fence is the mandate
// in its briefing, the way a safe-mode trigger run carries SAFE_MODE_MANDATE
// (taskScheduler.ts). ONE string, prefixed to the first prompt by
// `cast spawn --unattended` and by the workflow runner's session nodes. It
// states the principle; the role's configured decision categories carry the
// list of what is protected.
// The mandate lives in the shared contracts so the server can prefix it on a
// hand a role starts (convex/spawn.ts handBriefing); re-exported here for
// the CLI's own callers.
export { UNATTENDED_MANDATE, applyUnattended } from "@codecast/shared/contracts";

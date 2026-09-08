// Re-export of the shared fence. The implementation moved to
// @codecast/shared/contracts/fence so the capability store, the task prompt
// Convex builds and `cast task context` share ONE fence — the threat model and
// field notes are in that file's header and the git history of this one.
export { fenceForeignText, fenceUnlessBuiltin } from "@codecast/shared/contracts";

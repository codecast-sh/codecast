// Re-export of the shared sanitizer. The implementation moved to
// @codecast/shared/contracts/sanitizeText so the CLI's skill emitter and this
// ingest path share ONE function — the original threat model and field notes
// are in that file's header and the git history of this one.
export { MAX_FOREIGN_TEXT_LENGTH, sanitizeForeignText } from "@codecast/shared/contracts";

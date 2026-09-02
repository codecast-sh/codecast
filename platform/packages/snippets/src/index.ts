// @platform/snippets — the idempotent, hash-stamped section installer for
// CLAUDE.md / AGENTS.md instruction files.
//
// The engine owns the mechanics: recognizing an installer-owned section by
// heading and end marker, rewriting it in place without touching the user's
// surrounding text, fanning one section out to several instruction files,
// deciding rewrites by content hash instead of version bumps, and planning
// server-gated enables. It ships no snippet bodies of its own except the
// platform doctrine sections (@platform/snippets/doctrine) — every consumer
// brings its own catalog of SnippetDefinitions.

export type {
  SectionSpec,
  SnippetSection,
  SnippetDefinition,
  SnippetInstallResult,
  SnippetTarget,
  SnippetFs,
} from "./types";

export { findOwnedSections, cutOwnedSections, applySnippet, sectionBody, type OwnedBlock } from "./sections";
export { snippetContentHash } from "./hash";
export { snippetHashKey, snippetStale, stampSnippet } from "./rewriteKey";
export { planGatedSnippets, type GatedSnippetPlan } from "./gating";
export { nodeFs, memoryFs, type MemoryFs } from "./fs";
export { resolveTargets, type TargetCandidate, type ResolvedTarget } from "./targets";
export {
  installSectionToFile,
  installSectionToTargets,
  removeSectionFromTargets,
  install,
  type InstallOptions,
  type InstallReport,
} from "./install";

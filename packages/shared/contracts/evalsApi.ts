// The Evals UI's wire contract (docs/architecture/evals-ui.md, sections 3.4
// and 3.7). Three parties read it and must agree: the eval tool's api child
// (`bun packages/evals/src/index.ts api --stdio`), the daemon's /evals bridge
// that forwards to it, and the web pages under /evals with their fixture
// transport.
//
// Everything here describes data that lives on the laptop that ran the evals
// (EVALS_HOME and the sim session folders). None of it may be stored in
// Convex, IndexedDB or a published page.
//
// The shapes mirror what is on disk: run.json, result.json and score.json in
// a run folder (packages/evals/src/layout.ts and @platform/evals' model), the
// guard's calls.log marks (packages/cli/scripts/prompt-dry-run-bin/cast), and
// the multiplayer sim's artifacts (packages/web/store/__tests__/sim/report.ts
// and dsl.ts). The platform's own types are not imported, because this
// package does not depend on @platform/evals; the api child maps them in.
//
// PURE isomorphic data: no Node or DOM APIs.

export type { EvalFlip, EvalRunSet, EvalSeparation } from "./evalResult";

// The contract lives in parts under evalsApi/, by section; this file is the
// one import path every party uses.
export * from "./evalsApi/core";
export * from "./evalsApi/bisect";
export * from "./evalsApi/sim";
export * from "./evalsApi/endpoints";
export * from "./evalsApi/routes";

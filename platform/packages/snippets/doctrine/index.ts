// @platform/snippets/doctrine — shared doctrine sections the platform ships,
// and the helper that stamps them into a consumer repo's AGENTS.md.
//
// Doctrine is the platform's counterpart of a consumer's snippet catalog: the
// engine rules every app built on @platform packages should hold its agents
// to, written once here instead of copied into each repo by hand. Stamping is
// the same idempotent section machinery as any snippet, so a repo's own
// AGENTS.md prose survives and a re-stamp with unchanged bytes writes nothing.

import { install, type InstallReport } from "../src/install";
import { nodeFs } from "../src/fs";
import type { SnippetDefinition, SnippetFs } from "../src/types";
import { LOCAL_FIRST_STORE } from "./localFirstStore";

export { LOCAL_FIRST_STORE, LOCAL_FIRST_STORE_BODY, LOCAL_FIRST_STORE_END } from "./localFirstStore";

/** Every doctrine section the platform ships, in stamp order. */
export const DOCTRINE: SnippetDefinition[] = [LOCAL_FIRST_STORE];

/**
 * Stamp doctrine sections into one instruction file, usually a repo's
 * AGENTS.md. Idempotent: an existing section is refreshed in place, an
 * up-to-date one is left alone (the mtime does not move), and everything the
 * repo wrote around the sections survives byte for byte.
 */
export function stampDoctrine(opts: {
  filePath: string;
  sections?: SnippetDefinition[];
  fs?: SnippetFs;
}): InstallReport {
  return install(opts.sections ?? DOCTRINE, {
    targets: [{ filePath: opts.filePath }],
    enabled: () => true,
    fs: opts.fs ?? nodeFs,
  });
}

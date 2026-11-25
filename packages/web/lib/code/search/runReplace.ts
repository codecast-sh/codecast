// Running a project replace: the planned edits per file, written through
// writeBack (open buffers in place, the rest compare-and-swap on disk). Loaded
// on demand from the Search pane, since it reaches into the editor's buffers.

import { bufferKey, codeBuffers } from "../buffers";
import { compileQuery, type ProjectQuery } from "./query";
import { planReplace, type MatchTarget, type ReplaceEdit } from "./replace";
import { editFiles, type FileEditOutcome, type WriteBackIO } from "./writeBack";

export interface ReplaceRequest {
  /** The vault searched; nothing is written when Files shows another. */
  vaultId: string | null;
  query: ProjectQuery;
  replacement: string;
  preserveCase: boolean;
  /** The matches to replace, by file: what the results show. */
  targets: Map<string, MatchTarget[]>;
  /** Where to read and write; the searched vault when absent (tests pass one). */
  io?: WriteBackIO;
}

export type ReplaceOutcome = Omit<FileEditOutcome, "edits"> & { edits?: ReplaceEdit[] };

/** The files among `paths` open in an editor buffer. */
export function openPaths(vaultId: string | null, paths: string[]): string[] {
  return vaultId ? paths.filter((p) => !!codeBuffers.get(bufferKey(vaultId, p))) : [];
}

// One replace at a time. Targets are positions from the search, refreshed only
// once a replace resolves; a second run in that window would plan against text
// the first already changed, and a replacement that still matches (foo -> foo2)
// would be applied twice.
let running = false;

export function replaceRunning(): boolean {
  return running;
}

/** Replaces the targets, or returns null without touching anything while another replace runs. */
export async function runReplace(req: ReplaceRequest): Promise<ReplaceOutcome[] | null> {
  if (running) return null;
  running = true;
  try {
    return await replaceTargets(req);
  } finally {
    running = false;
  }
}

async function replaceTargets(req: ReplaceRequest): Promise<ReplaceOutcome[]> {
  const compiled = compileQuery(req.query);
  if (!compiled.re) return [...req.targets.keys()].map((path) => ({ path, status: "error" as const, detail: compiled.error }));
  const re = compiled.re;
  const opts = { regex: req.query.regex, preserveCase: req.preserveCase };
  return (await editFiles(
    [...req.targets].map(([path, targets]) => ({
      path,
      compute: (text: string) => {
        const plan = planReplace(text, re, req.replacement, opts, targets);
        if (plan.missing.length) {
          const m = plan.missing[0];
          return { refuse: `Line ${m.line} changed since the search` };
        }
        return plan.edits;
      },
    })),
    req.io ?? req.vaultId,
  )) as ReplaceOutcome[];
}

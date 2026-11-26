// The files a repository writes from its own sources, each set with the
// command that writes it: `.codecast/generated.toml`, one [[generated]] table
// per generator.
//
//   [[generated]]
//   paths = ["packages/web/lib/line/shippedFlows*.generated.ts"]   # globs over repo paths
//   run = "bun packages/cli/scripts/gen-shipped-flows.ts"          # run from the repo's top
//
// The Merge station (mergeStation.ts) reads it from the default branch, never
// from the change, as it reads its deploy steps. A rebase that conflicts only
// in these files is not the change's session's to resolve: Merge takes the
// default branch's side and runs their generators over the rebased tree.

import type { Exec } from "../lineMerge.js";

export type Generator = { paths: string[]; run: string };

export const GENERATED_FILE = ".codecast/generated.toml";

const matches = (glob: string, file: string) => new Bun.Glob(glob).match(file);

/** The generators `.codecast/generated.toml` names at `rev`: none when there is no such file, and an error saying
 *  why when it cannot be read (Merge then resolves nothing itself). */
export function readGenerators(exec: Exec, cwd: string, rev: string): { generators: Generator[]; error?: string } {
  const shown = exec("git", ["show", `${rev}:${GENERATED_FILE}`], cwd);
  if (shown.status !== 0) return { generators: [] };
  let raw: any;
  try { raw = Bun.TOML.parse(shown.stdout); } catch (err) {
    return { generators: [], error: `${GENERATED_FILE} is not TOML: ${err instanceof Error ? err.message : String(err)}` };
  }
  const tables = raw?.generated ?? [];
  if (!Array.isArray(tables)) return { generators: [], error: `${GENERATED_FILE}: 'generated' must be an array of tables ([[generated]])` };
  const generators: Generator[] = [];
  for (const [i, t] of tables.entries()) {
    const paths = t?.paths;
    if (!Array.isArray(paths) || !paths.length || paths.some((p: unknown) => typeof p !== "string" || !p)) return { generators: [], error: `${GENERATED_FILE}: generated[${i}].paths must list globs` };
    if (typeof t.run !== "string" || !t.run.trim()) return { generators: [], error: `${GENERATED_FILE}: generated[${i}].run must be a command` };
    generators.push({ paths, run: t.run });
  }
  return { generators };
}

/** The generators that write `files`, in the list's order; null when a file is none of theirs. */
export function generatorsFor(generators: Generator[], files: string[]): Generator[] | null {
  if (files.some((f) => !generators.some((g) => g.paths.some((p) => matches(p, f))))) return null;
  return generators.filter((g) => files.some((f) => g.paths.some((p) => matches(p, f))));
}

/** Whether one of `generators` writes `file`. */
export function writtenBy(generators: Generator[], file: string): boolean {
  return generators.some((g) => g.paths.some((p) => matches(p, file)));
}

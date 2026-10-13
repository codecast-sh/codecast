// A fix's diff read for review (line-journeys.md "Built fixes to review"): the
// change a person judges comes first, and the files a test suite regenerates
// (fixtures, snapshots, golden outputs) fold under one row, since fifty
// one-line fixture rewrites listed beside four source files hide the change.
// Pure.

/** A path a test suite writes rather than a person: under a fixtures, snapshots, golden or testdata directory, or a
 *  snapshot file. */
const GENERATED = /(?:^|\/)(?:__fixtures__|__snapshots__|fixtures|snapshots|testdata|golden|goldens)\//i;
export const isGeneratedFile = (path: string): boolean => GENERATED.test(path) || /\.snap$/i.test(path);

export type DiffFold<F> = {
  /** The files a person reads, in the diff's order. */
  change: F[];
  /** The regenerated files, folded. */
  generated: F[];
  /** The fold row's words: "48 fixture files, +1 −1 each", or the sums when they differ. Null when none. */
  words: string | null;
};

export function foldGenerated<F extends { filename: string; additions: number; deletions: number }>(files: ReadonlyArray<F>): DiffFold<F> {
  const change: F[] = [];
  const generated: F[] = [];
  for (const f of files) (isGeneratedFile(f.filename) ? generated : change).push(f);
  // Fold only when there is a change to read first; a diff of fixtures alone is the change.
  if (!change.length || !generated.length) return { change: [...files], generated: [], words: null };
  const n = generated.length;
  const kind = generated.every((f) => /\.snap$|__snapshots__|snapshots\//i.test(f.filename)) ? "snapshot" : "fixture";
  const same = generated.every((f) => f.additions === generated[0].additions && f.deletions === generated[0].deletions);
  const added = generated.reduce((t, f) => t + f.additions, 0);
  const removed = generated.reduce((t, f) => t + f.deletions, 0);
  const sizes = same && n > 1 ? `+${generated[0].additions} −${generated[0].deletions} each` : `+${added} −${removed}`;
  return { change, generated, words: `${n} ${kind} ${n === 1 ? "file" : "files"}, ${sizes}` };
}

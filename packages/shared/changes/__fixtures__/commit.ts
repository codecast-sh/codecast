// A commit record for tests: defaults for everything a case does not name,
// and areas derived from paths the way buildDay's projection derives them.
import { summarizeFiles } from "../classify";
import type { ChangeCommit } from "../types";

export const T0 = Date.UTC(2026, 9, 2, 14, 0, 0);
export const MIN = 60_000;

export function commit(over: Partial<ChangeCommit> & { sha: string; paths?: Record<string, number> }): ChangeCommit {
  const { paths = {}, ...rest } = over;
  const files = Object.entries(paths).map(([filename, lines]) => ({ filename, additions: lines, deletions: 0 }));
  const summary = summarizeFiles(files);
  return {
    subject: "feat: change",
    author_name: "Ashot Petrosian",
    author_email: "ashot@example.com",
    timestamp: T0,
    branch: "main",
    insertions: files.reduce((n, f) => n + f.additions, 0),
    deletions: 0,
    ...summary,
    ...rest,
  };
}

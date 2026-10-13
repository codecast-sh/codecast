// What blocks a station that pinned itself blocked, read as a cause a person can clear. A station
// blocked by a bug in a file it runs ("freeze.ts --json output gets cut off when piped") is held by
// that file's fix, not by its instructions or by starting it again: the cause names the file, and its
// act is the fix (an open task that names the file, else one to file).

/** A source or script file a blocker names, path kept ("scripts/freeze.ts"). */
const FILE = /(?:^|[\s(`'"])((?:[\w.-]+\/)*[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|sh|rb|go|rs|swift|kt|java|sql))(?=$|[\s)`'",.:;])/;

/** The file a blocker names, else null. */
export function blockerFile(reason: string | null | undefined): string | null {
  return FILE.exec(reason ?? "")?.[1] ?? null;
}

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The clause of a blocker that says what is wrong with its file ("freeze.ts --json output gets cut off when piped
 *  (process.exit before stdout drains)"): a fix's title, whole. */
export function blockerClause(reason: string, file: string): string {
  const parts = reason.replace(/\s+/g, " ").split(/:\s+|;\s+|,\s+(?=(?:so|but|and|which)\b)|\.\s+(?=[A-Z])/);
  const hit = parts.find((p) => p.includes(file)) ?? reason;
  return hit.trim().replace(/[.,;:]+$/, "");
}

/** A blocked station's cause: by the file it names (every run that file blocks is one heading, in whole words), else by
 *  its own reason. */
export function blockerCause(stepId: string, reason: string): { key: string; label: string; file: string | null } {
  const file = blockerFile(reason);
  if (file) return { key: `blocked:${stepId}:${file.toLowerCase()}`, label: `Blocked by a tooling bug in ${base(file)}`, file };
  const said = reason.replace(/\s+/g, " ").trim();
  return { key: `blocked:${stepId}:${said.toLowerCase()}`, label: `Blocked: ${said}`, file: null };
}

type FixTask = { _id: string; short_id?: string; title?: string; description?: string; status?: string };
const num = (t: FixTask) => Number(/\d+$/.exec(t.short_id ?? "")?.[0] ?? 0);
const OPEN = (s: string | undefined) => !/^(done|dropped|closed|cancell?ed|wontfix|archived)$/.test(s ?? "");

/** The open task that fixes a file: one whose title or description names the file, newest first, none of `not` (the
 *  blocked problems themselves). */
export function fixTaskFor<T extends FixTask>(file: string, tasks: Iterable<T>, not: ReadonlySet<string> = new Set()): T | null {
  const name = base(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = new RegExp(`(?:^|[^\\w.-])${name}(?![\\w-])`);
  let best: T | null = null;
  for (const t of tasks) {
    if (not.has(t._id) || !OPEN(t.status)) continue;
    if (!names.test(`${t.title ?? ""}\n${t.description ?? ""}`)) continue;
    if (!best || num(t) > num(best)) best = t;
  }
  return best;
}

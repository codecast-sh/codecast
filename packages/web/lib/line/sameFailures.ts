// The error groups a problem names (line-journeys.md LJ6.3 Assigned): a
// problem about an outage in a named service ("AssemblyAI account out of
// funds") is read against the product's own error log, so its reader can say
// whether the failure is still happening. A service is named the way products
// write their names, in mixed case ("AssemblyAI", "PostHog", "OpenAI"); a
// group whose title names the same service is the same failure. Pure.

export type FailureGroup = { _id: string; short_id?: string; title: string; kind?: string; count?: number; first_seen?: number; last_seen?: number };
export type SameFailures = { name: string; refs: string[]; count: number; first: number; last: number };

const SERVICE = /\b(?:[A-Z][a-z]+[A-Z][A-Za-z]*|[A-Z]{2,}[a-z][A-Za-z]*)\b/g;

/** The service names a title gives, in the order it gives them. */
export const serviceNames = (title: string): string[] => [...new Set(title.match(SERVICE) ?? [])];

/** The error groups that name the first service a problem's title names that any group names: every one of them, with
 *  how often it failed and when it first and last did. Null when the title names no service the log knows. */
export function sameFailures(title: string, groups: ReadonlyArray<FailureGroup>): SameFailures | null {
  for (const name of serviceNames(title)) {
    const word = new RegExp(`\\b${name}\\b`);
    const hit = groups.filter((g) => (g.kind ?? "error") === "error" && g.last_seen && word.test(g.title));
    if (!hit.length) continue;
    return {
      name,
      refs: hit.map((g) => g.short_id ?? g._id).sort(),
      count: hit.reduce((n, g) => n + (g.count ?? 0), 0),
      first: Math.min(...hit.map((g) => g.first_seen ?? g.last_seen!)),
      last: Math.max(...hit.map((g) => g.last_seen!)),
    };
  }
  return null;
}

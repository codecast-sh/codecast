// How the task timeline tells a change to the task graph (task-graph.md TG11).
// recordTaskChange stores a list as "ct-1, ct-2" and a wait as its line
// ("Waiting on PR #42", "PR #42 merged", "PR #42 merges (failed: …)"), so a
// row is read back by comparing its old and new values.

export type GraphTone = "blocked" | "met" | "failed" | "link";

/** One clause of a change: words, then the tasks it names, then any text. */
export type GraphClause = { verb: string; refs?: string[]; text?: string };

export type GraphChange = { tone: GraphTone; clauses: GraphClause[] };

const GRAPH_FIELDS = new Set(["blocked_by", "waits", "related", "found_during", "superseded_by"]);

const list = (v?: string) => (v ? v.split(", ").filter(Boolean) : []);

/** The change a graph history row records, or null for any other row. */
export function graphChange(row: { field?: string; old_value?: string; new_value?: string }): GraphChange | null {
  if (!row.field || !GRAPH_FIELDS.has(row.field)) return null;
  const [from, to] = [row.old_value ?? "", row.new_value ?? ""];
  switch (row.field) {
    case "blocked_by":
    case "related": {
      const [was, now] = [list(from), list(to)];
      const added = now.filter((r) => !was.includes(r));
      const removed = was.filter((r) => !now.includes(r));
      const blocking = row.field === "blocked_by";
      const clauses: GraphClause[] = [];
      if (added.length) clauses.push({ verb: blocking ? "made it wait on" : "linked it to", refs: added });
      if (removed.length) clauses.push({ verb: blocking ? (added.length ? "and removed" : "removed blocker") : added.length ? "and unlinked" : "unlinked", refs: removed });
      return clauses.length ? { tone: blocking ? (added.length ? "blocked" : "met") : "link", clauses } : null;
    }
    case "found_during":
      return to
        ? { tone: "link", clauses: [{ verb: "found it while working on", refs: [to] }] }
        : { tone: "link", clauses: [{ verb: "cleared found during", refs: [from] }] };
    case "superseded_by":
      return to
        ? { tone: "link", clauses: [{ verb: "superseded it with", refs: [to] }] }
        : { tone: "link", clauses: [{ verb: "brought it back from", refs: [from] }] };
    case "waits":
      // A new wait's line is its own clause: "Waiting on PR #42" reads "made it wait on PR #42".
      if (!from) return to.startsWith("Waiting ")
        ? { tone: "blocked", clauses: [{ verb: "made it wait", text: to.slice("Waiting ".length) }] }
        : { tone: "met", clauses: [{ verb: "set a wait, already met:", text: to }] };
      if (!to) return { tone: "met", clauses: [{ verb: "removed the wait:", text: from }] };
      if (to.startsWith("Waiting")) return { tone: "blocked", clauses: [{ verb: "reopened the wait:", text: to }] };
      if (/\(failed\b/.test(to)) return { tone: "failed", clauses: [{ verb: "wait failed:", text: to }] };
      return { tone: "met", clauses: [{ verb: "wait met:", text: to }] };
  }
  return null;
}

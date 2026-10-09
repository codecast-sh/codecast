// How a timeline tells a change to the task graph (task-graph.md TG11), for
// the web's Activity and `cast task show`'s History alike. recordTaskChange
// stores a list as "ct-1, ct-2" and a wait as its line (graph.ts waitLine:
// "Waiting on PR #42", "PR #42 merged", "Wait on PR #6 failed: …"), so a row
// is read back by comparing its old and new values. Each phrase follows its
// actor: "Ashot made it wait on PR #42", "codecast saw the wait met: …".

import { waitLineParts } from "./graph";

/** `withdrawn` is an edge someone deleted: a surface draws it dim, never with
 *  `met`'s green check, because "removed blocker ct-12" and "ct-12 finished"
 *  say opposite things about whether the work got done. */
export type GraphTone = "blocked" | "met" | "failed" | "link" | "withdrawn";

/** One clause of a change: words, then the tasks it names, then any text. */
export type GraphClause = { verb: string; refs?: string[]; text?: string };

export type GraphChange = { tone: GraphTone; clauses: GraphClause[] };

const GRAPH_FIELDS = new Set(["blocked_by", "waits", "related", "found_during", "superseded_by"]);

const LIST_SEPARATOR = ", ";

/** A list as a history row stores it: "ct-1, ct-2". */
export function storeList(values: readonly unknown[]): string {
  return values.join(LIST_SEPARATOR);
}

/** A list as a history row stores it (storeList), read back. */
export function parseStoredList(value?: string | null): string[] {
  return value ? value.split(LIST_SEPARATOR).filter(Boolean) : [];
}

/** The change a graph history row records, or null for any other row. */
export function graphChange(row: { field?: string; old_value?: string; new_value?: string }): GraphChange | null {
  if (!row.field || !GRAPH_FIELDS.has(row.field)) return null;
  const [from, to] = [row.old_value ?? "", row.new_value ?? ""];
  switch (row.field) {
    case "blocked_by":
    case "related": {
      const [was, now] = [parseStoredList(from), parseStoredList(to)];
      const added = now.filter((r) => !was.includes(r));
      const removed = was.filter((r) => !now.includes(r));
      const blocking = row.field === "blocked_by";
      const clauses: GraphClause[] = [];
      if (added.length) clauses.push({ verb: blocking ? "made it wait on" : "marked it related to", refs: added });
      if (removed.length) clauses.push({ verb: blocking ? (added.length ? "and removed" : "removed blocker") : added.length ? "and unmarked" : "unmarked related", refs: removed });
      return clauses.length ? { tone: blocking ? (added.length ? "blocked" : "withdrawn") : "link", clauses } : null;
    }
    case "found_during":
      return to
        ? { tone: "link", clauses: [{ verb: "found it while working on", refs: [to] }] }
        : { tone: "link", clauses: [{ verb: "no longer counts it as found while working on", refs: [from] }] };
    case "superseded_by":
      return to
        ? { tone: "link", clauses: [{ verb: "superseded it with", refs: [to] }] }
        : { tone: "link", clauses: [{ verb: "brought it back from", refs: [from] }] };
    case "waits": {
      // A wait's own line is its clause: "Waiting on PR #42" reads "made it wait on PR #42".
      if (!from) {
        const { state, clause, note } = waitLineParts(to);
        if (state === "waiting") return { tone: "blocked", clauses: [{ verb: "made it wait", text: clause }] };
        return { tone: "met", clauses: [clause ? { verb: "made it wait", text: `${clause}, ${note}` } : { verb: "made it wait, already met:", text: to }] };
      }
      if (!to) {
        // The wait was deleted, whatever state it had reached: withdrawn, not met.
        const { state, clause } = waitLineParts(from);
        if (!clause) return { tone: "withdrawn", clauses: [{ verb: "removed the wait:", text: from }] };
        return { tone: "withdrawn", clauses: [{ verb: state === "waiting" ? "stopped waiting" : "removed the wait", text: clause }] };
      }
      const { state, clause, note } = waitLineParts(to);
      if (state === "waiting") return { tone: "blocked", clauses: [{ verb: "reopened the wait", text: clause }] };
      if (state === "failed") {
        return {
          tone: "failed",
          clauses: clause
            ? [{ verb: "marked the wait", text: clause }, { verb: note ? "failed:" : "failed", text: note }]
            : [{ verb: "marked the wait failed:", text: to }],
        };
      }
      return { tone: "met", clauses: [{ verb: "saw the wait met:", text: to }] };
    }
  }
  return null;
}

/** A graph change as plain words after its actor: "made it wait on PR #42". */
export function graphChangeText(change: GraphChange): string {
  return change.clauses.map((c) => [c.verb, c.refs?.join(", "), c.text].filter(Boolean).join(" ")).join(" ");
}

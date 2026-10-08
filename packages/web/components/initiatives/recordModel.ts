// A goal's record in parts (docs/architecture/initiatives-projects-role-page.md
// I5): which parts hold something, and the record in a few words for the
// fold that carries it.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";

export type RecordPart = "done_when" | "milestones" | "questions" | "decisions" | "sources";
export const RECORD_PARTS: readonly RecordPart[] = ["done_when", "milestones", "questions", "decisions", "sources"];

/** Which parts of the record hold something. */
export function recordParts(g: InitiativeRow): RecordPart[] {
  return RECORD_PARTS.filter((p) => (p === "done_when" ? !!g.done_when?.trim() : (g[p]?.length ?? 0) > 0));
}

/** The record in a few words, for its fold: "done when · 2 milestones · 1 question". */
export function recordHint(g: InitiativeRow): string {
  const n = (k: number, one: string, many: string) => (k ? `${k} ${k === 1 ? one : many}` : null);
  const open = (g.questions ?? []).filter((q) => !q.answer).length;
  return [
    g.done_when?.trim() ? "done when" : null,
    n(g.milestones?.length ?? 0, "milestone", "milestones"),
    n(open, "question", "questions"),
    n(g.decisions?.length ?? 0, "decision", "decisions"),
    n(g.sources?.length ?? 0, "source", "sources"),
  ].filter(Boolean).join(" · ");
}


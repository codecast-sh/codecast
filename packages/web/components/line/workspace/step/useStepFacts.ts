// The run facts every reading of a step's work shares (the Steps table, the
// Map, a step's page): why each run failed where it failed, which runs only
// stopped needing a yes, and which problems have closed since. One source, so
// a step's Failed reads the same number wherever it is drawn.
import { useMemo } from "react";
import type { LineModel } from "../../../../lib/line/lineModel";
import { closedProblems, newestRuns, type Standing } from "../../../../lib/line/stepWork";
import { lessonOnlyIds } from "../../../../lib/line/problemTable";
import { runFactsByStep, stepTable } from "../../../../lib/line/stepTable";
import type { LineWorkspace } from "../../../../hooks/useLineWorkspace";
import type { LineSelection } from "../../../../lib/line/lineWorkspaceUrl";
import { useProblemList } from "../views/timeline/useProblemList";

/** The Problems list unfiltered: every process, no chip or search. */
const UNFILTERED = {} as LineSelection;

export function useStepFacts(model: LineModel, ws: LineWorkspace) {
  const facts = useMemo(() => runFactsByStep(ws.rows.runs as unknown as Parameters<typeof runFactsByStep>[0]), [ws.rows.runs]);
  const closed = useMemo(() => closedProblems(ws.rows.tasks as unknown as Array<{ _id: string; status?: string | null }>), [ws.rows.tasks]);
  // Each problem's newest run: a failure in an older one is no longer where the problem stands.
  const newest = useMemo(() => newestRuns((ws.rows.runs as unknown as Array<{ _id: string; task_id?: string | null; created_at: number }>).map((r) => ({ id: r._id, caseId: r.task_id ?? null, at: r.created_at }))), [ws.rows.runs]);
  // Where each problem stands on Problems: a step counts a failure only where Problems files it, so a step's Failed and
  // Problems' Failed headings read one number. A lesson for the line is no product problem: Problems never lists it.
  const list = useProblemList(model, ws, UNFILTERED);
  const standing = useMemo(() => {
    const out = new Map<string, Standing>(list.all.map((r) => [r.id, { now: r.stand.phrase, failedAt: r.stand.status === "failed" ? r.stand.cause?.steps ?? [] : undefined }]));
    for (const id of lessonOnlyIds(ws.sources)) out.set(id, { now: "A lesson for the line" });
    return out;
  }, [list.all, ws.sources]);
  return { facts, closed, newest, standing, problems: list.all };
}

/** The Steps table's rows: every step with the counts its page opens on. */
export function useStepTable(model: LineModel, ws: LineWorkspace) {
  const { facts, closed, newest, standing } = useStepFacts(model, ws);
  // "On you" is the viewer's own needs, the source For you and the Problems page read: a decision another person holds is theirs.
  return useMemo(() => stepTable(model, facts, closed, ws.needs, newest, standing), [model, facts, closed, ws.needs, newest, standing]);
}

// The run facts every reading of a step's work shares (the Steps table, the
// Map, a step's page): why each run failed where it failed, which runs only
// stopped needing a yes, and which problems have closed since. One source, so
// a step's Failed reads the same number wherever it is drawn.
import { useMemo } from "react";
import type { LineModel } from "../../../../lib/line/lineModel";
import { closedProblems, newestRuns } from "../../../../lib/line/stepWork";
import { runFactsByStep, stepTable } from "../../../../lib/line/stepTable";
import type { LineWorkspace } from "../../../../hooks/useLineWorkspace";

type Rows = Pick<LineWorkspace, "rows">;

export function useStepFacts(ws: Rows) {
  const facts = useMemo(() => runFactsByStep(ws.rows.runs as unknown as Parameters<typeof runFactsByStep>[0]), [ws.rows.runs]);
  const closed = useMemo(() => closedProblems(ws.rows.tasks as unknown as Array<{ _id: string; status?: string | null }>), [ws.rows.tasks]);
  // Each problem's newest run: a failure in an older one is no longer where the problem stands.
  const newest = useMemo(() => newestRuns((ws.rows.runs as unknown as Array<{ _id: string; task_id?: string | null; created_at: number }>).map((r) => ({ id: r._id, caseId: r.task_id ?? null, at: r.created_at }))), [ws.rows.runs]);
  return { facts, closed, newest };
}

/** The Steps table's rows: every step with the counts its page opens on. */
export function useStepTable(model: Pick<LineModel, "steps" | "order">, ws: Pick<LineWorkspace, "rows" | "needs">) {
  const { facts, closed, newest } = useStepFacts(ws);
  // "On you" is the viewer's own needs, the source For you and the Problems page read: a decision another person holds is theirs.
  return useMemo(() => stepTable(model, facts, closed, ws.needs, newest), [model, facts, closed, ws.needs, newest]);
}

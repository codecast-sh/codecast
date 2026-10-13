// The run facts every reading of a step's work shares (the Steps table, the
// Map, a step's page): why each run failed where it failed, which runs only
// stopped needing a yes, and which problems have closed since. One source, so
// a step's Failed reads the same number wherever it is drawn.
import { useMemo } from "react";
import type { LineModel } from "../../../../lib/line/lineModel";
import { closedProblems } from "../../../../lib/line/stepWork";
import { runFactsByStep, stepTable } from "../../../../lib/line/stepTable";
import type { LineWorkspace } from "../../../../hooks/useLineWorkspace";

type Rows = Pick<LineWorkspace, "rows">;

export function useStepFacts(ws: Rows) {
  const facts = useMemo(() => runFactsByStep(ws.rows.runs as unknown as Parameters<typeof runFactsByStep>[0]), [ws.rows.runs]);
  const closed = useMemo(() => closedProblems(ws.rows.tasks as unknown as Array<{ _id: string; status?: string | null }>), [ws.rows.tasks]);
  return { facts, closed };
}

/** The Steps table's rows: every step with the counts its page opens on. */
export function useStepTable(model: Pick<LineModel, "steps" | "order">, ws: Rows) {
  const { facts, closed } = useStepFacts(ws);
  return useMemo(() => stepTable(model, facts, closed), [model, facts, closed]);
}

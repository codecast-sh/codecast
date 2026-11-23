// Whether a settled decision still takes a person's new answer. An answer
// that only told the agent what to do (a person's pick, a role's or a
// standing rule's answer, a stack default, a dismissal) is a course the agent
// is on, and a person may change it: the new answer reaches the agent as one
// more message naming the answer it replaces. An answer that already acted on
// its own stays settled: a gate a run routed on, a blocking change card, a Run that
// executed its command, a silent pointer, a trial, and a Vault access grant.
// ONE rule for the dispatch guard, the server's settle hook and both apps, so
// no rail accepts what another refuses.
export interface ChangeableAnswerRow {
  status: string;
  blocking?: boolean;
  workflow_run_id?: unknown;
  card?: unknown;
  run?: unknown;
  silent?: boolean;
  trial?: unknown;
  category?: string;
}

export function answerChangeable(d: ChangeableAnswerRow): boolean {
  return (d.status === "answered" || d.status === "dismissed")
    && !d.workflow_run_id && (!d.card || d.blocking === false) && !d.run && !d.silent && !d.trial && d.category !== "access";
}

// One event on a line's timeline (convex lineTimeline.page, web
// lib/line/lineTimeline.ts): what happened, where it came from, when, and the
// objects it names, by short id where one exists (task, run and signal by id
// too, so the web resolves them from its store). Decision events are derived
// on the web from the decision collection and carry the decision fields.
export type TimelineKind =
  | "moment" | "judged" | "review"
  | "finding"
  | "problem_opened" | "problem_merged" | "problem_closed"
  | "error" | "replay"
  | "run_started" | "station" | "run_ended"
  | "decision_asked" | "decision_answered" | "decision_closed"
  | "deploy";

export type TimelineEvent = {
  _id: string;
  workspace: string;
  at: number;
  kind: TimelineKind;
  /** Where it came from, in the source's own key: a finding's source ("judge:comms", "union.desk"), an event source's name, "line", "session". */
  source: string;
  project_id?: string;
  /** The thing's own words: a finding's title, a moment's contact, a problem's title, an error's message, a decision's question. */
  title: string;
  /** A short state word: a run's outcome, a station's, a problem's close, a deploy's status, a judge's finding count, an answer. */
  detail?: string;
  moment?: string;
  review?: string;
  signal?: string;
  signal_ref?: string;
  task?: string;
  task_ref?: string;
  /** The problem a merge folded it into. */
  into_ref?: string;
  /** The problem a split came from, by id. */
  split_from?: string;
  run?: string;
  node?: string;
  session?: string;
  deploy?: string;
  group?: string;
  replay?: string;
  url?: string;
  decision?: string;
  decision_ref?: string;
  /** The session that asked a decision, and its title. */
  conversation?: string;
  session_title?: string;
};

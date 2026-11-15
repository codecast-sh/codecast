// A project's outputs (ct-94262): every pull request, published page, doc and
// image its work produced, each named with the session that made it and the
// task it was for.
//
// The server answers in two parts so the costly one does not re-run on every
// session heartbeat (convex/projectOutputs.ts):
//   - members: the project's sessions and tasks (SP1), and its images;
//   - items: the pull requests, pages and docs of those sessions, tasks and
//     plans, naming each by id only. Its arguments are the member ids, which
//     change only when membership does.
// joinProjectOutputs puts them back into the one object the Outputs view and
// `cast project outputs` read.

export type OutputSession = { id: string; short_id: string | null; title: string };
export type OutputTask = { id: string; short_id: string; title: string };
export type PrGroup = "attention" | "review" | "done";

type OutputBase = {
  id: string;
  title: string;
  href: string;
  updated_at: number;
  session: OutputSession | null;
  task: OutputTask | null;
};

export type OutputPr = OutputBase & {
  kind: "pr";
  repository: string;
  number: number;
  github_url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  /** foldShepherdState: the one word the shepherd card shows. */
  status: string;
  group: PrGroup;
  review_decision: string | null;
  checks_state: string | null;
  behind_by: number | null;
  unresolved_review_count: number | null;
};
export type OutputPage = OutputBase & { kind: "page"; slug: string; version: number; page_kind: string };
export type OutputDoc = OutputBase & { kind: "doc"; doc_type: string };
export type OutputImage = OutputBase & { kind: "image"; url: string; message_id: string };

export type ProjectOutputs = {
  project: { id: string; short_id: string | null; title: string };
  prs: OutputPr[];
  pages: OutputPage[];
  docs: OutputDoc[];
  images: OutputImage[];
  /** A cap cut the read short: older outputs exist past what is shown. */
  truncated: boolean;
};

/** A session the members part found: in the project by SP1, or reached
 *  through a task or plan but working elsewhere (it brings only pull requests
 *  that name a project task). */
export type MemberSession = OutputSession & { task_id: string | null; in_project: boolean };

export type ProjectOutputMembers = {
  project: ProjectOutputs["project"];
  /** In-project sessions newest created first, then the ones working
   *  elsewhere, in the same order; tasks and plans newest created first. */
  sessions: MemberSession[];
  tasks: OutputTask[];
  plan_ids: string[];
  images: OutputImage[];
  truncated: boolean;
};

/** An item names its session and task by id; the join resolves them. */
type ById<T> = Omit<T, "session" | "task"> & { session_id: string | null; task_id: string | null };
export type ProjectOutputItems = {
  project_id: string;
  prs: ById<OutputPr>[];
  pages: ById<OutputPage>[];
  docs: ById<OutputDoc>[];
  truncated: boolean;
};

/** The ids the items part reads by, from the members part, newest created
 *  first (the order the items part's caps keep). Creation order never moves,
 *  so the arguments change only when membership does. */
export function outputItemArgs(m: ProjectOutputMembers): { session_ids: string[]; elsewhere_ids: string[]; task_ids: string[]; plan_ids: string[] } {
  return {
    session_ids: m.sessions.filter((s) => s.in_project).map((s) => s.id),
    elsewhere_ids: m.sessions.filter((s) => !s.in_project).map((s) => s.id),
    task_ids: m.tasks.map((t) => t.id),
    plan_ids: m.plan_ids,
  };
}

/** Which group a pull request sits in: what only the author can clear needs
 *  attention, waiting on CI or reviewers is in review, merged and closed are
 *  done. The same fold the shepherd card reads, so the two never disagree. */
export function prGroupOf(status: string): PrGroup {
  if (status === "merged" || status === "closed") return "done";
  if (status === "conflicts" || status === "behind" || status === "ci_red" || status === "changes_requested") return "attention";
  return "review";
}

/** The two parts as the one object the view reads. Items still loading join
 *  as empty lists. */
export function joinProjectOutputs(m: ProjectOutputMembers, items: ProjectOutputItems | null | undefined): ProjectOutputs {
  const sessions = new Map(m.sessions.map((s) => [s.id, s]));
  const tasks = new Map(m.tasks.map((t) => [t.id, t]));
  const session = (id: string | null): OutputSession | null => {
    const s = id ? sessions.get(id) : undefined;
    return s ? { id: s.id, short_id: s.short_id, title: s.title } : null;
  };
  const task = (id: string | null, sessionId: string | null): OutputTask | null =>
    (id ? tasks.get(id) : undefined) ?? (sessionId && sessions.get(sessionId)?.task_id ? tasks.get(sessions.get(sessionId)!.task_id!) ?? null : null);
  const join = <T extends { session_id: string | null; task_id: string | null }>(rows: T[] | undefined) =>
    (rows ?? []).map(({ session_id, task_id, ...rest }) => ({ ...rest, session: session(session_id), task: task(task_id, session_id) }));
  return {
    project: m.project,
    prs: join(items?.prs) as OutputPr[],
    pages: join(items?.pages) as OutputPage[],
    docs: join(items?.docs) as OutputDoc[],
    images: m.images,
    truncated: m.truncated || !!items?.truncated,
  };
}

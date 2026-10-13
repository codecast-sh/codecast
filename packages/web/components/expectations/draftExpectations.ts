// Draft a project's expectations from the team's recent context (the-line-model.md
// LM5): one pass of the proposer routine, run now. When the project has the
// routine installed, its trigger runs now; otherwise a fresh session follows
// the same routine (`cast expectations routine` prints it), through the one
// spawn route the web has. Either way the result is a proposal on the page,
// never an applied change. The run is remembered per project in the client
// UI state, so the page says a pass is reading until its proposal lands.
import { toast } from "sonner";
import { defaultNewSessionPath, useInboxStore } from "../../store/inboxStore";
import { resolveContextProjectPath, type ContextPathStoreSlice } from "../../lib/contextProjectPath";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import type { ProjectExpectationsRow } from "../../hooks/useSyncProjectExpectations";

/** How long a pass is shown as reading before the page lets it go. */
export const DRAFT_TTL_MS = 60 * 60_000;

export type ExpectationsDraftRun = { since: number; session_id?: string | null; via: "routine" | "session" };

/** The brief a fresh session gets: run one pass of the routine for this project. */
export function draftPrompt(project: { title: string; short_id?: string | null }, empty: boolean): string {
  const ref = project.short_id || `"${project.title}"`;
  return [
    `Read the team's recent context and propose changes to the expectations of ${project.title} (${ref}).`,
    `\`cast expectations routine --project ${ref}\` prints the pass to follow: what to read, how to quote each source, and how to submit the proposal.`,
    empty ? "The project has no expectations yet, so this pass starts the document." : "",
    "Propose; apply nothing. The proposal shows on the project's Expectations page for a person to apply.",
  ].filter(Boolean).join(" ");
}

/** Whether a pass started at `run.since` is still reading: no proposal has landed since, and it is young. */
export function draftReading(run: ExpectationsDraftRun | null | undefined, row: Pick<ProjectExpectationsRow, "proposals"> | null | undefined, now: number): boolean {
  if (!run || now - run.since > DRAFT_TTL_MS) return false;
  return !(row?.proposals ?? []).some((p) => p.created_at >= run.since);
}

export function startExpectationsDraft(projectId: string, row: ProjectExpectationsRow | null | undefined): void {
  const st = useInboxStore.getState() as any;
  const project = st.projects?.[projectId];
  const since = Date.now();
  const remember = (run: ExpectationsDraftRun) => {
    const cur = useInboxStore.getState().clientState.ui?.expectations_drafts ?? {};
    useInboxStore.getState().updateClientUI({ expectations_drafts: { ...cur, [projectId]: run } });
  };
  if (row?.routine?.trigger_id) {
    st.triggerAction(row.routine.trigger_id, "runNow");
    remember({ since, via: "routine" });
    toast.success("The expectations routine is running now", { description: "Its proposal will show here." });
    return;
  }
  const projectPath = resolveContextProjectPath(st as ContextPathStoreSlice, { project_id: projectId }) ?? defaultNewSessionPath(st) ?? undefined;
  const { stubId } = spawnSessionWithPrompt({
    prompt: draftPrompt({ title: project?.title ?? row?.project.title ?? "this project", short_id: project?.short_id }, !row?.doc),
    projectPath,
    failureLabel: "Failed to start the expectations pass",
  });
  remember({ since, session_id: stubId, via: "session" });
  // The stub is re-keyed when the server names the row; follow it so the link still opens the session.
  void st.awaitConvexId(stubId).then((id: unknown) => {
    const cur = useInboxStore.getState().clientState.ui?.expectations_drafts?.[projectId];
    if (id && cur?.since === since) remember({ ...cur, session_id: String(id) });
  }).catch(() => {});
  toast.success("A session is reading the team's recent context", { description: "Its proposal will show here for you to apply." });
}

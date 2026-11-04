// Start a fix session from an Ops page (a replay or an issue). Both pages go
// through here so the prompt quoting and the folder rule are one rule: the
// session starts in the project the signal's source is attached to
// (external-data.md: a source's project_id is the codecast project its
// signals attach under), and only a source with no project falls back to
// wherever a new session would start from the page the person is on.
import { toast } from "sonner";
import { defaultNewSessionPath, useInboxStore } from "../../store/inboxStore";
import { resolveContextProjectPath, type ContextPathStoreSlice } from "../../lib/contextProjectPath";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import { fixPrompt, type FixFacts } from "./opsModel";

type FixPathState = Parameters<typeof defaultNewSessionPath>[0] & Pick<ContextPathStoreSlice, "projects"> & { opsSources: Record<string, any> };

/** The folder a fix for a signal from `sourceId` starts in. */
export function fixSessionPath(state: FixPathState, sourceId: string | null | undefined): string | undefined {
  const source = sourceId ? state.opsSources[sourceId] : undefined;
  return resolveContextProjectPath(state as unknown as ContextPathStoreSlice, source) ?? defaultNewSessionPath(state) ?? undefined;
}

/**
 * The folders a fix may start in, the one it would pick first: the source's
 * project, then where a new session starts, then recent projects. A folder
 * known to belong to another workspace than the source's (a recent project
 * filed under another team, or personal for a team's source) is never
 * offered: a Union issue offers Union's folders. `fromSource` says whether
 * the first is the source's own.
 */
export function fixFolderChoices(state: FixPathState & { recentProjects?: Array<{ path: string; team_id?: string | null }> }, sourceId: string | null | undefined, max = 4): { paths: string[]; fromSource: boolean } {
  const source = sourceId ? state.opsSources[sourceId] : undefined;
  const own = resolveContextProjectPath(state as unknown as ContextPathStoreSlice, source);
  const recent = state.recentProjects ?? [];
  const teamOf = new Map(recent.map((p) => [p.path, p.team_id ?? null]));
  const team = typeof source?.workspace === "string" && source.workspace.startsWith("team:") ? source.workspace.slice(5) : null;
  // A folder whose workspace is unknown stays; one known to be elsewhere goes.
  const fits = (path: string) => path === own || !source?.workspace || !teamOf.has(path) || teamOf.get(path) === team;
  const all = [own, defaultNewSessionPath(state), ...recent.map((p) => p.path)].filter((p): p is string => !!p && fits(p));
  return { paths: [...new Set(all)].slice(0, max), fromSource: !!own };
}

/**
 * Start the fix. `taskId`: the problem task it works, which the session is
 * bound to on create (the task page and the issue's Fix card then show it).
 * `groupIds`: the groups it fixes, each of which records the session once it
 * has its real id (ingest.setGroupFix), so a second press opens it instead of
 * starting another. The stub id comes back for an optimistic read.
 */
export function startOpsFixSession(facts: FixFacts, sourceId: string | null | undefined, opts: { taskId?: string | null; groupIds?: string[]; projectPath?: string; /** One of several started together: the caller says so once. */ quiet?: boolean } = {}): { stubId: string } {
  const store = useInboxStore.getState();
  const prompt = fixPrompt(facts);
  const projectPath = opts.projectPath ?? fixSessionPath(store as unknown as FixPathState, sourceId);
  const { stubId } = opts.taskId ? spawnOnTask(prompt, projectPath, opts.taskId) : spawnSessionWithPrompt({ prompt, projectPath, failureLabel: "Failed to start the fix session" });
  if (opts.groupIds?.length) {
    void store
      .awaitConvexId(stubId)
      .then((id) => {
        for (const g of opts.groupIds!) useInboxStore.getState().setOpsGroupFix(g, id);
      })
      .catch(() => {});
  }
  if (!opts.quiet) toast.success("Fix session started", { description: "It is in your inbox." });
  return { stubId };
}

/** A session created bound to a task (the context composer's route): the server links the two in the create. */
function spawnOnTask(prompt: string, projectPath: string | undefined, taskId: string): { stubId: string } {
  const store = useInboxStore.getState();
  const agentType = store.currentConversation?.agentType || "claude_code";
  const { stubId } = store.beginOptimisticSession({
    agentType,
    projectPath,
    gitRoot: projectPath,
    create: (sid) => store.createSession({ agent_type: agentType, project_path: projectPath, git_root: projectPath, session_id: sid, linked_object: { type: "task", id: taskId } }),
  });
  const clientId = store.addOptimisticMessage(stubId, prompt);
  store.sendMessageWhenReady(stubId, prompt, undefined, clientId);
  return { stubId };
}

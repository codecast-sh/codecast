import { toast } from "sonner";
import { copyToClipboard } from "./utils";
import { useInboxStore, resolveComposeProjectPath, findProjectPathByName } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";

// The one error toast. Every surface that reports a caught error to the user
// (ErrorBoundary crashes, window "error", unhandledrejection) renders through
// this so the two recovery affordances — copy the trace, or hand it straight
// to an agent — never drift apart per call site.
export function showErrorToast(title: string, fullTrace: string) {
  toast.error(title, {
    duration: 15_000,
    action: {
      label: "Just fix",
      onClick: () => spawnFixSession(fullTrace),
    },
    cancel: {
      label: "Copy stack",
      onClick: () => {
        void copyToClipboard(fullTrace).then(() => toast.success("Stack trace copied"));
      },
    },
  });
}

// Fire-and-forget: start a fresh session seeded with the error and leave the
// user where they are (no navigation — the session lands in the inbox). Same
// optimistic-create + durable-send pipeline as ContextChatInput/ComposeView:
// stub row + optimistic bubble render instantly, the create and first send
// ride the dispatch outbox, and a parked dispatch redelivers on its own.
function spawnFixSession(errorText: string) {
  const store = useInboxStore.getState();
  const conv = store.currentConversation;
  // The trace is always a crash of the codecast client itself, so the fix
  // session must start in a codecast checkout — never in whatever project the
  // user happens to be viewing. The compose default still wins when it already
  // points inside codecast (e.g. a codecast worktree is more precise than the
  // main checkout), and remains the last resort when no checkout is known.
  const composePath = resolveComposeProjectPath({
    conversation: conv,
    activeProjectFilter: store.activeProjectFilter,
    activeProjectPath: store.activeProjectPath,
    recentProjects: store.recentProjects,
    machineRoster: store.machineRoster,
  });
  const insideCodecast = composePath?.split("/").includes("codecast");
  const path = insideCodecast
    ? composePath
    : (findProjectPathByName("codecast", {
        sessions: store.sessions,
        recentProjects: store.recentProjects,
        machineRoster: store.machineRoster,
      }) ?? composePath);
  const agentType = conv.agentType || "claude_code";
  const { stubId } = store.beginOptimisticSession({
    agentType,
    projectPath: path,
    gitRoot: path || undefined,
    create: (stubId) =>
      store.createSessionFromStub(stubId, { agentType, projectPath: path, gitRoot: path || undefined }),
  });
  const prompt = `please investigate and fix:\n\n${errorText}`;
  const clientId = store.addOptimisticMessage(stubId, prompt);
  toast.success("Fix session started");
  void store
    .awaitConvexId(stubId)
    .then((convexId) => {
      store.sendMessage(convexId, prompt, undefined, clientId);
    })
    .catch((error) => {
      // Parked = the write is safe in the outbox and delivers on the next
      // drain; anything else means the send is gone — surface the failure on
      // the optimistic bubble instead of silently dropping it.
      if (isParkedDispatchError(error)) return;
      store.markOptimisticAsFailed(stubId, clientId);
      console.error("Failed to start fix session", error);
    });
}

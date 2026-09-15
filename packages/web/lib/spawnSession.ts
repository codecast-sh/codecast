// Start a fresh session seeded with one prompt and leave the user where they
// are: the session lands in the inbox. The same optimistic-create plus
// durable-send pipeline ContextChatInput and ComposeView use: the stub row and
// the optimistic bubble render at once, the create and the first send ride
// the dispatch outbox, and a parked dispatch redelivers on its own. The error
// toast's "Just fix" and the org page's "Propose an org now" both go through
// here, so there is one spawn route from the web.
import { useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";

export type SpawnSessionInput = {
  prompt: string;
  agentType?: string;
  /** The cwd the session starts in; absent = wherever the daemon defaults. */
  projectPath?: string;
  /** Logged when the send is lost (not parked). */
  failureLabel?: string;
};

/** The stub id, usable at once for optimistic reads; the real id arrives
 *  through the outbox. */
export function spawnSessionWithPrompt(input: SpawnSessionInput): { stubId: string } {
  const store = useInboxStore.getState();
  const agentType = input.agentType || store.currentConversation?.agentType || "claude_code";
  const path = input.projectPath;
  const { stubId } = store.beginOptimisticSession({
    agentType,
    projectPath: path,
    gitRoot: path || undefined,
    create: (stubId) => store.createSessionFromStub(stubId, { agentType, projectPath: path, gitRoot: path || undefined }),
  });
  const clientId = store.addOptimisticMessage(stubId, input.prompt);
  void store
    .awaitConvexId(stubId)
    .then((convexId) => {
      store.sendMessage(convexId, input.prompt, undefined, clientId);
    })
    .catch((error) => {
      // Parked = the write is safe in the outbox and delivers on the next
      // drain; anything else means the send is gone — surface the failure on
      // the optimistic bubble instead of silently dropping it.
      if (isParkedDispatchError(error)) return;
      store.markOptimisticAsFailed(stubId, clientId);
      console.error(input.failureLabel ?? "Failed to start session", error);
    });
  return { stubId };
}

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CodexRecoveryQueue } from "./codexRecoveryQueue";
import { functionBlock } from "./test-helpers/sourceRegion";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  ["readyCodexAppServer", "rehydratePersistedAppServerThreads"].map((name) => functionBlock(source, name).text).join("\n"),
);

function fixture() {
  const saved = new Map<string, { threadId: string; activeTurnId?: string }>();
  for (let i = 0; i < 50; i++) saved.set(`conversation-${i}`, { threadId: `thread-${i}` });
  const live = new Map<string, string>();
  const resumed: string[] = [];
  const queried: string[] = [];
  const errors: unknown[] = [];
  const registered: Array<[string, string]> = [];
  let functions: { ready: (id: string) => Promise<unknown>; recover: (requested?: ReadonlySet<string>) => Promise<void> };
  const queue = new CodexRecoveryQueue((requested) => functions.recover(requested), () => {}, (error) => errors.push(error));
  const deps = {
    codexAppServerInstance: {
      running: true,
      restartIfAuthChanged: async () => {},
      threadResume: async ({ threadId }: { threadId: string }) => {
        resumed.push(threadId);
        return { thread: { id: threadId }, sandbox: { type: "readOnly" } };
      },
    },
    appServerShuttingDown: false,
    persistedAppServerThreads: saved,
    appServerConversations: live,
    appServerThreads: new Map(),
    appServerRecoveryRetryAt: new Map(),
    appServerRecoveringThreads: new Set(),
    pendingAgentSwitches: new Set(),
    codexRecoveryQueue: queue,
    syncServiceRef: {
      getConversationLifecycle: async (id: string) => {
        queried.push(id);
        return { hideStateKnown: true, agentType: "codex", status: "active", hasPendingMessages: false };
      },
      getConversationOwnerInfo: async () => ({ ownerDeviceId: "local" }),
      registerManagedSession: async (threadId: string, _pid: number, _tmux: undefined, conversationId: string) => {
        registered.push([threadId, conversationId]);
      },
    },
    logConvexFailure: (error: unknown) => errors.push(error),
    conversationUsesCodexAppServer: (type: string) => type === "codex",
    activeConfig: {},
    resolveCodexPermissionDefaults: () => ({ approvalPolicy: "never" }),
    codexResumeParams: (record: unknown) => record,
    registerAppServerConversation: (id: string, threadId: string) => live.set(id, threadId),
    ensureManagedSessionHeartbeat: () => {},
    recoverCodexTurn: async () => "none",
    findActiveTurnForThread: () => undefined,
    deviceId: () => "local",
    persistAppServerThreadRegistrations: () => {},
    log: () => {},
    logError: (_message: string, error: unknown) => errors.push(error),
  };
  functions = new Function(...Object.keys(deps), code + "\nreturn { ready: readyCodexAppServer, recover: rehydratePersistedAppServerThreads };")(...Object.values(deps));
  return { ...functions, saved, live, resumed, queried, errors, queue, registered };
}

test("daemon boot leaves 50 idle saved Codex threads cold without querying or spawning them", async () => {
  const f = fixture();
  f.queue.request(true);
  await f.queue.wait();
  expect(f.resumed).toEqual([]);
  expect(f.queried).toEqual([]);
  expect(f.saved.size).toBe(50);
  expect(f.errors).toEqual([]);
});

test("delivery restores its saved thread on demand and a repeated delivery reuses it", async () => {
  const f = fixture();
  await f.ready("conversation-12");
  await f.ready("conversation-12");
  expect(f.resumed).toEqual(["thread-12"]);
  expect(f.live.get("conversation-12")).toBe("thread-12");
  // The server row naming the thread is re-registered: status writes and lines
  // the agent posts resolve to their conversation only through it.
  expect(f.registered).toEqual([["thread-12", "conversation-12"]]);
  expect(f.saved.size).toBe(50);
  expect(f.errors).toEqual([]);
});

test("daemon boot still restores an interrupted active turn without a new delivery", async () => {
  const f = fixture();
  f.saved.get("conversation-8")!.activeTurnId = "interrupted";
  f.queue.request(true);
  await f.queue.wait();
  expect(f.resumed).toEqual(["thread-8"]);
  expect(f.errors).toEqual([]);
});

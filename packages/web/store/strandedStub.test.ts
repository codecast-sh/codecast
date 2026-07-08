import { describe, expect, it, beforeEach } from "bun:test";
import { useInboxStore, isConvexId } from "./inboxStore";

// Regression coverage for ct-37441 — a "New Session" whose createSession was
// given up (offline / outage / createConversation rate-limit) strands a stub
// the user typed into: it renders local-first but has no server conversation,
// so awaitConvexId dead-ends and the message is stuck forever. The heal must
// re-create the conversation (idempotent server-side) and re-send the queued
// message, rekeying the stub to the real id along the way.

const REAL_ID = "jx70000000000000000000000000heal"; // 32-char => isConvexId

type DispatchCall = { action: string; args: any[] };

function installFakeDispatch(): { calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  const store = useInboxStore.getState() as any;
  store._setDispatch((action: string, args: any[]) => {
    calls.push({ action, args });
    // The real server returns the conversation id for createSession; mirror that
    // so ensureSessionCreated can rekey explicitly.
    if (action === "createSession") return Promise.resolve(REAL_ID);
    return Promise.resolve(undefined);
  });
  return { calls };
}

function seedStrandedStub(stubId: string) {
  useInboxStore.setState({
    sessions: {
      [stubId]: {
        _id: stubId,
        session_id: stubId,
        title: "New session",
        agent_type: "claude_code",
        project_path: "/Users/me/proj",
        git_root: "/Users/me/proj",
        message_count: 0,
        is_idle: true,
        has_pending: false,
        started_at: Date.now() - 5 * 60 * 1000,
        updated_at: Date.now() - 5 * 60 * 1000,
      } as any,
    },
    conversations: { [stubId]: { _id: stubId, session_id: stubId, project_path: "/Users/me/proj", agent_type: "claude_code" } as any },
    pendingMessages: { [stubId]: [{ _id: "opt1", _clientId: "client-1", role: "user", content: "deliver me", timestamp: Date.now(), _isFailed: true } as any] },
    pendingSessionCreates: {},
  } as any);
}

describe("healStrandedStub", () => {
  beforeEach(() => {
    useInboxStore.setState({ sessions: {}, conversations: {}, pendingMessages: {}, pendingSessionCreates: {} } as any);
  });

  it("re-creates the conversation and re-sends the stuck message", async () => {
    const stubId = "strandedstubaaaaaaaaaa"; // 22-char, non-convex
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);

    const realId = await useInboxStore.getState().healStrandedStub(stubId);
    expect(realId).toBe(REAL_ID);

    // 1) createSession was dispatched with the stub's session_id + context.
    const create = calls.find((c) => c.action === "createSession");
    expect(create).toBeTruthy();
    expect(create!.args[0].session_id).toBe(stubId);
    expect(create!.args[0].project_path).toBe("/Users/me/proj");
    expect(create!.args[0].agent_type).toBe("claude_code");

    // 2) the stub was rekeyed to the real id (pending message carried across).
    const s = useInboxStore.getState();
    expect(s.sessions[stubId]).toBeUndefined();
    expect(isConvexId(s.sessions[REAL_ID]?._id ?? "")).toBe(true);

    // 3) the queued message was re-sent against the REAL id with the same
    //    client_id (server dedups → safe), not the dead stub id.
    const send = calls.find((c) => c.action === "sendMessage");
    expect(send).toBeTruthy();
    expect(send!.args[0]).toBe(REAL_ID);
    expect(send!.args[1]).toBe("deliver me");
    expect(send!.args[3]).toBe("client-1");
  });

  it("ensureSessionCreated returns an in-flight create instead of issuing a second", async () => {
    const stubId = "inflightstubbbbbbbbbbb";
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);
    let resolveInFlight: (id: string) => void = () => {};
    const inflight = new Promise<string>((r) => { resolveInFlight = r; });
    useInboxStore.getState().trackSessionCreate(stubId, inflight);

    const p = useInboxStore.getState().ensureSessionCreated(stubId);
    resolveInFlight(REAL_ID);
    expect(await p).toBe(REAL_ID);
    // No new createSession dispatched — the in-flight promise was reused.
    expect(calls.filter((c) => c.action === "createSession")).toHaveLength(0);
  });

  it("awaitConvexId self-heals a stranded stub by re-creating it", async () => {
    const stubId = "awaitstubcccccccccccc";
    installFakeDispatch();
    seedStrandedStub(stubId);
    const resolved = await useInboxStore.getState().awaitConvexId(stubId);
    expect(resolved).toBe(REAL_ID);
  });

  it("refuses to re-create a PATHLESS stub (would spawn the daemon in $HOME)", async () => {
    const stubId = "pathlessstubdddddddddd";
    const { calls } = installFakeDispatch();
    // A born-pathless stub (project-less doc → new agent) with a stuck message.
    useInboxStore.setState({
      sessions: { [stubId]: { _id: stubId, session_id: stubId, agent_type: "claude_code", message_count: 0, started_at: Date.now(), updated_at: Date.now() } as any },
      conversations: { [stubId]: { _id: stubId, session_id: stubId, agent_type: "claude_code" } as any },
      pendingMessages: { [stubId]: [{ _id: "o", _clientId: "c", role: "user", content: "hi", timestamp: Date.now() } as any] },
      pendingSessionCreates: {},
    } as any);

    // ensureSessionCreated rejects rather than spawning in $HOME...
    await expect(useInboxStore.getState().ensureSessionCreated(stubId)).rejects.toThrow(/pick a project/i);
    // ...and no createSession was dispatched (no silent $HOME spawn).
    expect(calls.filter((c) => c.action === "createSession")).toHaveLength(0);
    // The user-triggered send surfaces the same actionable error.
    await expect(useInboxStore.getState().awaitConvexId(stubId)).rejects.toThrow(/pick a project/i);
  });
});

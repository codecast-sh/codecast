import { describe, expect, it, beforeEach } from "bun:test";
import { useInboxStore, isConvexId } from "./inboxStore";
import { DispatchNotWiredError } from "./mutativeMiddleware";

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
    // so ensureSessionCreated can rekey explicitly. forkFromMessage returns
    // { conversation_id } (see convex forkFromMessage) — mirror that too.
    if (action === "createSession") return Promise.resolve(REAL_ID);
    if (action === "convCommand" && args[1] === "forkFromMessage") return Promise.resolve({ conversation_id: REAL_ID });
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
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      pendingMessages: {},
      pendingSessionCreates: {},
      bucketAssignments: {},
      activeBucketFilter: null,
    } as any);
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

  it("redrives an unsent optimistic first message when live sync rekeys its parked create", async () => {
    const stubId = "parkedfirstmessageaaaa";
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);
    useInboxStore.setState((s: any) => ({
      pendingMessages: {
        ...s.pendingMessages,
        [stubId]: s.pendingMessages[stubId].map((m: any) => {
          const { _isFailed, ...pending } = m;
          return { ...pending, _id: "opt-rekey", _clientId: "client-rekey" };
        }),
      },
    }));

    useInboxStore.getState().syncTable("sessions", [{
      _id: REAL_ID,
      session_id: stubId,
      title: "New session",
      agent_type: "claude_code",
      project_path: "/Users/me/proj",
      git_root: "/Users/me/proj",
      message_count: 0,
      is_idle: true,
      has_pending: false,
      updated_at: Date.now(),
    } as any]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const sends = calls.filter((c) => c.action === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.args).toEqual([REAL_ID, "deliver me", null, "client-rekey"]);
  });

  // ct-46401 — the rekey fallback fired while the first message's image was
  // still uploading: it sent the row without a storage id, the server kept that
  // row for the client id, and the upload task's later send (with the id) was
  // deduped away. The message reached the agent as "[Image 1] …" with no image.
  it("does not redrive a first message whose image is still uploading; the settled upload sends it with the id", async () => {
    const stubId = "uploadingfirstmessageaa";
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);
    useInboxStore.setState((s: any) => ({
      pendingMessages: {
        ...s.pendingMessages,
        [stubId]: [{
          ...s.pendingMessages[stubId][0],
          _id: "opt-upload",
          _clientId: "client-upload",
          _isFailed: undefined,
          content: "[Image 1] look at this",
          images: [{ media_type: "image/png", preview_url: "blob:preview", uploading: true }],
        }],
      },
    }));

    useInboxStore.getState().syncTable("sessions", [{
      _id: REAL_ID,
      session_id: stubId,
      title: "New session",
      agent_type: "claude_code",
      project_path: "/Users/me/proj",
      git_root: "/Users/me/proj",
      message_count: 0,
      is_idle: true,
      has_pending: false,
      updated_at: Date.now(),
    } as any]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.filter((c) => c.action === "sendMessage")).toHaveLength(0);

    // The upload task captured the STUB key at send time; the row has since
    // moved to the real id. It must still land on the row.
    const resolved = [{ media_type: "image/png", storage_id: "kg2storage" }];
    useInboxStore.getState().resolvePendingUploads(stubId, "client-upload", resolved);
    const row = useInboxStore.getState().pendingMessages[REAL_ID]?.[0] as any;
    expect(row?.images).toEqual(resolved);

    // A later redrive (boot, Retry) now replays the row with its image id.
    useInboxStore.getState().redrivePendingMessages();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sends = calls.filter((c) => c.action === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.args).toEqual([REAL_ID, "[Image 1] look at this", ["kg2storage"], "client-upload"]);
  });

  it("coalesces the normal await-and-send path with the rekey fallback", async () => {
    const stubId = "healthyfirstmessageaaaa";
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);
    useInboxStore.setState((s: any) => ({
      pendingMessages: {
        ...s.pendingMessages,
        [stubId]: [{
          ...s.pendingMessages[stubId][0],
          _id: "opt-normal",
          _clientId: "client-normal",
          _isFailed: undefined,
        }],
      },
    }));

    useInboxStore.getState().syncTable("sessions", [{
      _id: REAL_ID,
      session_id: stubId,
      title: "New session",
      agent_type: "claude_code",
      project_path: "/Users/me/proj",
      git_root: "/Users/me/proj",
      message_count: 0,
      is_idle: true,
      has_pending: false,
      updated_at: Date.now(),
    } as any]);

    const resolved = await useInboxStore.getState().awaitConvexId(stubId);
    useInboxStore.getState().sendMessage(resolved, "deliver me", undefined, "client-normal");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls.filter((c) => c.action === "sendMessage")).toHaveLength(1);
  });

  it("redrives a persisted real-id pending message after hydration", () => {
    const { calls } = installFakeDispatch();
    useInboxStore.setState({
      sessions: {
        [REAL_ID]: {
          _id: REAL_ID,
          session_id: "rekeyed-before-crash",
          agent_type: "claude_code",
          project_path: "/repo",
          message_count: 0,
          is_idle: true,
          has_pending: false,
          updated_at: Date.now(),
        } as any,
      },
      conversations: { [REAL_ID]: { _id: REAL_ID } as any },
      pendingMessages: {
        [REAL_ID]: [{
          _id: "opt-hydrated",
          _clientId: "client-hydrated",
          _isOptimistic: true,
          role: "user",
          content: "survived the crash",
          timestamp: Date.now(),
        } as any],
      },
      pendingSessionCreates: {},
    } as any);

    useInboxStore.getState().redrivePendingMessages();

    expect(calls.find((c) => c.action === "sendMessage")?.args)
      .toEqual([REAL_ID, "survived the crash", null, "client-hydrated"]);
  });

  // Regression: the server dedupes a send's client id by argument fingerprint.
  // The original dispatch sends mention-EXPANDED content while the pending row
  // keeps the raw text the user typed — so a boot redrive that rebuilt the send
  // from `content` was refused as COMMAND_ID_REUSED and the delivered message
  // toasted "Send message didn't go through". The dispatched bytes are stamped
  // on the row (_dispatchContent) and every redrive must replay them verbatim.
  it("redrives the stamped dispatch bytes, not the row's raw content", () => {
    const { calls } = installFakeDispatch();
    const raw = "look at @[My Doc doc:abc123]";
    const expanded = raw + "\n\n<doc-context>…expanded…</doc-context>";
    useInboxStore.setState({
      sessions: { [REAL_ID]: { _id: REAL_ID, updated_at: Date.now() } as any },
      conversations: { [REAL_ID]: { _id: REAL_ID } as any },
      pendingMessages: {
        [REAL_ID]: [{
          _id: "opt-mention",
          _clientId: "client-mention",
          _isOptimistic: true,
          role: "user",
          content: raw,
          timestamp: Date.now(),
        } as any],
      },
      pendingSessionCreates: {},
    } as any);

    useInboxStore.getState().stampPendingDispatchContent(REAL_ID, "client-mention", expanded);
    expect(useInboxStore.getState().pendingMessages[REAL_ID][0]._dispatchContent).toBe(expanded);

    useInboxStore.getState().redrivePendingMessages();

    expect(calls.find((c) => c.action === "sendMessage")?.args)
      .toEqual([REAL_ID, expanded, null, "client-mention"]);
  });

  it("reconfigures a rekeyed parked create with the latest stub launch preferences", async () => {
    const stubId = "parkedlaunchprefsaaaaaa";
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);
    useInboxStore.setState((s: any) => ({
      sessions: {
        ...s.sessions,
        [stubId]: {
          ...s.sessions[stubId],
          agent_type: "codex",
          project_path: "/Users/me/new-proj",
          git_root: "/Users/me/new-proj",
          model: "gpt-5.4",
          effort: "high",
          stable_mode: "solo",
          stable_exclude: ["jx7000000000000000000000000skip"],
          _launchSnapshot: {
            agent_type: "claude_code",
            project_path: "/Users/me/proj",
            git_root: "/Users/me/proj",
          },
        },
      },
    }));

    useInboxStore.getState().syncTable("sessions", [{
      _id: REAL_ID,
      session_id: stubId,
      title: "New session",
      agent_type: "claude_code",
      project_path: "/Users/me/proj",
      git_root: "/Users/me/proj",
      message_count: 0,
      is_idle: true,
      has_pending: false,
      updated_at: Date.now(),
    } as any]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const reconfigure = calls.find(
      (c) => c.action === "convCommand" && c.args[1] === "reconfigureSession",
    );
    expect(reconfigure?.args[0]).toBe(REAL_ID);
    expect(reconfigure?.args[2]).toEqual({
      agent_type: "codex",
      project_path: "/Users/me/new-proj",
      git_root: "/Users/me/new-proj",
      model: "gpt-5.4",
      effort: "high",
      stable_mode: "solo",
      stable_exclude: ["jx7000000000000000000000000skip"],
    });
  });

  it("reconfigures a parked {solo, excluded} launch back to device defaults", async () => {
    const stubId = "parkedstableclearaaaaa";
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);
    useInboxStore.setState((s: any) => ({
      sessions: {
        ...s.sessions,
        [stubId]: {
          ...s.sessions[stubId],
          _launchSnapshot: {
            agent_type: "claude_code",
            project_path: "/Users/me/proj",
            git_root: "/Users/me/proj",
            stable_mode: "solo",
            stable_exclude: ["jx7000000000000000000000000skip"],
          },
          stable_mode: undefined,
          stable_exclude: undefined,
        },
      },
    }));

    useInboxStore.getState().syncTable("sessions", [{
      _id: REAL_ID,
      session_id: stubId,
      title: "New session",
      agent_type: "claude_code",
      project_path: "/Users/me/proj",
      git_root: "/Users/me/proj",
      message_count: 0,
      is_idle: true,
      has_pending: false,
      updated_at: Date.now(),
    } as any]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const reconfigure = calls.find(
      (call) =>
        call.action === "convCommand" &&
        call.args[1] === "reconfigureSession",
    );
    expect(reconfigure?.args[2]).toMatchObject({
      agent_type: "claude_code",
      model: "default",
      effort: "default",
    });
    expect(reconfigure?.args[2]).not.toHaveProperty("stable_mode");
    expect(reconfigure?.args[2]).not.toHaveProperty("stable_exclude");
  });

  it("files a durably parked create into the bucket captured on its stub", async () => {
    const bucketId = "bucket00000000000000000000000000";
    const { calls } = installFakeDispatch();
    useInboxStore.setState({ activeBucketFilter: bucketId });

    const started = useInboxStore.getState().beginOptimisticSession({
      agentType: "claude_code",
      projectPath: "/Users/me/proj",
      gitRoot: "/Users/me/proj",
      create: async () => {
        throw new DispatchNotWiredError("createSession", true);
      },
    });
    await expect(started.ready).rejects.toMatchObject({ parked: true });
    expect(
      useInboxStore.getState().sessions[started.stubId]?._postCreateBucketId,
    ).toBe(bucketId);

    // Simulate the next launch: the in-memory promise continuation is gone,
    // but by_session_id sync still rekeys the persisted stub.
    useInboxStore.getState().syncTable("sessions", [{
      _id: REAL_ID,
      session_id: started.stubId,
      title: "New session",
      agent_type: "claude_code",
      project_path: "/Users/me/proj",
      git_root: "/Users/me/proj",
      message_count: 0,
      is_idle: true,
      has_pending: false,
      updated_at: Date.now(),
    } as any]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const assignment = calls.find(
      (call) => call.action === "assignSessionToBucket",
    );
    expect(assignment?.args).toEqual([REAL_ID, bucketId]);
    expect(
      useInboxStore.getState().sessions[REAL_ID]?._postCreateBucketId,
    ).toBe(bucketId);
  });

  it("redrives a persisted real-id bucket intent after hydration", () => {
    const bucketId = "bucket00000000000000000000000000";
    const { calls } = installFakeDispatch();
    useInboxStore.setState({
      sessions: {
        [REAL_ID]: {
          _id: REAL_ID,
          session_id: "created-before-reload",
          agent_type: "claude_code",
          message_count: 0,
          is_idle: true,
          has_pending: false,
          updated_at: Date.now(),
          _postCreateBucketId: bucketId,
        } as any,
      },
      conversations: { [REAL_ID]: { _id: REAL_ID } as any },
      bucketAssignments: {},
    } as any);

    useInboxStore.getState().resumePostCreateSessionIntents();

    expect(
      calls.find((call) => call.action === "assignSessionToBucket")?.args,
    ).toEqual([REAL_ID, bucketId]);
  });

  it("clears the persisted bucket intent only after an authoritative assignment echo", () => {
    const bucketId = "bucket00000000000000000000000000";
    useInboxStore.setState({
      sessions: {
        [REAL_ID]: {
          _id: REAL_ID,
          session_id: "created-before-reload",
          _postCreateBucketId: bucketId,
          updated_at: Date.now(),
        } as any,
      },
      conversations: {
        [REAL_ID]: {
          _id: REAL_ID,
          _postCreateBucketId: bucketId,
        } as any,
      },
      bucketAssignments: {
        [`bucketassign-${REAL_ID}`]: {
          _id: `bucketassign-${REAL_ID}`,
          conversation_id: REAL_ID,
          bucket_id: bucketId,
          updated_at: Date.now(),
        },
      } as any,
    } as any);

    // A local optimistic row is not proof that its outbox write committed.
    useInboxStore.getState().resumePostCreateSessionIntents();
    expect(
      useInboxStore.getState().sessions[REAL_ID]?._postCreateBucketId,
    ).toBe(bucketId);

    useInboxStore.getState().syncTable("bucketAssignments", [{
      _id: "assign00000000000000000000000000",
      conversation_id: REAL_ID,
      bucket_id: bucketId,
      updated_at: Date.now() + 1,
    } as any]);

    expect(
      useInboxStore.getState().sessions[REAL_ID]?._postCreateBucketId,
    ).toBeUndefined();
    expect(
      (useInboxStore.getState().conversations[REAL_ID] as any)
        ?._postCreateBucketId,
    ).toBeUndefined();
  });

  it("treats any authoritative filing as newer than a persisted create-time intent", () => {
    const capturedBucket = "bucket00000000000000000000000000";
    const newerBucket = "bucket11111111111111111111111111";
    const { calls } = installFakeDispatch();
    useInboxStore.setState({
      sessions: {
        [REAL_ID]: {
          _id: REAL_ID,
          session_id: "created-before-reload",
          _postCreateBucketId: capturedBucket,
          updated_at: Date.now(),
        } as any,
      },
      conversations: {
        [REAL_ID]: {
          _id: REAL_ID,
          _postCreateBucketId: capturedBucket,
        } as any,
      },
      bucketAssignments: {
        assign11111111111111111111111111: {
          _id: "assign11111111111111111111111111",
          conversation_id: REAL_ID,
          bucket_id: newerBucket,
          updated_at: Date.now(),
        },
      } as any,
    } as any);

    useInboxStore.getState().resumePostCreateSessionIntents();

    expect(
      calls.filter((call) => call.action === "assignSessionToBucket"),
    ).toHaveLength(0);
    expect(
      useInboxStore.getState().sessions[REAL_ID]?._postCreateBucketId,
    ).toBeUndefined();
    expect(
      (useInboxStore.getState().conversations[REAL_ID] as any)
        ?._postCreateBucketId,
    ).toBeUndefined();
  });

  it("a manual move supersedes the create-time bucket intent across a reboot", () => {
    const capturedBucket = "bucket00000000000000000000000000";
    const newerBucket = "bucket11111111111111111111111111";
    const { calls } = installFakeDispatch();
    useInboxStore.setState({
      sessions: {
        [REAL_ID]: {
          _id: REAL_ID,
          session_id: "created-before-reload",
          _postCreateBucketId: capturedBucket,
          updated_at: Date.now(),
        } as any,
      },
      conversations: {
        [REAL_ID]: {
          _id: REAL_ID,
          _postCreateBucketId: capturedBucket,
        } as any,
      },
      bucketAssignments: {},
    } as any);

    useInboxStore.getState().assignSessionToBucket(REAL_ID, newerBucket);
    expect(
      useInboxStore.getState().sessions[REAL_ID]?._postCreateBucketId,
    ).toBeUndefined();

    // Simulate the boot redrive after the manual action's local state persisted:
    // only the newer filing may dispatch; the captured bucket must not reappear.
    useInboxStore.getState().resumePostCreateSessionIntents();
    const assignments = calls.filter(
      (call) => call.action === "assignSessionToBucket",
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0].args).toEqual([REAL_ID, newerBucket]);
  });

  it("does not move a reused blank that is already filed by hand", async () => {
    const focusedBucket = "bucket00000000000000000000000000";
    const existingBucket = "bucket11111111111111111111111111";
    const { calls } = installFakeDispatch();
    useInboxStore.setState({
      activeBucketFilter: focusedBucket,
      sessions: {
        [REAL_ID]: {
          _id: REAL_ID,
          session_id: REAL_ID,
          agent_type: "claude_code",
          project_path: "/Users/me/proj",
          message_count: 0,
          is_idle: true,
          has_pending: false,
          started_at: Date.now() - 1_000,
          updated_at: Date.now(),
        } as any,
      },
      conversations: { [REAL_ID]: { _id: REAL_ID } as any },
      bucketAssignments: {
        assign11111111111111111111111111: {
          _id: "assign11111111111111111111111111",
          conversation_id: REAL_ID,
          bucket_id: existingBucket,
          updated_at: Date.now(),
        },
      } as any,
    } as any);

    const reused = useInboxStore.getState().beginOptimisticSession({
      agentType: "claude_code",
      projectPath: "/Users/me/proj",
      reuse: true,
      create: async () => {
        throw new Error("must not create");
      },
    });
    await reused.ready;
    await Promise.resolve();

    expect(reused.stubId).toBe(REAL_ID);
    expect(
      useInboxStore.getState().sessions[REAL_ID]?._postCreateBucketId,
    ).toBeUndefined();
    expect(
      calls.filter((call) => call.action === "assignSessionToBucket"),
    ).toHaveLength(0);
  });

  it("durably flushes protected stub fields after an alt-key rekey", async () => {
    const stubId = "parkedfieldpatchaaaaaaa";
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);
    useInboxStore.getState().updateSessionProject(stubId, "/Users/me/latest");

    useInboxStore.getState().syncTable("sessions", [{
      _id: REAL_ID,
      session_id: stubId,
      title: "New session",
      agent_type: "claude_code",
      project_path: "/Users/me/proj",
      git_root: "/Users/me/proj",
      message_count: 0,
      is_idle: true,
      has_pending: false,
      updated_at: Date.now(),
    } as any]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const flush = calls.find((c) => c.action === "flushResolvedSessionFields");
    expect(flush?.args[0]).toBe(REAL_ID);
    expect(flush?.args[1]).toMatchObject({
      project_path: "/Users/me/latest",
      git_root: "/Users/me/latest",
    });
  });

  // Regression coverage for ct-40174 — the jx79314 incident: a fork whose
  // forkFromMessage dispatch was lost left a stranded FORK stub, and the heal
  // revived it as a plain createSession — a blank session that inherited the
  // parent's project_path but none of its history or fork lineage. The user's
  // seed message then landed in a context-less agent. The heal must re-issue
  // forkFromMessage (idempotent on session_id), never a plain create.
  it("re-issues forkFromMessage for a stranded FORK stub, not a plain create", async () => {
    const stubId = "68f6f6b9-b22b-47ad-82e5-23bd5d66a81e"; // fork stubs are session UUIDs
    const parentId = "jx7000000000000000000000000paren";
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);
    useInboxStore.setState((s: any) => ({
      sessions: { [stubId]: { ...s.sessions[stubId], forked_from: parentId, parent_message_uuid: "uuid-fork-point" } },
      conversations: { [stubId]: { ...s.conversations[stubId], forked_from: parentId, parent_message_uuid: "uuid-fork-point" } },
    } as any));

    const realId = await useInboxStore.getState().healStrandedStub(stubId);
    expect(realId).toBe(REAL_ID);

    // The heal forked — it did NOT mint an amnesiac plain session.
    expect(calls.filter((c) => c.action === "createSession")).toHaveLength(0);
    const fork = calls.find((c) => c.action === "convCommand" && c.args[1] === "forkFromMessage");
    expect(fork).toBeTruthy();
    expect(fork!.args[0]).toBe(parentId);
    expect(fork!.args[2]).toEqual({ message_uuid: "uuid-fork-point", session_id: stubId });

    // Stub rekeyed to the real fork row; the stuck seed message re-sent to it.
    expect(useInboxStore.getState().sessions[stubId]).toBeUndefined();
    const send = calls.find((c) => c.action === "sendMessage");
    expect(send).toBeTruthy();
    expect(send!.args[0]).toBe(REAL_ID);
  });

  it("reissues a stranded agent-switch fork with its target agent", async () => {
    const stubId = "0a0a0a0a-bbbb-4ccc-8ddd-eeeeffff1111";
    const parentId = "jx7000000000000000000000000paren";
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);
    useInboxStore.setState((s: any) => ({
      sessions: {
        [stubId]: {
          ...s.sessions[stubId],
          forked_from: parentId,
          parent_conversation_id: parentId,
          parent_message_uuid: "agent-switch",
          _forkTargetAgentType: "codex",
        },
      },
      conversations: {
        [stubId]: {
          ...s.conversations[stubId],
          forked_from: parentId,
          parent_conversation_id: parentId,
          parent_message_uuid: "agent-switch",
          _forkTargetAgentType: "codex",
        },
      },
    } as any));

    expect(await useInboxStore.getState().healStrandedStub(stubId)).toBe(REAL_ID);
    const fork = calls.find((c) => c.action === "convCommand");
    expect(fork?.args[2]).toEqual({
      target_agent_type: "codex",
      session_id: stubId,
    });
    expect(calls.filter((c) => c.action === "createSession")).toHaveLength(0);
  });

  it("rejects a fork stub whose parent is unknown instead of degrading to a plain create", async () => {
    const stubId = "0f0f0f0f-aaaa-4bbb-8ccc-ddddeeee0000";
    const { calls } = installFakeDispatch();
    seedStrandedStub(stubId);
    useInboxStore.setState((s: any) => ({
      sessions: { [stubId]: { ...s.sessions[stubId], forked_from: "someotherstubid", parent_message_uuid: "u1" } },
      conversations: { [stubId]: { ...s.conversations[stubId], forked_from: "someotherstubid", parent_message_uuid: "u1" } },
    } as any));

    await expect(useInboxStore.getState().ensureSessionCreated(stubId)).rejects.toThrow(/fork parent unknown/i);
    expect(calls.filter((c) => c.action === "createSession")).toHaveLength(0);
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

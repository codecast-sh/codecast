import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { useInboxStore } from "./inboxStore";
import { StaleDispatchBindingError } from "./mutativeMiddleware";

// ct-91688 — a stub heal whose re-create is fenced by a dispatch rewire
// ("Dispatch binding changed while work was in flight") is not a failure: the
// create's outbox row redelivers and the next sweep heals the stub. Logging it
// through console.error opened replay issue eg-3008 / eg-3064 on /inbox.

const REAL_ID = "jx70000000000000000000000000heal";
const STUB_ID = "stalebindingstubaaaaaa";

function seedStrandedStub() {
  useInboxStore.setState({
    sessions: {
      [STUB_ID]: {
        _id: STUB_ID,
        session_id: STUB_ID,
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
    conversations: { [STUB_ID]: { _id: STUB_ID, session_id: STUB_ID, project_path: "/Users/me/proj", agent_type: "claude_code" } as any },
    pendingMessages: { [STUB_ID]: [{ _id: "opt1", _clientId: "client-1", role: "user", content: "deliver me", timestamp: Date.now(), _isFailed: true } as any] },
    pendingSessionCreates: {},
    bucketAssignments: {},
    activeBucketFilter: null,
  } as any);
}

describe("healStrandedStub on a dispatch binding rewire", () => {
  const errors: unknown[][] = [];
  const realError = console.error;

  beforeEach(() => {
    errors.length = 0;
    console.error = (...args: unknown[]) => { errors.push(args); };
  });
  let realCreate: any;
  beforeEach(() => {
    realCreate = useInboxStore.getState().createSessionFromStub;
  });
  afterEach(() => {
    console.error = realError;
    useInboxStore.setState({ createSessionFromStub: realCreate } as any);
  });

  it("returns null without console.error, then heals and sends once on the next sweep", async () => {
    const calls: { action: string; args: any[] }[] = [];
    (useInboxStore.getState() as any)._setDispatch((action: string, args: any[]) => {
      calls.push({ action, args });
      return Promise.resolve(action === "createSession" ? REAL_ID : undefined);
    });
    seedStrandedStub();
    // The create is fenced by a binding rewire once (a cold start rewires the
    // dispatch binding under in-flight writes), then lands on the next sweep.
    const realCreate = useInboxStore.getState().createSessionFromStub;
    let fenced = true;
    useInboxStore.setState({
      createSessionFromStub: (id: string) => {
        if (fenced) {
          fenced = false;
          return Promise.reject(new StaleDispatchBindingError());
        }
        return realCreate(id);
      },
    } as any);

    const first = await useInboxStore.getState().healStrandedStub(STUB_ID);
    expect(first).toBeNull();

    const loggedBinding = errors.filter((args) =>
      args.some((a) => /Dispatch binding changed while work was in flight/.test(a instanceof Error ? a.message : String(a))),
    );
    expect(loggedBinding).toHaveLength(0);

    // The rejected attempt must not stay cached as the in-flight create.
    expect(useInboxStore.getState().pendingSessionCreates[STUB_ID]).toBeUndefined();

    const second = await useInboxStore.getState().healStrandedStub(STUB_ID);
    expect(second).toBe(REAL_ID);
    const sends = calls.filter((c) => c.action === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0].args[0]).toBe(REAL_ID);
    expect(sends[0].args[3]).toBe("client-1");
  });

  it("still logs a genuine re-create failure", async () => {
    seedStrandedStub();
    useInboxStore.setState({
      createSessionFromStub: () => Promise.reject(new Error("server exploded")),
    } as any);
    expect(await useInboxStore.getState().healStrandedStub(STUB_ID)).toBeNull();
    expect(errors.some((args) => String(args[0]).includes("[stub-heal] re-create failed"))).toBe(true);
  });
});

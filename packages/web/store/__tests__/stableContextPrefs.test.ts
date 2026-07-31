import { afterEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// Per-session stable-context prefs: the new-session picker stamps them on the
// local stub row (setStableContextPrefs) and createSessionFromStub folds them
// into the createSession dispatch — same lifecycle as the model/effort stamps.
// A pref that doesn't survive this hop silently reverts the user's choice at
// launch, so the fold is pinned here.

const STUB = "stubstablectx1";

afterEach(() => {
  const s = useInboxStore.getState();
  const sessions = { ...s.sessions };
  const conversations = { ...s.conversations };
  delete (sessions as any)[STUB];
  delete (conversations as any)[STUB];
  useInboxStore.setState({ sessions, conversations } as any);
});

function seedStub() {
  useInboxStore.setState({
    sessions: {
      ...useInboxStore.getState().sessions,
      [STUB]: {
        _id: STUB,
        session_id: STUB,
        updated_at: Date.now(),
        agent_type: "claude_code",
        project_path: "/tmp/proj",
        message_count: 0,
        is_idle: true,
        has_pending: false,
      } as any,
    },
  } as any);
}

describe("stable-context launch prefs", () => {
  it("setStableContextPrefs stamps and clears mode/exclude on the stub row", () => {
    seedStub();
    const store = useInboxStore.getState();

    store.setStableContextPrefs(STUB, { mode: "solo", exclude: ["jx7aaaa"] });
    let row = useInboxStore.getState().sessions[STUB] as any;
    expect(row.stable_mode).toBe("solo");
    expect(row.stable_exclude).toEqual(["jx7aaaa"]);

    store.setStableContextPrefs(STUB, { mode: null, exclude: [] });
    row = useInboxStore.getState().sessions[STUB] as any;
    expect(row.stable_mode).toBeUndefined();
    expect(row.stable_exclude).toBeUndefined();
  });

  it("createSessionFromStub folds stamped prefs into the createSession opts", async () => {
    seedStub();
    useInboxStore.getState().setStableContextPrefs(STUB, { mode: "off", exclude: ["jx7bbbb", "jx7cccc"] });

    const calls: any[] = [];
    const original = useInboxStore.getState().createSession;
    useInboxStore.setState({
      createSession: (async (opts: any) => {
        calls.push(opts);
        return STUB;
      }) as any,
    } as any);
    try {
      await useInboxStore.getState().createSessionFromStub(STUB);
    } finally {
      useInboxStore.setState({ createSession: original } as any);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].stable_mode).toBe("off");
    expect(calls[0].stable_exclude).toEqual(["jx7bbbb", "jx7cccc"]);

    // And a stub with no prefs sends none.
    calls.length = 0;
    useInboxStore.getState().setStableContextPrefs(STUB, { mode: null, exclude: null });
    useInboxStore.setState({ createSession: (async (opts: any) => { calls.push(opts); return STUB; }) as any } as any);
    try {
      await useInboxStore.getState().createSessionFromStub(STUB);
    } finally {
      useInboxStore.setState({ createSession: original } as any);
    }
    expect("stable_mode" in calls[0]).toBe(false);
    expect("stable_exclude" in calls[0]).toBe(false);
  });
});

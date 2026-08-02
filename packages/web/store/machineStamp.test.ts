import { describe, expect, it, beforeEach } from "bun:test";
import { useInboxStore } from "./inboxStore";

// The new-session machine row stamps the selected machine on the stub row
// (setSessionTargetDevice); createSessionFromStub is where that stamp becomes the
// create's target_device_id.
//
// This used to second-guess the stamp and DROP it whenever it matched what
// routing would have picked anyway. That optimization rested on the picker's
// default being stable, and it wasn't: the default was decided by `last_seen`,
// which flips between two idle online machines every ~30s. A heartbeat landing
// between the click and the create could therefore discard an explicit pick and
// hand the decision back to a server-side recency race. The selection is now
// deterministic and always carried through.

const REAL_ID = "jx70000000000000000000000000pick"; // 32 chars => isConvexId

type DispatchCall = { action: string; args: any[] };

function installFakeDispatch(): { calls: DispatchCall[] } {
  const calls: DispatchCall[] = [];
  (useInboxStore.getState() as any)._setDispatch((action: string, args: any[]) => {
    calls.push({ action, args });
    if (action === "createSession") return Promise.resolve(REAL_ID);
    return Promise.resolve(undefined);
  });
  return { calls };
}

const STUB = "stub-machine-pick";

function seedStub(targetDeviceId: string | null) {
  useInboxStore.setState({
    sessions: {
      [STUB]: {
        _id: STUB,
        session_id: STUB,
        title: "New session",
        agent_type: "claude_code",
        project_path: "/repo",
        git_root: "/repo",
        message_count: 0,
        is_idle: true,
        has_pending: false,
        started_at: Date.now(),
        updated_at: Date.now(),
        target_device_id: targetDeviceId,
      } as any,
    },
    conversations: { [STUB]: { _id: STUB, session_id: STUB, project_path: "/repo" } as any },
  } as any);
}

const ROSTER = [
  { device_id: "laptop", is_remote: false, online: true, last_seen: 9000, local_project_roots: [] },
  { device_id: "desktop", is_remote: false, online: true, last_seen: 1000, local_project_roots: ["/repo"] },
];

const createOpts = (calls: DispatchCall[]) =>
  calls.find((c) => c.action === "createSession")?.args[0] ?? {};

describe("createSessionFromStub target_device_id", () => {
  beforeEach(() => {
    useInboxStore.setState({ sessions: {}, conversations: {}, machineRoster: [], isolatedWorktreeMode: false } as any);
  });

  it("carries a pick that routing would NOT have chosen", async () => {
    const { calls } = installFakeDispatch();
    seedStub("laptop");
    useInboxStore.setState({ machineRoster: ROSTER } as any);

    await useInboxStore.getState().createSessionFromStub(STUB);

    expect(createOpts(calls).target_device_id).toBe("laptop");
  });

  // THE REGRESSION. "desktop" is also what routing would land on for /repo, and
  // the old code read that agreement as licence to drop the stamp — reopening the
  // question at send time, when the roster may have reordered.
  it("carries a pick that AGREES with routing — agreement is not a reason to drop it", async () => {
    const { calls } = installFakeDispatch();
    seedStub("desktop");
    useInboxStore.setState({ machineRoster: ROSTER } as any);

    await useInboxStore.getState().createSessionFromStub(STUB);

    expect(createOpts(calls).target_device_id).toBe("desktop");
  });

  it("carries the pick when the roster hasn't loaded", async () => {
    const { calls } = installFakeDispatch();
    seedStub("desktop");

    await useInboxStore.getState().createSessionFromStub(STUB);

    expect(createOpts(calls).target_device_id).toBe("desktop");
  });

  it("keeps the pick across a folder switch — the machine row is not the folder row", async () => {
    const { calls } = installFakeDispatch();
    seedStub("laptop");
    useInboxStore.setState({ machineRoster: ROSTER } as any);
    useInboxStore.getState().updateSessionProject(STUB, "/laptop-only");
    useInboxStore.setState({
      machineRoster: [{ ...ROSTER[0], local_project_roots: ["/laptop-only"] }, ROSTER[1]],
    } as any);

    await useInboxStore.getState().createSessionFromStub(STUB);

    expect(createOpts(calls).target_device_id).toBe("laptop");
  });

  // Non-picker entry points (cast spawn, triggers, forks, mobile) still create
  // sessions with no stamp at all, and must keep falling through to the server
  // ladder — that fallback is what stops a session being left unowned.
  it("sends no target when there is no selection to carry", async () => {
    const { calls } = installFakeDispatch();
    seedStub(null);
    useInboxStore.setState({ machineRoster: ROSTER } as any);

    await useInboxStore.getState().createSessionFromStub(STUB);

    expect(createOpts(calls)).not.toHaveProperty("target_device_id");
  });
});

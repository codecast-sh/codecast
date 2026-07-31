import { describe, expect, it, beforeEach } from "bun:test";
import { useInboxStore } from "./inboxStore";

// The new-session machine row stamps the picked machine on the stub row
// (setSessionTargetDevice); createSessionFromStub is where that stamp turns into
// the create's target_device_id — or is deliberately dropped. Dropping matters:
// an explicit target wins the FIRST rung of convex/deviceRouting, so stamping
// the machine routing would have chosen anyway silently pins the session ahead
// of the rung that prefers whichever machine holds the checkout.

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

// desktop holds the checkout, laptop is merely the most recently seen — so
// routing (and defaultMachineId) resolves "desktop" for /repo.
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

  it("drops a pick that has become the machine routing picks anyway", async () => {
    const { calls } = installFakeDispatch();
    seedStub("desktop");
    useInboxStore.setState({ machineRoster: ROSTER } as any);

    await useInboxStore.getState().createSessionFromStub(STUB);

    expect(createOpts(calls)).not.toHaveProperty("target_device_id");
  });

  it("honours the pick when the roster hasn't loaded — an empty roster proves nothing", async () => {
    const { calls } = installFakeDispatch();
    seedStub("desktop");

    await useInboxStore.getState().createSessionFromStub(STUB);

    expect(createOpts(calls).target_device_id).toBe("desktop");
  });

  it("sends no target at all when the user never picked a machine", async () => {
    const { calls } = installFakeDispatch();
    seedStub(null);
    useInboxStore.setState({ machineRoster: ROSTER } as any);

    await useInboxStore.getState().createSessionFromStub(STUB);

    expect(createOpts(calls)).not.toHaveProperty("target_device_id");
  });

  it("re-checks against the CURRENT project: a folder switch can retire the pick", async () => {
    const { calls } = installFakeDispatch();
    seedStub("laptop");
    useInboxStore.setState({ machineRoster: ROSTER } as any);
    // The user picked laptop for /repo (which only desktop has), then switched to
    // a folder only laptop has — routing now lands on laptop on its own.
    useInboxStore.getState().updateSessionProject(STUB, "/laptop-only");
    useInboxStore.setState({
      machineRoster: [
        { ...ROSTER[0], local_project_roots: ["/laptop-only"] },
        ROSTER[1],
      ],
    } as any);

    await useInboxStore.getState().createSessionFromStub(STUB);

    expect(createOpts(calls)).not.toHaveProperty("target_device_id");
  });
});

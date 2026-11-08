import { beforeEach, describe, expect, it } from "bun:test";
import { INBOX_FACT_FIELDS } from "@codecast/shared/contracts";
import { useInboxStore } from "../inboxStore";

// A liveness payload is decoded fresh on every push, so its structured facts
// (activity, open_tasks) are new objects even when nothing in them moved. The
// overlay must keep the row's own object then: row memos and wake signatures
// compare by reference, and a fresh object on every beat re-rendered every
// live row on the phone (2026-11-08, a 1,500-session account hanging).

const ID = "jx7overlayidentity0000000000000a";
const NOW = 1_800_000_000_000;

function seed() {
  const st = useInboxStore.getState() as any;
  st._setDispatch?.(async () => undefined);
  useInboxStore.setState({
    sessions: {}, conversations: {}, pending: {}, pendingMessages: {},
    currentUser: { _id: "me", name: "Me" }, clientStateInitialized: true,
  } as any);
  useInboxStore.getState().syncTable("sessions", [{
    _id: ID, user_id: "me", status: "active", title: "Live", message_count: 10,
    updated_at: NOW, started_at: NOW - 60_000, agent_status: "working", is_idle: false,
    last_heartbeat: NOW, activity: { text: "editing a.ts", tool: "Edit", at: NOW },
    open_tasks: [{ id: "t1", kind: "background", started_at: NOW, description: "build" }],
  }] as any);
}

function beat(patch: Record<string, unknown>) {
  const row = useInboxStore.getState().sessions[ID] as Record<string, unknown>;
  const facts: Record<string, unknown> = {};
  for (const key of INBOX_FACT_FIELDS) facts[key] = row[key] ?? null;
  useInboxStore.getState().applyInboxLivenessPayload("mine", structuredClone({ liveness: { [ID]: { ...facts, ...patch } } }));
  return useInboxStore.getState().sessions[ID] as Record<string, any>;
}

describe("liveness overlay keeps equal structured facts", () => {
  beforeEach(seed);

  it("a heartbeat moves the heartbeat and nothing else", () => {
    const before = useInboxStore.getState().sessions[ID] as Record<string, any>;
    const after = beat({ last_heartbeat: NOW + 1_000 });
    expect(after.last_heartbeat).toBe(NOW + 1_000);
    expect(after.activity).toBe(before.activity);
    expect(after.open_tasks).toBe(before.open_tasks);
  });

  it("a changed structured fact still lands", () => {
    const before = useInboxStore.getState().sessions[ID] as Record<string, any>;
    const after = beat({ activity: { text: "running tests", tool: "Bash", at: NOW + 2_000 } });
    expect(after.activity).not.toBe(before.activity);
    expect(after.activity.text).toBe("running tests");
    expect(after.open_tasks).toBe(before.open_tasks);
  });
});

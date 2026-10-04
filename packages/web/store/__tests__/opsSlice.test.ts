import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The Ops page's writes (store/opsSlice.ts): each paints the draft before any
// round trip and rides the side effect of the same name. A group's status is
// locked until the echo carries it; the stub a create paints carries the
// viewer's workspace key so it shows through useWorkspaceCollection at once.
const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const GROUP = serverId("group1");
const SOURCE = serverId("source1");
const ME = serverId("me");
const TEAM = serverId("team1");

const group = (status: string, updated_at = 1) => ({
  _id: GROUP, workspace: `team:${TEAM}`, source_id: SOURCE, short_id: "eg-1", kind: "error", fingerprint: "f", title: "Boom",
  status, first_seen: 1, last_seen: 1, count: 1, buckets: [], updated_at,
});

type Call = { action: string; args: any[] };

describe("ops slice", () => {
  const owner = {};
  let calls: Call[];
  beforeEach(() => {
    calls = [];
    useInboxStore.setState({
      opsGroups: { [GROUP]: group("open") },
      opsSamples: { [serverId("sample1")]: { _id: serverId("sample1"), group_id: GROUP, source_id: SOURCE, at: 1 } },
      opsSources: { [SOURCE]: { _id: SOURCE, short_id: "src-1", name: "web", status: "active", last_error: "stopped", workspace: `team:${TEAM}`, updated_at: 1 } },
      opsApps: { [SOURCE]: { _id: SOURCE, grants: [] } },
      currentUser: { _id: ME },
      pending: {},
    } as any);
    useInboxStore.getState()._setDispatch(async (action, args) => { calls.push({ action, args }); return action === "createOpsSource" ? { source_id: serverId("new"), short_id: "src-2", name: "api", ingest_key: "cc_ing_x" } : null; }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  const flush = async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

  it("a group's status paints at once, locks, and the echo retires the lock", async () => {
    useInboxStore.getState().setOpsGroupStatus(GROUP, "resolved");
    expect(useInboxStore.getState().opsGroups[GROUP].status).toBe("resolved");
    expect(useInboxStore.getState().pending[`opsGroups:${GROUP}:status`]?.type).toBe("field");
    // A list push from before the write does not undo it.
    useInboxStore.getState().syncTable("opsGroups", [group("open", 1)]);
    expect(useInboxStore.getState().opsGroups[GROUP].status).toBe("resolved");
    useInboxStore.getState().syncTable("opsGroups", [{ ...group("resolved", 2), resolved_at: 5 }]);
    expect(useInboxStore.getState().pending[`opsGroups:${GROUP}:status`]).toBeUndefined();
    await flush();
    expect(calls).toEqual([{ action: "setOpsGroupStatus", args: [GROUP, "resolved"] }]);
  });

  it("resuming a source clears the reason it stopped", async () => {
    useInboxStore.getState().setOpsSourceStatus(SOURCE, "active");
    expect(useInboxStore.getState().opsSources[SOURCE].last_error).toBeUndefined();
    useInboxStore.getState().setOpsSourceStatus(SOURCE, "paused");
    expect(useInboxStore.getState().opsSources[SOURCE].status).toBe("paused");
    await flush();
    expect(calls.map((c) => c.args[1])).toEqual(["active", "paused"]);
  });

  it("grant and revoke move the grant list; remove drops the source", async () => {
    useInboxStore.getState().grantOpsAction(SOURCE, "jobs.rerun");
    expect(useInboxStore.getState().opsApps[SOURCE].grants.map((g: any) => g.action)).toEqual(["jobs.rerun"]);
    useInboxStore.getState().revokeOpsAction(SOURCE, "jobs.rerun");
    expect(useInboxStore.getState().opsApps[SOURCE].grants).toEqual([]);
    useInboxStore.getState().removeOpsSource(SOURCE);
    expect(useInboxStore.getState().opsSources[SOURCE]).toBeUndefined();
    // Its groups and samples go with it: the server purges them, and the
    // Issues tab, its badge and the group page must not keep a ghost.
    expect(useInboxStore.getState().opsGroups[GROUP]).toBeUndefined();
    expect(Object.keys(useInboxStore.getState().opsSamples)).toEqual([]);
    await flush();
    expect(calls.map((c) => c.action)).toEqual(["grantOpsAction", "revokeOpsAction", "removeOpsSource"]);
  });

  it("a create paints a stub in the named workspace and hands the caller the server's answer", async () => {
    const res = await useInboxStore.getState().createOpsSource({ name: " API ", provider: "sdk", workspace: "team", team_id: TEAM });
    const stub = Object.values(useInboxStore.getState().opsSources).find((s: any) => s._id.startsWith("temp_src_")) as any;
    expect(stub).toMatchObject({ name: "api", workspace: `team:${TEAM}`, status: "active", keyed: true });
    expect(res?.ingest_key).toBe("cc_ing_x");
    expect(calls[0]).toEqual({ action: "createOpsSource", args: [{ name: " API ", provider: "sdk", workspace: "team", team_id: TEAM }] });
  });

  it("the server row supersedes the create's stub by name, and later snapshots keep one row", async () => {
    await useInboxStore.getState().createOpsSource({ name: " API ", provider: "sdk", workspace: "team", team_id: TEAM });
    const real = { _id: serverId("realsrc"), short_id: "src-2", name: "api", provider: "sdk", status: "active", workspace: `team:${TEAM}`, updated_at: 2 };
    const existing = useInboxStore.getState().opsSources[SOURCE];
    useInboxStore.getState().syncTable("opsSources", [existing, real]);
    useInboxStore.getState().syncTable("opsSources", [existing, real]);
    const ids = Object.keys(useInboxStore.getState().opsSources).sort();
    expect(ids).toEqual([SOURCE, real._id].sort());
    expect(Object.keys(useInboxStore.getState().pending).filter((k) => k.startsWith("opsSources:"))).toEqual([]);
  });

  it("a vendor source carries its projects and mints no key", async () => {
    await useInboxStore.getState().createOpsSource({ name: "sentry", provider: "sentry", workspace: "team", team_id: TEAM, config: { projects: ["web"] } });
    const stub = Object.values(useInboxStore.getState().opsSources).find((s: any) => s._id.startsWith("temp_src_")) as any;
    expect(stub).toMatchObject({ provider: "sentry", keyed: false, config: { projects: ["web"] } });
  });
});

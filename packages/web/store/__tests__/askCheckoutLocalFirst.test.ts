import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// "Tell writer" on a stuck checkout (lineSlice askCheckout): the ask reads as told the moment it is pressed, rides the
// askCheckout dispatch, and a feed push that arrives before the server row carries it does not take it back.
const ID = "chk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const row = () => ({
  _id: ID, workspace: "team:t1", repository: "acme/app", device_id: "dev-1", path: "/work/app", reported_at: 1, device_label: "Mac-mini",
  branch: "main", upstream: "origin/main", head_sha: "a", ahead: 0, behind: 364, fetched_at: 1,
  uncommitted: { total: 2, sessions: [{ conversation_id: "conv_1", session_id: "s1", client: "claude", state: "finished", last_activity: 5, paths: ["x.ts"], more: 0 }], unattributed: ["y.md"], unattributed_more: 0 },
  level: { state: "stuck", files: ["x.ts", "y.md"], reason: "2 file(s) changed here and in abc without a clean merge", since: 10, told: [] },
});
const told = () => (useInboxStore.getState() as any).checkouts[ID].level.told;

describe("asking about a stuck checkout", () => {
  const owner = {};
  const sent: any[] = [];
  beforeEach(() => {
    sent.length = 0;
    useInboxStore.setState({ checkouts: { [ID]: row() }, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async (name: string, args: unknown) => { sent.push([name, args]); return { told: 1 }; }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  it("reads as told at once and asks the server", async () => {
    useInboxStore.getState().askCheckout(ID, "conv_1", 50);
    expect(told()).toEqual([expect.objectContaining({ to: "session", conversation_id: "conv_1", files: 1 })]);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map(([name]) => name)).toContain("askCheckout");
  });

  it("the server's echo carrying the ask settles it", () => {
    useInboxStore.getState().askCheckout(ID, "finding", 50);
    const echoed = { ...row(), level: { ...row().level, told: [{ at: 50, files: 1, to: "finding" }] } };
    useInboxStore.getState().syncTable("checkouts", [echoed], { isDelta: true });
    expect(Object.keys((useInboxStore.getState() as any).pending).filter((k) => k.startsWith("checkouts:"))).toEqual([]);
    expect(told()).toEqual([{ at: 50, files: 1, to: "finding" }]);
  });

  it("a feed push without the ask yet keeps it", () => {
    useInboxStore.getState().askCheckout(ID, "finding", 50);
    useInboxStore.getState().syncTable("checkouts", [{ ...row(), reported_at: 2 }], { isDelta: true });
    expect(told()).toEqual([expect.objectContaining({ to: "finding", files: 1 })]);
  });

  it("a session that wrote none of the files, or a checkout no longer stuck, asks nothing", () => {
    useInboxStore.getState().askCheckout(ID, "conv_9", 50);
    expect(told()).toEqual([]);
    useInboxStore.setState({ checkouts: { [ID]: { ...row(), level: { state: "level", levelled_at: 20 } } } } as any);
    useInboxStore.getState().askCheckout(ID, "conv_1", 50);
    expect((useInboxStore.getState() as any).checkouts[ID].level).toEqual({ state: "level", levelled_at: 20 });
  });
});

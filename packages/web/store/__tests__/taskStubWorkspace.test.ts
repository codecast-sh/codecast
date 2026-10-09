import { afterEach, beforeEach, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { taskStubId } from "../taskStub";
import { isReadyInStore, storeStatusOf } from "../../lib/taskBlockers";

// A create stub carries the ACCESS key the server will stamp
// (task-graph.md TG1, CLAUDE.md "Workspace access vs routing"): every read
// scoped to a ROW's own workspace — a subtask's readiness against its parent,
// the relation palette's candidates — compares keys, and a null key matches
// nothing, so an unstamped stub would be withheld from the Unblocked view and
// offered no candidates until the server echo.

const id = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const ME = id("me");
const TEAM = id("team");
const PARENT = id("parent");
const owner = {};

beforeEach(() => {
  useInboxStore.setState({
    tasks: {},
    currentUser: { _id: ME },
    clientState: { ui: {} },
    pending: {},
  } as any);
  useInboxStore.getState()._setDispatch(async () => null, { owner });
});
afterEach(() => useInboxStore.getState()._clearDispatch(owner));

const stubOf = (key: string) => (useInboxStore.getState() as any).tasks[taskStubId(key)];

test("a personal create is keyed to the viewer, a team create to the team", async () => {
  await (useInboxStore.getState() as any).createTask({ client_key: "k1", title: "Mine" });
  expect(stubOf("k1").workspace).toBe(`user:${ME}`);

  useInboxStore.setState({ clientState: { ui: { active_team_id: TEAM } } } as any);
  await (useInboxStore.getState() as any).createTask({ client_key: "k2", title: "Ours", team_id: TEAM });
  expect(stubOf("k2").workspace).toBe(`team:${TEAM}`);
});

test("a subtask takes its parent's key, so its readiness reads the parent instead of calling it unknown", async () => {
  useInboxStore.setState({
    tasks: { [PARENT]: { _id: PARENT, short_id: "ct-1", title: "Parent", status: "open", workspace: `user:${ME}`, updated_at: 1 } },
  } as any);
  await (useInboxStore.getState() as any).createTask({ client_key: "k3", title: "Step", parent: "ct-1" });

  const tasks = (useInboxStore.getState() as any).tasks;
  const stub = stubOf("k3");
  expect(stub.workspace).toBe(`user:${ME}`);
  // The parent resolves through the stub's own key, so readiness answers on
  // the parent's status rather than parent_unknown.
  expect(storeStatusOf(tasks, stub)(PARENT)?.status).toBe("open");
  expect(isReadyInStore(stub, tasks, ME)).toBe(true);
});

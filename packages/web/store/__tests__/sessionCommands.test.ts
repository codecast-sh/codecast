// The daemon-command store actions (restart, device move, account switch) on
// the one sessionCommands model hibernate uses: each paints its row in the same
// tick, dispatches its same-named side effect, settles from the echo, and a
// refusal ends the row failed through the standard dispatch-failure path.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { applyDispatchFailure } from "../../lib/dispatchBinding";
import {
  DISPATCH_REFUSED,
  RESTART_GIVE_UP_AFTER_MS,
  deviceMoveStatusOf,
  latestRestartRow,
  requestAccountSwitchCommand,
  requestSessionMove,
  requestSessionRestart,
  restartPending,
  switchPending,
} from "../../lib/sessionCommands";
import { restartPhaseOf } from "../../hooks/useSessionRestart";
import { machineSwitchStatus } from "../../hooks/useMachineAccountSwitch";

const owner = {};
const store = () => useInboxStore.getState();
const CONV = "c".repeat(32);
const refusal = () => new Error("[CONVEX M(dispatch:dispatch)] Uncaught Error: Not authorized");
let calls: { action: string; args: any[] }[];

function dispatchWith(fn: (action: string, args: any[]) => Promise<unknown>) {
  store()._setDispatch(async (action: string, args: any[]) => {
    calls.push({ action, args });
    return fn(action, args);
  }, { owner } as any);
}

beforeEach(() => {
  calls = [];
  useInboxStore.setState({ sessionCommands: {}, pending: {}, lastDispatchFailure: null } as any);
  store()._setDispatchError(applyDispatchFailure);
});
afterEach(() => {
  store()._clearDispatch(owner);
  store()._setDispatchError(() => {});
});

const only = () => Object.values(store().sessionCommands)[0] as any;

test("restart paints in the same tick, dispatches restartSession with its request id, and the echo settles it", async () => {
  dispatchWith(async () => ({ conversation_id: CONV, restored: false }));
  const done = requestSessionRestart(CONV, { session_id: "s" });
  const row = only();
  expect(row).toMatchObject({ conversation_id: CONV, command: "resume_session", kind: "restart", executed_at: null });
  expect(restartPending(row, Date.now())).toBe(true);
  expect(restartPhaseOf(row, Date.now()).phase).toBe("restarting");
  await done;
  expect(calls).toEqual([{ action: "restartSession", args: [row._id, CONV, { session_id: "s" }, false] }]);
  // The server's row carries no intent: the stub's kind survives the echo.
  store().syncTable("sessionCommands", [{ _id: row._id, command_id: "k1", conversation_id: CONV, command: "resume_session", requested_at: 1, executed_at: 5, result: '{"resumed":true}', error: null }]);
  const settled = store().sessionCommands[row._id] as any;
  expect(settled).toMatchObject({ kind: "restart", executed_at: 5 });
  expect(restartPending(settled, Date.now())).toBe(false);
  store().confirmSessionCommand(row._id);
  expect(restartPhaseOf(store().sessionCommands[row._id] as any, Date.now()).phase).toBe("restored");
});

test("a repair keeps its restart's click as the start of the give-up budget", async () => {
  dispatchWith(async () => ({}));
  await requestSessionRestart(CONV);
  const restart = only();
  await requestSessionRestart(CONV, undefined, true);
  const repair = latestRestartRow(store().sessionCommands, CONV)!;
  expect(Object.keys(store().sessionCommands)).toEqual([repair._id]);
  expect(repair).toMatchObject({ kind: "repair", started_at: restart.requested_at });
  expect(calls.at(-1)).toEqual({ action: "restartSession", args: [repair._id, CONV, null, true] });
});

test("a refused restart ends failed through the dispatch-failure path, never a forever-spinner", async () => {
  dispatchWith(async () => { throw refusal(); });
  await expect(requestSessionRestart(CONV)).rejects.toThrow("Not authorized");
  const row = only();
  expect(row).toMatchObject({ result: DISPATCH_REFUSED });
  expect(row.executed_at).toBeGreaterThan(0);
  expect(restartPending(row, Date.now())).toBe(false);
  expect(restartPhaseOf(row, Date.now()).phase).toBe("failed");
  expect(store().lastDispatchFailure).toMatchObject({ action: "restartSession" });
});

test("a restart nothing answers expires at read time from when it was asked", () => {
  const row = { _id: "r", conversation_id: CONV, command: "resume_session", kind: "restart" as const, requested_at: 1_000, executed_at: null, result: null, error: null };
  expect(restartPending(row, 1_000 + RESTART_GIVE_UP_AFTER_MS - 1)).toBe(true);
  expect(restartPending(row, 1_000 + RESTART_GIVE_UP_AFTER_MS)).toBe(false);
  expect(restartPhaseOf(row, 1_000 + RESTART_GIVE_UP_AFTER_MS)).toMatchObject({ phase: "failed" });
});

test("device move paints its target, dispatches moveSessionToDevice, and narrates from the pipeline rows", async () => {
  dispatchWith(async () => ({ command_id: "m1" }));
  const done = requestSessionMove(CONV, { device_id: "mac-2", is_remote: true, label: "Cloud Mac" });
  const row = only();
  expect(row).toMatchObject({ kind: "move", command: "move_to_device", to_device_id: "mac-2", to_remote: true, to_label: "Cloud Mac", executed_at: null });
  const now = Date.now();
  expect(deviceMoveStatusOf(row, [row], now)).toMatchObject({ phase: "restarting", stage: { label: "Transferring session to Cloud Mac — this can take a few minutes…" } });
  await done;
  expect(calls).toEqual([{ action: "moveSessionToDevice", args: [row._id, CONV, "mac-2", true, "Cloud Mac"] }]);
  store().syncTable("sessionCommands", [
    { _id: row._id, command_id: "m1", conversation_id: CONV, command: "move_to_device", requested_at: now, executed_at: now + 1, result: "ok", error: null },
    { _id: "resume1", command_id: "resume1", conversation_id: CONV, command: "resume_session", requested_at: now + 2, executed_at: now + 3, result: "{}", error: null },
  ]);
  const settled = store().sessionCommands[row._id] as any;
  expect(settled.to_label).toBe("Cloud Mac");
  const status = deviceMoveStatusOf(settled, Object.values(store().sessionCommands) as any, now + 4);
  expect(status.resumed?._id).toBe("resume1");
});

test("a refused move ends failed with the server's reason", async () => {
  dispatchWith(async () => { throw refusal(); });
  await expect(requestSessionMove(CONV, { device_id: "mac-2", is_remote: false, label: "Mac" })).rejects.toThrow();
  const row = only();
  expect(row.result).toBe(DISPATCH_REFUSED);
  expect(deviceMoveStatusOf(row, [row], Date.now())).toMatchObject({ phase: "failed" });
  expect(store().lastDispatchFailure).toMatchObject({ action: "moveSessionToDevice" });
});

test("account switch paints the machine's row, dispatches requestAccountSwitch, and settles from the daemon then the heartbeat", async () => {
  dispatchWith(async () => ({ command_ids: ["sw1"] }));
  const args = { profile: "backup", device_id: "mac-1", continue_blocked: false };
  const done = requestAccountSwitchCommand(args, { profile: "backup", email: "b@x.com" });
  const row = only();
  expect(row).toMatchObject({ kind: "switch", command: "switch_account", device_id: "mac-1", profile: "backup", email: "b@x.com", executed_at: null });
  expect(switchPending(row, Date.now())).toBe(true);
  await done;
  expect(calls).toEqual([{ action: "requestAccountSwitch", args: [row._id, args, { profile: "backup", email: "b@x.com" }] }]);
  store().syncTable("sessionCommands", [{ _id: row._id, command_id: "sw1", conversation_id: null, command: "switch_account", device_id: "mac-1", requested_at: Date.now(), executed_at: Date.now(), result: "ok", error: null }]);
  const settled = store().sessionCommands[row._id] as any;
  expect(settled.profile).toBe("backup");
  expect(machineSwitchStatus(settled, { activeEmail: "a@x.com" }, Date.now()).phase).toBe("confirming");
  expect(machineSwitchStatus(settled, { activeEmail: "b@x.com" }, Date.now()).phase).toBe("succeeded");
});

test("a swap no daemon accepted fails on the reply; a plain revive with no command settles clean", async () => {
  dispatchWith(async () => ({ command_ids: [] }));
  await requestAccountSwitchCommand({ email: "b@x.com", device_id: "mac-1" });
  const swap = only();
  expect(swap).toMatchObject({ result: "no_command", error: "No daemon accepted the account switch" });
  expect(machineSwitchStatus(swap, {}, Date.now()).phase).toBe("failed");
  useInboxStore.setState({ sessionCommands: {} } as any);
  await requestAccountSwitchCommand({ conversation_ids: [CONV] });
  expect(only()).toMatchObject({ result: "continued", error: null, conversation_id: CONV });
  expect(switchPending(only(), Date.now())).toBe(false);
});

test("a refused account switch ends failed through the dispatch-failure path", async () => {
  dispatchWith(async () => { throw refusal(); });
  await expect(requestAccountSwitchCommand({ profile: "backup", device_id: "mac-1" })).rejects.toThrow();
  const row = only();
  expect(row.result).toBe(DISPATCH_REFUSED);
  expect(switchPending(row, Date.now())).toBe(false);
  expect(machineSwitchStatus(row, {}, Date.now()).phase).toBe("failed");
  expect(store().lastDispatchFailure).toMatchObject({ action: "requestAccountSwitch" });
});

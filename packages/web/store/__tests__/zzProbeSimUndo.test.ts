// TEMPORARY probe (validation round 3, sync lens). Deleted after the run.
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { _resetUndoStacks, performRedo } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { performUndo } from "../undoStack";
import { Device, SimServer, bootDevice, installSim, seededWorld, settleAndAssertConverged, uninstallSim } from "./inboxSimHarness";

setDefaultTimeout(600_000);
beforeEach(installSim);
afterEach(uninstallSim);

const shownIn = (d: Device, id: string) => Object.fromEntries(d.windows.map((w) => [w.name, w.shows(id)]));
const pick = async (server: SimServer, d: Device) => {
  const live = new Set((await server.base()).sessions.map((s: any) => String(s._id)));
  return [...live].filter((id) => d.windows.every((w) => w.shows(id)) && !server.conv(id).inbox_pinned_at && !server.conv(id).inbox_killed_at).sort();
};
const locksOn = (w: any, id: string) => Object.entries(w.window.store.getState().pending).filter(([k]) => k.includes(id));

describe("probe: follower kill, echo, undo", () => {
  it("kill undo after the echo converges and the server un-kills", async () => {
    const server = new SimServer(seededWorld(131));
    const A = await bootDevice(server, "A", 1, 1);
    const [q] = await pick(server, A);
    const w1 = A.followers[0]!;
    _resetUndoStacks();
    await w1.kill(q!);
    await A.drain();
    await A.host.receiveAll();
    await A.drain();
    console.log("after kill echo server", JSON.stringify({ d: server.conv(q!).inbox_dismissed_at, k: server.conv(q!).inbox_killed_at }));
    expect(await w1.withStore(() => performUndo())).toBe(true);
    await A.drain();
    console.log("after undo shown", JSON.stringify(shownIn(A, q!)));
    await A.host.receiveAll();
    await A.drain();
    console.log("after undo echo shown", JSON.stringify(shownIn(A, q!)), "server", JSON.stringify({ d: server.conv(q!).inbox_dismissed_at, k: server.conv(q!).inbox_killed_at }));
    console.log("locks w1", JSON.stringify(locksOn(w1, q!)), "host", JSON.stringify(locksOn(A.host, q!)));
    expect(shownIn(A, q!)).toEqual({ "A-host": true, "A-w1": true });
    await settleAndAssertConverged(server, A.windows);
    console.log("settled shown", JSON.stringify(shownIn(A, q!)));
    expect(shownIn(A, q!)).toEqual({ "A-host": true, "A-w1": true });
  });

  it("kill, undo, redo from a follower converges as killed", async () => {
    const server = new SimServer(seededWorld(137));
    const A = await bootDevice(server, "A", 1, 1);
    const [q] = await pick(server, A);
    const w1 = A.followers[0]!;
    _resetUndoStacks();
    await w1.kill(q!);
    await A.drain();
    await A.host.receiveAll();
    await A.drain();
    expect(await w1.withStore(() => performUndo())).toBe(true);
    await A.drain();
    await A.host.receiveAll();
    await A.drain();
    const before = await w1.withStore(() => {
      const st: any = useInboxStore.getState();
      return { s: st.sessions[q!], c: st.conversations[q!] };
    });
    expect(await w1.withStore(() => performRedo())).toBe(true);
    const { getUndoHistory } = await import("@platform/engine");
    const it0: any = getUndoHistory().items[0];
    console.log("redo status", it0.status, it0.label);
    for (const c of it0.changes ?? []) {
      const cur = (c.store === "sessions" ? before.s : c.store === "conversations" ? before.c : undefined)?.[c.field];
      console.log("cell", c.store, c.field, c.kind, "before", JSON.stringify(c.before), c.hadBefore, "after", JSON.stringify(c.after), "cur", JSON.stringify(cur), c.field && before.s && c.field in (c.store === "sessions" ? before.s : before.c ?? {}));
    }
    await A.drain();
    await A.host.receiveAll();
    await A.drain();
    console.log("after redo echo shown", JSON.stringify(shownIn(A, q!)), "server", JSON.stringify({ d: server.conv(q!).inbox_dismissed_at, k: server.conv(q!).inbox_killed_at }));
    expect(shownIn(A, q!)).toEqual({ "A-host": false, "A-w1": false });
    await settleAndAssertConverged(server, A.windows);
    expect(shownIn(A, q!)).toEqual({ "A-host": false, "A-w1": false });
  });

  it("pin, echo, undo from a follower converges unpinned with no lock left", async () => {
    const server = new SimServer(seededWorld(139));
    const A = await bootDevice(server, "A", 1, 1);
    const [q] = await pick(server, A);
    const w1 = A.followers[0]!;
    _resetUndoStacks();
    await w1.pin(q!);
    await A.drain();
    await A.host.receiveAll();
    await A.drain();
    expect(await w1.withStore(() => performUndo())).toBe(true);
    await A.drain();
    await A.host.receiveAll();
    await A.drain();
    console.log("server pin", server.conv(q!).inbox_pinned_at, "locks w1", JSON.stringify(locksOn(w1, q!)), "host", JSON.stringify(locksOn(A.host, q!)));
    expect(server.conv(q!).inbox_pinned_at ?? null).toBe(null);
    await settleAndAssertConverged(server, A.windows);
  });

  it("stash from host, undo from host, follower converges", async () => {
    const server = new SimServer(seededWorld(149));
    const A = await bootDevice(server, "A", 1, 1);
    const [q] = await pick(server, A);
    _resetUndoStacks();
    await A.host.stash(q!);
    await A.drain();
    await A.host.receiveAll();
    await A.drain();
    expect(shownIn(A, q!)).toEqual({ "A-host": false, "A-w1": false });
    expect(await A.host.withStore(() => performUndo())).toBe(true);
    await A.drain();
    console.log("after host undo shown", JSON.stringify(shownIn(A, q!)));
    expect(shownIn(A, q!)).toEqual({ "A-host": true, "A-w1": true });
    await settleAndAssertConverged(server, A.windows);
  });
});

// Two checks on undo across windows (docs/architecture/undo-history.md).
//
// undoTakesOnlyItsWindows: production keeps one undo history per browser
// window, so ⌘Z in a follower that recorded nothing takes nothing back, even
// when the host just stashed a row. The sim keeps each window's history in
// its own slot (the engine's undo-stack seam in sim/windowSlots.ts); with one
// history for the whole process, the follower's press took back the host's
// stash.
//
// archivedDocLeavesLists: an archived doc reaches every window through the
// sync log WITH archived_at set (the undo's tombstone check and the doc's own
// page need that state), and every docs list leaves it out, on the acting
// device and the other one alike.

import { expect } from "bun:test";
import { activeWorkspaceKeyOf } from "../../../../lib/workspaceScope";
import { workspaceRows } from "../../../../hooks/useWorkspaceCollection";
import { getUndoHistory } from "../../../undoStack";
import { scenario } from "../dsl";

scenario({ name: "undoTakesOnlyItsWindows", seeds: 3 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const [f] = a.followers;
  await w.expect(a.host).shows(s);
  w.human(a.host).stash(s);
  await w.settle();
  expect(await f!.run(() => getUndoHistory().items.length)).toBe(0);
  expect(await a.host.run(() => getUndoHistory().items.length)).toBe(1);
  w.human(f!).undo();
  await w.settle();
  for (const win of a.windows) await w.expect(win).hides(s);
  // The host's own press still reaches its stash.
  w.human(a.host).undo();
  await w.settle();
  for (const win of a.windows) await w.expect(win).shows(s);
});

scenario({ name: "archivedDocLeavesLists", seeds: 2 }, async (w) => {
  w.user("ada");
  const a = await w.device("ada");
  const b = await w.device("ada");
  const windows = [...a.windows, ...b.windows];
  // The create's receipt lands only as the net drains, so it is not awaited.
  await a.host.run(() => { void (a.host.store.getState() as any).createDoc({ title: "d1", content: "sim doc d1" }); });
  await w.settle();
  const id = await a.host.run(() => {
    const docs = Object.values((a.host.store.getState() as any).docs ?? {}) as any[];
    return String(docs.find((d) => d.title === "d1")?._id);
  });
  const read = (win: (typeof windows)[number]) =>
    win.run(() => {
      const st = win.store.getState() as any;
      const row = (st.docs ?? {})[id];
      return { held: !!row, archived: !!row?.archived_at, listed: workspaceRows("docs", st.docs ?? {}, activeWorkspaceKeyOf(st)).some((r: any) => r._id === id) };
    });
  for (const win of windows) expect([win.name, (await read(win)).listed]).toEqual([win.name, true]);
  await a.host.run(() => (a.host.store.getState() as any).archiveDoc(id));
  await w.settle();
  for (const win of windows) {
    const r = await read(win);
    // Held or not, an archived doc is in no list; held, it carries its stamp.
    expect([win.name, r.listed, r.held && !r.archived]).toEqual([win.name, false, false]);
  }
});

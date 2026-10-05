// TEMP probe (validation round 22); deleted after the run.
import { scenario } from "../dsl";

scenario({ name: "r22FollowerStashHostClosedThenUndo", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 2 });
  const f = a.followers[0]!;
  await w.expect(f).shows(s);
  w.human(f).stash(s);
  await w.settle();
  for (const win of a.windows) await w.expect(win).hides(s);
  await a.closeHost();
  await w.settle();
  w.human(f).undo();
  await w.settle();
  for (const win of a.windows) await w.expect(win).shows(s);
});

scenario({ name: "r22FollowerQuickUndoRedoPin", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const other = await w.device("ada");
  const f = a.followers[0]!;
  await w.expect(f).shows(s);
  w.human(f).pin(s);
  w.human(f).undo();
  w.human(f).redo();
  await w.settle();
  w.human(f).undo();
  await w.settle();
});

scenario({ name: "r22HostStashUndoFollowerSees", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const other = await w.device("ada");
  await w.expect(a.host).shows(s);
  w.human(a.host).stash(s);
  w.human(a.host).undo();
  await w.settle();
  for (const win of [...a.windows, ...other.windows]) await w.expect(win).shows(s);
  w.human(a.host).redo();
  await w.settle();
  for (const win of [...a.windows, ...other.windows]) await w.expect(win).hides(s);
});

scenario({ name: "r22FollowerKillUndoOtherRestores", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const other = await w.device("ada");
  const f = a.followers[0]!;
  await w.expect(f).shows(s);
  w.human(f).stash(s);
  await w.settle();
  w.human(other.host).restore(s);
  w.human(f).undo();
  await w.settle();
  w.human(f).redo();
  await w.settle();
});

scenario({ name: "r22FollowerPinUndoHostClosed", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const f = a.followers[0]!;
  await w.expect(f).shows(s);
  w.human(f).pin(s);
  w.human(f).undo();
  await a.closeHost();
  await w.settle();
  w.human(f).redo();
  await w.settle();
});

scenario({ name: "r22ControlFollowerTriplePin", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const other = await w.device("ada");
  const f = a.followers[0]!;
  await w.expect(f).shows(s);
  w.human(f).pin(s);
  w.human(f).pin(s);
  w.human(f).pin(s);
  await w.settle();
  w.human(f).pin(s);
  await w.settle();
});

scenario({ name: "r22ViewerStashUndoFollower", seeds: 4 }, async (w) => {
  w.team("acme");
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s", { agentStatus: "working" });
  const b = await w.device("bo", { scope: { team: "acme" }, followers: 1 });
  const f = b.followers[0]!;
  await w.expect(f).shows(s);
  w.human(f).stash(s);
  await w.settle();
  for (const win of b.windows) await w.expect(win).hides(s);
  w.human(f).undo();
  await w.settle();
  for (const win of b.windows) await w.expect(win).shows(s);
  w.human(f).redo();
  await w.settle();
  for (const win of b.windows) await w.expect(win).hides(s);
});

scenario({ name: "r22ViewerKillUndoHostQuick", seeds: 4 }, async (w) => {
  w.team("acme");
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s", { agentStatus: "working" });
  const b = await w.device("bo", { scope: { team: "acme" }, followers: 1 });
  await w.expect(b.host).shows(s);
  w.human(b.host).kill(s);
  w.human(b.host).undo();
  await w.settle();
  for (const win of b.windows) await w.expect(win).shows(s);
});

const titleOf = (win: any, id: string) => win.run(() => {
  const st = win.store.getState() as any;
  return { s: st.sessions?.[id]?.title, c: st.conversations?.[id]?.title };
});

scenario({ name: "r22FollowerRenameUndoRedo", seeds: 6 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const other = await w.device("ada");
  const f = a.followers[0]!;
  await w.expect(f).shows(s);
  const id = w.idOf(s);
  await f.run(() => (f.store.getState() as any).renameSession(id, "one"));
  await f.run(() => (f.store.getState() as any).renameSession(id, "two"));
  w.human(f).undo();
  await w.settle();
  const server = (await w.row(s)) as any;
  const seen = [] as any[];
  for (const win of [...a.windows, ...other.windows]) seen.push([win.name, await titleOf(win, id)]);
  console.log("R22 rename undo", server?.title, JSON.stringify(seen));
  w.human(f).redo();
  await w.settle();
  const server2 = (await w.row(s)) as any;
  const seen2 = [] as any[];
  for (const win of [...a.windows, ...other.windows]) seen2.push([win.name, await titleOf(win, id)]);
  console.log("R22 rename redo", server2?.title, JSON.stringify(seen2));
});

scenario({ name: "r22ControlFollowerThreeRenames", seeds: 6 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const other = await w.device("ada");
  const f = a.followers[0]!;
  await w.expect(f).shows(s);
  const id = w.idOf(s);
  await f.run(() => (f.store.getState() as any).renameSession(id, "one"));
  await f.run(() => (f.store.getState() as any).renameSession(id, "two"));
  await f.run(() => (f.store.getState() as any).renameSession(id, "one"));
  await w.settle();
});

import { activeWorkspaceKeyOf } from "../../../../lib/workspaceScope";
import { workspaceRows } from "../../../../hooks/useWorkspaceCollection";
import { performUndo, performRedo } from "../../../undoStack";

async function docProbe(w: any, actor: "follower" | "host", quick: boolean) {
  w.user("ada");
  const a = await w.device("ada", { followers: 1 });
  const b = await w.device("ada");
  const windows = [...a.windows, ...b.windows];
  await a.host.run(() => { void (a.host.store.getState() as any).createDoc({ title: "d1", content: "sim doc d1" }); });
  await w.settle();
  const id = await a.host.run(() => {
    const docs = Object.values((a.host.store.getState() as any).docs ?? {}) as any[];
    return String(docs.find((d) => d.title === "d1")?._id);
  });
  const read = (win: any) => win.run(() => {
    const st = win.store.getState() as any;
    const row = (st.docs ?? {})[id];
    return { held: !!row, archived: !!row?.archived_at, listed: workspaceRows("docs", st.docs ?? {}, activeWorkspaceKeyOf(st)).some((r: any) => r._id === id) };
  });
  const win = actor === "follower" ? a.followers[0] : a.host;
  await w.settle();
  await win.run(() => (win.store.getState() as any).archiveDoc(id));
  if (!quick) await w.settle();
  await win.run(() => performUndo());
  await w.settle();
  const out1: any[] = [];
  for (const x of windows) out1.push([x.name, await read(x)]);
  console.log("R22 doc undo", actor, quick, JSON.stringify(out1));
  await win.run(() => performRedo());
  await w.settle();
  const out2: any[] = [];
  for (const x of windows) out2.push([x.name, await read(x)]);
  console.log("R22 doc redo", actor, quick, JSON.stringify(out2));
}
scenario({ name: "r22DocArchiveUndoFollower", seeds: 3 }, (w) => docProbe(w, "follower", false));
scenario({ name: "r22DocArchiveUndoFollowerQuick", seeds: 3 }, (w) => docProbe(w, "follower", true));
scenario({ name: "r22DocArchiveUndoHostQuick", seeds: 3 }, (w) => docProbe(w, "host", true));

scenario({ name: "r22DocDebug", seeds: 1, modes: ["scripted"] }, async (w) => {
  w.user("ada");
  const a = await w.device("ada");
  const h = a.host;
  await h.run(() => { void (h.store.getState() as any).createDoc({ title: "d1", content: "sim doc d1" }); });
  await w.settle();
  const id = await h.run(() => String((Object.values((h.store.getState() as any).docs ?? {}) as any[]).find((d) => d.title === "d1")?._id));
  const dump = (tag: string) => h.run(() => {
    const st = h.store.getState() as any;
    const p = Object.entries(st.pending).filter(([k]) => k.includes(id));
    console.log("R22DBG", tag, JSON.stringify(p), "row", JSON.stringify(st.docs?.[id] ? { a: st.docs[id].archived_at, u: st.docs[id].updated_at } : null));
  });
  await dump("created");
  const orig = (h.store.getState() as any).syncTable;
  await h.run(() => (h.store.getState() as any).archiveDoc(id));
  await dump("archived");
  await h.run(() => performUndo());
  await dump("undone");
  await w.settle().catch((e: any) => console.log("R22DBG settle fail", String(e.message).split("\n")[0]));
  await dump("settled");
});

scenario({ name: "r22SiblingActsBetween", seeds: 6 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const f = a.followers[0]!;
  await w.expect(a.host).shows(s);
  w.human(a.host).stash(s);
  await w.settle();
  w.human(f).restore(s);
  w.human(f).pin(s);
  await w.settle();
  w.human(a.host).undo();
  await w.settle();
  w.human(a.host).redo();
  await w.settle();
});

scenario({ name: "r22FollowerUndoThenHostActs", seeds: 6 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const f = a.followers[0]!;
  await w.expect(f).shows(s);
  w.human(f).kill(s);
  w.human(f).undo();
  w.human(a.host).stash(s);
  await w.settle();
  for (const win of a.windows) await w.expect(win).hides(s);
});

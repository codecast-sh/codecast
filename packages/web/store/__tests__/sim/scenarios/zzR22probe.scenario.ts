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

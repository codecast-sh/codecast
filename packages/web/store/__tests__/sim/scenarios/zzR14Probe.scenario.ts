// Round 14 probe (temporary): undo across windows and devices.
import { scenario } from "../dsl";
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";

scenario({ name: "r14StashUndoFollowerTwoDevices", seeds: 3 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const b = await w.device("ada", { followers: 1 });
  await w.expect(a.followers[0]!).shows(s);
  w.human(a.followers[0]!).stash(s);
  w.human(a.followers[0]!).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of [...a.windows, ...b.windows]) await w.expect(each).shows(s);
});

scenario({ name: "r14StashUndoRedoFollower", seeds: 3 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  await w.expect(a.followers[0]!).shows(s);
  w.human(a.followers[0]!).stash(s);
  await w.settle();
  w.human(a.followers[0]!).undo();
  w.human(a.followers[0]!).redo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of a.windows) await w.expect(each).hides(s);
});

scenario({ name: "r14PinUndoFollower", seeds: 3 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  await w.expect(a.followers[0]!).shows(s);
  w.human(a.followers[0]!).pin(s);
  await w.settle();
  w.human(a.followers[0]!).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  await w.expect.server.row(s).has({ inbox_pinned_at: undefined });
});

scenario({ name: "r14ViewerKillUndoFollower", seeds: 3 }, async (w) => {
  w.team("acme");
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s", { agentStatus: "working" });
  await w.device("ada", {});
  const b = await w.device("bo", { scope: { team: "acme" }, followers: 1 });
  await w.expect(b.followers[0]!).shows(s);
  w.human(b.followers[0]!).kill(s);
  await w.settle();
  await w.expect(b.host).hides(s);
  w.human(b.followers[0]!).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of b.windows) await w.expect(each).shows(s);
});

scenario({ name: "r14ViewerKillUndoHost", seeds: 3 }, async (w) => {
  w.team("acme");
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s", { agentStatus: "working" });
  await w.device("ada", {});
  const b = await w.device("bo", { scope: { team: "acme" }, followers: 1 });
  await w.expect(b.host).shows(s);
  w.human(b.host).kill(s);
  w.human(b.host).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of b.windows) await w.expect(each).shows(s);
});

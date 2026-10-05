// TEMP probe for validation round 18 (sync lens). Deleted after the run.
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";
import { scenario } from "../dsl";

scenario({ name: "r18PinUndoFollower", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const other = await w.device("ada");
  const [f] = a.followers;
  await w.expect(f).shows(s);
  w.human(f).pin(s);
  await w.settle();
  w.human(f).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  void other;
});

scenario({ name: "r18PinThenStashUndoFollower", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const [f] = a.followers;
  await w.expect(f).shows(s);
  w.human(a.host).pin(s);
  await w.settle();
  w.human(f).stash(s);
  await w.settle();
  w.human(f).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of a.windows) await w.expect(each).shows(s);
});

scenario({ name: "r18StashUndoRedoFollower", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const [f] = a.followers;
  await w.expect(f).shows(s);
  w.human(f).stash(s);
  await w.settle();
  w.human(f).undo();
  await w.settle();
  w.human(f).redo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of a.windows) await w.expect(each).hides(s);
});

scenario({ name: "r18StashThenPromoteUndo", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 2 });
  const [f] = a.followers;
  await w.expect(f).shows(s);
  w.human(f).stash(s);
  await w.settle();
  await a.closeHost();
  await w.settle();
  w.human(f).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of a.windows) await w.expect(each).shows(s);
});

scenario({ name: "r18PrivacyUndoFollower", seeds: 3 }, async (w) => {
  w.team("acme").user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s", { agentStatus: "idle", private: true } as any);
  const a = await w.device("ada", { followers: 1 });
  const [f] = a.followers;
  w.human(f).setPrivacy(s, "team");
  await w.settle();
  w.human(f).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
});

scenario({ name: "r18KillUndoHostWithFollower", seeds: 4 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  await w.expect(a.host).shows(s);
  w.human(a.host).kill(s);
  await w.settle();
  w.human(a.host).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of a.windows) await w.expect(each).shows(s);
});

scenario({ name: "r18StashUndoQuickFollower", seeds: 6 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const [f] = a.followers;
  await w.expect(f).shows(s);
  w.human(f).stash(s);
  w.human(f).undo();
  w.human(f).redo();
  w.human(f).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of a.windows) await w.expect(each).shows(s);
});

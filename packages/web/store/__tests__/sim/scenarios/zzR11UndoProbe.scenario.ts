// SCRATCH (validation round 11, ct-56508): probes of undo over sync. Delete after the round.
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";
import { scenario } from "../dsl";

const FOLLOWER_KNOWN = { "INV-followers": "ct-56817" };

scenario({ name: "r11StashUndoFollowerThenHostCloses", seeds: 3 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const win = a.followers[0]!;
  await w.expect(win).shows(s);
  await w.human(win).stash(s);
  await w.settle();
  for (const each of a.windows) await w.expect(each).hides(s);
  await w.human(win).undo();
  await w.settle();
  for (const each of a.windows) await w.expect(each).shows(s);
  await w.expect.server.row(s).has({ inbox_stashed_at: undefined, inbox_dismissed_at: undefined });
  await a.closeHost();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of a.windows) await w.expect(each).shows(s);
});

scenario({ name: "r11PinUndoFollower", seeds: 1 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  const win = a.followers[0]!;
  await w.expect(win).shows(s);
  const dump = async (tag: string) => {
    const insp = await w.inspect(s);
    const pend = Object.fromEntries(a.windows.map((x) => [x.name, Object.fromEntries(Object.entries((x.store.getState() as any).pending ?? {}).filter(([k]) => k.includes(w.idOf(s))))]));
    console.log(`R11 ${tag}`, JSON.stringify({ server: { p: insp.server?.inbox_pinned_at, ip: insp.server?.is_pinned }, windows: Object.fromEntries(Object.entries(insp.windows).map(([k, v]: any) => [k, { s: v.sessions && { p: v.sessions.inbox_pinned_at, ip: v.sessions.is_pinned }, c: v.conversations && { p: v.conversations.inbox_pinned_at, ip: v.conversations.is_pinned } }])), pend, log: w.actors.log.slice(-1) }));
  };
  await w.human(win).pin(s);
  await w.settle();
  await dump("after pin");
  await w.human(win).undo();
  await w.settle();
  await w.advance(60_000);
  await w.settle();
  await dump("after undo");
  await w.human(win).redo();
  await w.settle();
  await dump("after redo");
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  await dump("after redo+advance");
  const insp = await w.inspect(s);
  if (insp.server?.inbox_pinned_at == null) throw new Error(`redo pin did not reach server`);
});

scenario({ name: "r11PinUndoQuickHost", seeds: 5 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  await w.expect(a.host).shows(s);
  w.human(a.host).pin(s);
  w.human(a.host).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  await w.expect.server.row(s).has({ inbox_pinned_at: undefined });
});

scenario({ name: "r11ViewerKillUndoFollower", seeds: 3, known: FOLLOWER_KNOWN }, async (w) => {
  w.team("acme");
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s", { agentStatus: "idle" });
  await w.device("ada");
  const b = await w.device("bo", { scope: { team: "acme" }, followers: 1 });
  const win = b.followers[0]!;
  await w.expect(win).shows(s);
  await w.human(win).kill(s);
  await w.settle();
  for (const each of b.windows) await w.expect(each).hides(s);
  await w.human(win).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of b.windows) await w.expect(each).shows(s);
  await w.expect.server.row(s).has({ inbox_dismissed_at: undefined, inbox_killed_at: undefined });
});

scenario({ name: "r11StashUndoRedoUndoHost", seeds: 3 }, async (w) => {
  w.user("ada");
  const s = w.session("ada", "s", { agentStatus: "idle" });
  const a = await w.device("ada", { followers: 1 });
  await w.expect(a.host).shows(s);
  w.human(a.host).stash(s);
  w.human(a.host).undo();
  w.human(a.host).redo();
  w.human(a.host).undo();
  await w.settle();
  await w.advance(HIDDEN_OVERRIDE_SETTLE_MS + 60_000);
  await w.settle();
  for (const each of a.windows) await w.expect(each).shows(s);
  await w.expect.server.row(s).has({ inbox_stashed_at: undefined, inbox_dismissed_at: undefined });
});

scenario({ name: "r11PrivacyUndoFollower", seeds: 1, known: FOLLOWER_KNOWN }, async (w) => {
  w.team("acme");
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s", { agentStatus: "idle", private: true });
  const a = await w.device("ada", { followers: 1 });
  const win = a.followers[0]!;
  const before = (await w.inspect(s)).server;
  await w.human(win).setPrivacy(s, "team");
  await w.settle();
  const mid = (await w.inspect(s)).server;
  await w.human(win).undo();
  await w.settle();
  await w.advance(60_000);
  await w.settle();
  const after = await w.inspect(s);
  console.log("R11 privacy", JSON.stringify({ before: before?.is_private, mid: mid?.is_private, after: after.server?.is_private, log: w.actors.log.slice(-2), win: Object.fromEntries(Object.entries(after.windows).map(([k, v]: any) => [k, { s: v.sessions?.is_private, c: v.conversations?.is_private }])) }));
  if (Boolean(before?.is_private) !== Boolean(after.server?.is_private)) throw new Error(`privacy undo: before ${before?.is_private} after ${after.server?.is_private}`);
});

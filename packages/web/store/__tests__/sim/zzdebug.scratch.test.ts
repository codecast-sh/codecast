import { test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { runScenario } from "./dsl";

test("debug", async () => {
  const run = { mode: "scripted" as const, seed: 114430, drainPerVerb: true };
  await runScenario({ name: "roleTriggerScope" } as any, run as any, async (w: any) => {
    w.team("acme", { features: { org: true } });
    w.user("ada", ["acme"]).user("bo", ["acme"]);
    const s = w.session("bo", "s", { agentStatus: "working" });
    const rev = w.role("acme", "rev");
    await w.start();
    await w.clientAs("bo").mutation("orgRoles:reparentSession", { conversation_id: w.idOf(s), target: { kind: "role", role_id: w.idOf(rev) } });
    const dump = async (tag: string) => {
      const t = w.backend.db._tables;
      const g2 = t.conversations.find((c: any) => String(c._id).startsWith("w1830881c2"));
      const kids = t.conversations.filter((c: any) => String(c.parent_conversation_id) === String(g2._id));
      console.log(tag, "g2", JSON.stringify({ pinned: g2.is_pinned, upd: g2.updated_at, status: g2.agent_status, stash: g2.inbox_stashed_at }));
      for (const k of kids) {
        const m = t.managed_sessions.find((x: any) => String(x.conversation_id) === String(k._id));
        console.log("  kid", String(k._id), JSON.stringify({ upd: k.updated_at, mc: k.message_count, killed: k.inbox_killed_at, status: m?.agent_status, hb: m?.last_heartbeat, sUpd: m?.agent_status_updated_at }));
      }
      const lv: any = await w.clientAs("bo").query("conversations:sessionsLiveness", {});
      const row = lv?.liveness?.[String(g2._id)];
      console.log("  server g2", JSON.stringify({ bucket: row?.bucket, child_asking: row?.child_asking, asking: row?.asking }), "now", Date.now());
      const st = w.devices?.get?.("bo")?.host?.store?.getState?.();
      if (st) console.log("  replica g2", JSON.stringify({ ca: st.sessions?.[String(g2._id)]?.child_asking }));
    };
    await dump("start");
    for (const user of ["ada", "bo"]) await (await w.device(user)).host.feed("agentTasks", api.agentTasks.webList, () => ({}));
    await dump("fed");
    const bo = w.daemon("bo");
    await bo.settles(s, "permission_blocked");
    await w.settle();
    await dump("settle1");
  }, { skipInvariants: ["INV-sessions-mine"] } as any);
}, 120000);

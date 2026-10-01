import { test } from "bun:test";
import * as H from "../inboxSimHarness";
import { useInboxStore, projectReplicaInbox } from "../../inboxStore";
test("parity", async () => {
  const orig = console.error;
  let dumped = 0;
  console.error = (...args: any[]) => {
    const msg = String(args[0]);
    const m = /parity: (\w+) incremental/.exec(msg);
    if (m && dumped < 3) {
      dumped++;
      const s: any = useInboxStore.getState();
      const id = m[1];
      const row = s.sessions[id];
      orig(msg);
      orig("row", JSON.stringify(Object.fromEntries(Object.entries(row ?? {}).filter(([k]) => /status|idle|parent|spawned|team|lead|role|asking|awaiting|inbox_|pinned|message_count|user_id|is_subagent|agent/.test(k)))));
      const decs = Object.values(s.sessionDecisions ?? {}).filter((d: any) => String(d.conversation_id) === id || String(d.session_id) === id);
      orig("decisions", JSON.stringify(decs));
      const kids = Object.values(s.sessions).filter((x: any) => [x.parent_conversation_id, x.spawned_by_conversation_id].map(String).includes(id));
      orig("kids", JSON.stringify(kids.map((k: any) => ({ id: k._id, status: k.agent_status, awaiting: k.awaiting_input, team: k.agent_team_name, dec: Object.values(s.sessionDecisions ?? {}).some((d: any) => String(d.conversation_id) === k._id) }))));
      orig("pending", JSON.stringify(Object.entries(s.pending).filter(([k]) => k.includes(id))));
      const lead = String(row?.spawned_by_conversation_id);
      const lr = s.sessions[lead];
      orig("lead", lead, JSON.stringify(Object.fromEntries(Object.entries(lr ?? {}).filter(([k]) => /status|idle|awaiting|inbox_|team|spawned/.test(k)))), "queued", s.sessionsWithQueuedMessages.has(lead), "revive", JSON.stringify(s.blockedReviveRequestedAt?.[lead]), "focus", s.currentSessionId === lead, "pendingMsgs", JSON.stringify(s.pendingMessages?.[lead] ?? null).slice(0, 200), "decLead", JSON.stringify(Object.values(s.sessionDecisions ?? {}).filter((d: any) => String(d.conversation_id) === lead)).slice(0,300));
      const { proj } = projectReplicaInbox(s, { scope: "mine", now: Date.now() } as any);
      orig("full lead", JSON.stringify(proj.placements.get(lead)), "full row", JSON.stringify(proj.placements.get(id)));
      return;
    }
    if (!m) orig(...args);
  };
  H.installSim();
  const seed = 21;
  const server = new H.SimServer(H.seededWorld(seed));
  const a = await H.bootReplica(server, `A${seed}`, seed);
  const b = await H.bootReplica(server, `B${seed}`, seed + 100);
  const rng = H.makeRng(seed * 7);
  const replicas = [a, b];
  const eventNames = Object.keys(H.SERVER_EVENTS);
  for (let step = 0; step < 60; step++) {
    const roll = rng();
    const r = replicas[Math.floor(rng() * replicas.length)];
    const target = H.pickShown(r, rng);
    if (roll < 0.3) { const k = eventNames[Math.floor(rng() * eventNames.length)]; await H.SERVER_EVENTS[k](server, rng, step); }
    else if (roll < 0.4 && target) await r.pin(target);
    else if (roll < 0.45 && target) await r.kill(target);
    else if (roll < 0.5 && target) await r.stash(target);
    else if (roll < 0.55 && target) await r.revive(target);
    else if (roll < 0.6 && target) await r.setQueued(target, true);
    else if (roll < 0.63 && target) await r.focus(target);
    else if (roll < 0.7) r.online = !r.online;
    else if (roll < 0.78) await r.receiveBase();
    else if (roll < 0.86) await r.receiveOverlay();
    else if (roll < 0.92) await r.catchUp();
    else if (roll < 0.96) await r.crawl();
    else H.advance([15_000, H.GEN_MIN, 5 * H.GEN_MIN, H.GEN_HOUR][Math.floor(rng() * 4)]);
    if (rng() < 0.5) H.advance(Math.floor(rng() * 20_000));
  }
  console.error = orig;
  H.uninstallSim();
}, 600_000);

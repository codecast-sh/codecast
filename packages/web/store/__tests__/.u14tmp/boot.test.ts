import { test } from "bun:test";
import * as H from "../inboxSimHarness";
import { getFunctionName } from "convex/server";
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
test("boot", async () => {
  H.installSim();
  const server = new H.SimServer(H.seededWorld(21));
  const by: Record<string, [number, number]> = {};
  const orig = server.backend.clientFor.bind(server.backend);
  (server.backend as any).clientFor = (p: any) => {
    const c = orig(p);
    const wrap = (k: "query" | "mutation" | "action") => async (ref: any, args: any) => {
      const t = cpu();
      try { return await c[k](ref, args); } finally { const n = typeof ref === "string" ? ref : getFunctionName(ref); const e = (by[n] ??= [0, 0]); e[0] += cpu() - t; e[1]++; }
    };
    return { query: wrap("query"), mutation: wrap("mutation"), action: wrap("action") };
  };
  await H.bootReplica(server, "warm", 1);
  for (const k of Object.keys(by)) delete by[k];
  const N = 10;
  const phases: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    const r = new H.Replica(`R${i}`, server, { seed: i });
    let c = cpu(); await r.ready(); phases.ready = (phases.ready ?? 0) + cpu() - c;
    c = cpu(); await r.crawl(); phases.crawl = (phases.crawl ?? 0) + cpu() - c;
    c = cpu(); await r.receiveBase(); phases.base = (phases.base ?? 0) + cpu() - c;
    c = cpu(); await r.receiveOverlay(); phases.overlay = (phases.overlay ?? 0) + cpu() - c;
    c = cpu(); await r.receiveDecisions(); phases.decisions = (phases.decisions ?? 0) + cpu() - c;
    c = cpu(); await r.catchUp(); phases.catchUp = (phases.catchUp ?? 0) + cpu() - c;
  }
  console.log("phases per boot", JSON.stringify(Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, +(v / N).toFixed(2)]))));
  console.log("server per boot", JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, `${(v[0] / N).toFixed(2)}ms x${v[1] / N}`]))));
  H.uninstallSim();
}, 600_000);

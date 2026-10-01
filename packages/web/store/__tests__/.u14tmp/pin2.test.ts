import { test } from "bun:test";
import * as H from "../inboxSimHarness";
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
test("pin2", async () => {
  H.installSim();
  const server = new H.SimServer(H.seededWorld(21));
  const by: Record<string, number> = {};
  const orig = server.backend.clientFor.bind(server.backend);
  (server.backend as any).clientFor = (p: any) => {
    const c = orig(p);
    const wrap = (k: "query" | "mutation" | "action") => async (ref: any, args: any) => {
      const t = cpu();
      try { return await c[k](ref, args); } finally { const n = typeof ref === "string" ? ref : require("convex/server").getFunctionName(ref); by[n] = (by[n] ?? 0) + cpu() - t; }
    };
    return { query: wrap("query"), mutation: wrap("mutation"), action: wrap("action") };
  };
  const a = await H.bootReplica(server, "A", 21);
  const ids = a.visibleIds();
  for (const k of Object.keys(by)) delete by[k];
  let c = cpu();
  for (let i = 0; i < 60; i++) await a.pin(ids[i % ids.length]);
  const total = cpu() - c;
  console.log(`pin ${(total / 60).toFixed(2)}ms each; server ${JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +(v / 60).toFixed(2)])))}`);
  // client-only: the action without dispatch
  c = cpu();
  for (let i = 0; i < 60; i++) await a.window.run(() => {});
  console.log(`empty turn ${((cpu() - c) / 60).toFixed(2)}ms`);
  c = cpu();
  for (let i = 0; i < 60; i++) await a.focus(ids[i % ids.length]);
  console.log(`focus ${((cpu() - c) / 60).toFixed(2)}ms`);
  c = cpu();
  for (let i = 0; i < 60; i++) await server.flush();
  console.log(`flush ${((cpu() - c) / 60).toFixed(2)}ms`);
  H.uninstallSim();
}, 600_000);

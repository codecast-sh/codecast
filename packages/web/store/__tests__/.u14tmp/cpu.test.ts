import { test } from "bun:test";
import { profile } from "bun:jsc";
const which = process.env.WHICH ?? "post";
const H: any = which === "pre" ? await import("./preHarness") : await import("../inboxSimHarness");
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
test("cpu", async () => {
 const prof: any = await profile(async () => {
  const totals: Record<string, number> = {};
  const serverT: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const add = (k: string, v: number) => { totals[k] = (totals[k] ?? 0) + v; counts[k] = (counts[k] ?? 0) + 1; };
  const seeds = (process.env.SEEDS ?? "21,22,23").split(",").map(Number);
  for (const seed of seeds) {
    H.installSim();
    let c = cpu();
    const server = new H.SimServer(H.seededWorld(seed));
    if (which === "post") {
      const orig = server.backend.clientFor.bind(server.backend);
      const { getFunctionName } = require("convex/server");
      (server.backend as any).clientFor = (p: any) => {
        const cl = orig(p);
        const wrap = (k: "query" | "mutation" | "action") => async (ref: any, args: any) => {
          const t = cpu();
          try { return await cl[k](ref, args); } finally { const n = "srv:" + (typeof ref === "string" ? ref : getFunctionName(ref)); serverT[n] = (serverT[n] ?? 0) + cpu() - t; }
        };
        return { query: wrap("query"), mutation: wrap("mutation"), action: wrap("action") };
      };
    }
    const a = await H.bootReplica(server, `A${seed}`, seed);
    const b = await H.bootReplica(server, `B${seed}`, seed + 100);
    add("boot", cpu() - c);
    const rng = H.makeRng(seed * 7);
    const replicas = [a, b];
    const eventNames = Object.keys(H.SERVER_EVENTS);
    for (let step = 0; step < 60; step++) {
      const roll = rng();
      const r = replicas[Math.floor(rng() * replicas.length)];
      c = cpu();
      const target = H.pickShown(r, rng);
      add("pickShown", cpu() - c);
      c = cpu();
      let kind = "";
      if (roll < 0.3) { kind = "ev:" + eventNames[Math.floor(rng() * eventNames.length)]; await H.SERVER_EVENTS[kind.slice(3)](server, rng, step); }
      else if (roll < 0.4 && target) { kind = "pin"; await r.pin(target); }
      else if (roll < 0.45 && target) { kind = "kill"; await r.kill(target); }
      else if (roll < 0.5 && target) { kind = "stash"; await r.stash(target); }
      else if (roll < 0.55 && target) { kind = "revive"; await r.revive(target); }
      else if (roll < 0.6 && target) { kind = "queued"; await r.setQueued(target, true); }
      else if (roll < 0.63 && target) { kind = "focus"; await r.focus(target); }
      else if (roll < 0.7) { kind = "online"; r.online = !r.online; }
      else if (roll < 0.78) { kind = "base"; await r.receiveBase(); }
      else if (roll < 0.86) { kind = "overlay"; await r.receiveOverlay(); }
      else if (roll < 0.92) { kind = "catchUp"; await r.catchUp(); }
      else if (roll < 0.96) { kind = "crawl"; await r.crawl(); }
      else { kind = "advance"; H.advance([15_000, H.GEN_MIN, 5 * H.GEN_MIN, H.GEN_HOUR][Math.floor(rng() * 4)]); }
      if (rng() < 0.5) H.advance(Math.floor(rng() * 20_000));
      add(kind, cpu() - c);
    }
    c = cpu();
    await H.settleAndAssertConverged(server, replicas);
    add("settle", cpu() - c);
  }
  H.uninstallSim();
  }, 100);
  require("fs").writeFileSync("/tmp/u14/prof/cpu.json", JSON.stringify(prof.stackTraces));
  const all = Object.values(totals).reduce((x, y) => x + y, 0);
  console.log(`${which} total ${all.toFixed(0)}ms`);
  console.log("server", Object.values(serverT).reduce((x, y) => x + y, 0).toFixed(0), JSON.stringify(Object.fromEntries(Object.entries(serverT).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, +v.toFixed(0)]))));
  console.log(Object.entries(totals).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v.toFixed(0)}/${counts[k]}`).join(" "));
}, 600_000);

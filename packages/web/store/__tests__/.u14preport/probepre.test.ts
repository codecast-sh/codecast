import { it, setDefaultTimeout } from "bun:test";
setDefaultTimeout(600_000);
import { _resetChildAuqProbeCacheForTests } from "@codecast/convex/convex/conversations";
import { GEN_HOUR, GEN_MIN, Replica, SERVER_EVENTS, SimServer, advance, bootReplica, installSim, makeRng, pickShown, seededWorld, settleAndAssertConverged, uninstallSim } from "./inboxSimHarness";

const cpuNs = () => { const u = process.cpuUsage(); return (u.user + u.system) * 1000; };
const T = new Map<string, number>();
const C = new Map<string, number>();
function wrap(proto: any, name: string, label: string) {
  const orig = proto[name];
  proto[name] = function (...a: any[]) {
    const t0 = cpuNs();
    const out = orig.apply(this, a);
    const done = () => { T.set(label, (T.get(label) ?? 0) + (cpuNs() - t0) / 1e6); C.set(label, (C.get(label) ?? 0) + 1); };
    if (out && typeof out.then === "function") return out.finally(done);
    done(); return out;
  };
}
for (const m of ["pin","kill","stash","revive","setQueued","focus","receiveBase","receiveOverlay","receiveDecisions","catchUp","crawl","visibleIds","tick","drainHeals","hydrate"]) wrap(Replica.prototype, m, `R.${m}`);
for (const m of ["flush","daemonReports","gc","other","mutate","insert","setAgent"]) wrap(SimServer.prototype, m, `S.${m}`);

it("probe", async () => {
  const seeds = (process.env.P_SEEDS ?? "21,22,23,24").split(",").map(Number);
  const calls = new Map<string, number>();
  const t0 = cpuNs();
  let settleMs = 0;
  for (const seed of seeds) {
    installSim(); _resetChildAuqProbeCacheForTests();
    const server = new SimServer(seededWorld(seed));
    const a = await bootReplica(server, `A${seed}`, seed);
    const b = await bootReplica(server, `B${seed}`, seed + 100);
    const rng = makeRng(seed * 7); const replicas = [a, b]; const eventNames = Object.keys(SERVER_EVENTS);
    for (let step = 0; step < 60; step++) {
      const roll = rng(); const r = replicas[Math.floor(rng() * replicas.length)]; const target = pickShown(r, rng);
      if (roll < 0.3) { const ev = eventNames[Math.floor(rng() * eventNames.length)]; const e0 = cpuNs(); await SERVER_EVENTS[ev](server, rng, step); T.set(`ev.${ev}`, (T.get(`ev.${ev}`) ?? 0) + (cpuNs() - e0) / 1e6); C.set(`ev.${ev}`, (C.get(`ev.${ev}`) ?? 0) + 1); }
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
      else advance([15_000, GEN_MIN, 5 * GEN_MIN, GEN_HOUR][Math.floor(rng() * 4)]);
      if (rng() < 0.5) advance(Math.floor(rng() * 20_000));
    }
    const s0 = cpuNs();
    await settleAndAssertConverged(server, replicas);
    settleMs += (cpuNs() - s0) / 1e6;
    uninstallSim();
  }
  console.log(`total ${((cpuNs() - t0) / 1e6).toFixed(0)}ms settle ${settleMs.toFixed(0)}ms`);
  console.log([...T].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k.padEnd(28)} ${v.toFixed(0).padStart(7)}ms x${C.get(k)}`).join("\n"));
  console.log([...calls].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${String(v).padStart(6)} ${k}`).join("\n"));
});

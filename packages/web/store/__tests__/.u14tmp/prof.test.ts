import { test } from "bun:test";
import { profile } from "bun:jsc";
const t0 = performance.now();
const H = await import("../inboxSimHarness");
const t1 = performance.now();
console.log(`import ${(t1 - t0).toFixed(0)}ms`);
test("prof", async () => {
  const real = performance.now.bind(performance);
  H.installSim();
  const clock = () => (globalThis as any).__realNow?.() ?? 0;
  const start = Bun.nanoseconds();
  const ms = () => ((Bun.nanoseconds() - start) / 1e6).toFixed(0);
  const server = new H.SimServer(H.seededWorld(21));
  const a = await H.bootReplica(server, "A21", 21);
  console.log(`boot A ${ms()}ms deliveries=${server.net.deliveries} calls=${server.backend.calls.length}`);
  const b = await H.bootReplica(server, "B21", 121);
  console.log(`boot B ${ms()}ms deliveries=${server.net.deliveries} calls=${server.backend.calls.length}`);
  const rng = H.makeRng(21 * 7);
  const replicas = [a, b];
  const eventNames = Object.keys(H.SERVER_EVENTS);
  const times: Record<string, number> = {};
  const res: any = await profile(async () => {
  for (let step = 0; step < 60; step++) {
    const roll = rng();
    const r = replicas[Math.floor(rng() * replicas.length)];
    const target = H.pickShown(r, rng);
    const t = Bun.nanoseconds();
    let kind = "";
    if (roll < 0.3) { kind = eventNames[Math.floor(rng() * eventNames.length)]; await H.SERVER_EVENTS[kind](server, rng, step); }
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
    times[kind] = (times[kind] ?? 0) + (Bun.nanoseconds() - t) / 1e6;
  }
  }, 500);
  require("fs").writeFileSync("/tmp/u14/prof/functions.txt", res.functions);
  require("fs").writeFileSync("/tmp/u14/prof/stacks.json", JSON.stringify(res.stackTraces));

  console.log(`steps ${ms()}ms deliveries=${server.net.deliveries} calls=${server.backend.calls.length}`);
  console.log(Object.entries(times).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(" "));
  const byName: Record<string, number> = {};
  for (const c of server.backend.calls) byName[c.name] = (byName[c.name] ?? 0) + 1;
  console.log(JSON.stringify(byName));
  await H.settleAndAssertConverged(server, replicas);
  console.log(`settle ${ms()}ms deliveries=${server.net.deliveries} calls=${server.backend.calls.length}`);
  H.uninstallSim();
}, 300_000);

import { test } from "bun:test";
import { profile } from "bun:jsc";
import * as H from "../inboxSimHarness";
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
test("pin", async () => {
  H.installSim();
  const server = new H.SimServer(H.seededWorld(21));
  let c = cpu();
  const a = await H.bootReplica(server, "A", 21);
  console.log(`boot ${(cpu() - c).toFixed(1)}ms`);
  const ids = a.visibleIds();
  c = cpu();
  const res: any = await profile(async () => {
    for (let i = 0; i < 60; i++) await a.pin(ids[i % ids.length]);
  }, 200);
  const tq: Record<string, number> = {};
  for (const [ch, q] of (server.net as any).queues) tq[ch] = q.length;
  console.log(JSON.stringify(tq));
  const { pendingTimers } = await import("../sim/realm");
  const pt = pendingTimers(); const by: Record<string, number> = {}; for (const t of pt) by[t] = (by[t] ?? 0) + 1; console.log(JSON.stringify(by));
  const { __changeFeedSimSlots } = await import("../../../hooks/useSyncChangeFeed");
  await a.window.run(() => { const g = __changeFeedSimSlots().get(); console.log("cf", JSON.stringify(g.applyTally), g.shadowApplied?.size, typeof g.flushTimer); });
  console.log(`pin ${((cpu() - c) / 60).toFixed(2)}ms each, calls=${server.backend.calls.length} deliveries=${server.net.deliveries}`);
  require("fs").writeFileSync("/tmp/u14/prof/pin.json", JSON.stringify(res.stackTraces));
  c = cpu();
  const res2: any = await profile(async () => {
    for (let i = 0; i < 10; i++) await H.bootReplica(server, `R${i}`, i);
  }, 200);
  console.log(`boot ${((cpu() - c) / 10).toFixed(2)}ms each`);
  require("fs").writeFileSync("/tmp/u14/prof/boot.json", JSON.stringify(res2.stackTraces));
  H.uninstallSim();
}, 600_000);

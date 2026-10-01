import { test, expect } from "bun:test";
import * as H from "../inboxSimHarness";
test("restore", async () => {
  H.installSim();
  const server = new H.SimServer(H.seededWorld(72));
  const A = await H.bootDevice(server, "A", 1, 1);
  const B = await H.bootDevice(server, "B", 2, 0);
  const live = new Set((await server.base()).sessions.map((s: any) => String(s._id)));
  const shown = [A, B].flatMap((d) => d.windows).map((w) => new Set(w.visibleIds()));
  const [q] = [...live].filter((id) => shown.every((s) => s.has(id)) && !server.conv(id).inbox_pinned_at).sort();
  const dump = (label: string) => {
    for (const w of [...A.windows, ...B.windows]) {
      const p = Object.entries(w.state.pending).filter(([k]) => k.includes(q));
      console.log(label, w.name, "shows", w.shows(q), JSON.stringify(p), "row", JSON.stringify(Object.fromEntries(Object.entries(w.state.sessions[q] ?? {}).filter(([k]) => /inbox_|pinned/.test(k)))));
    }
    console.log(label, "server", JSON.stringify(Object.fromEntries(Object.entries(server.conv(q)).filter(([k]) => /inbox_|pinned|status/.test(k)))));
  };
  await A.followers[0].kill(q);
  await A.drain();
  dump("after kill+drain");
  await B.host.receiveAll();
  await B.host.restore(q);
  dump("after B restore");
  H.advance(H.GEN_MIN);
  await A.host.receiveAll();
  await A.drain();
  dump("after A receiveAll");
  H.uninstallSim();
}, 600_000);

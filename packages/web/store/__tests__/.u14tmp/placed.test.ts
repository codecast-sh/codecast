import { test } from "bun:test";
const which = process.env.WHICH ?? "post";
const H: any = which === "pre" ? await import("./preHarness") : await import("../inboxSimHarness");
import { placeInboxRows, useInboxStore } from "../../inboxStore";
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
test("placed", async () => {
  H.installSim();
  const server = new H.SimServer(H.seededWorld(21));
  const a = await H.bootReplica(server, "A", 21);
  const b = await H.bootReplica(server, "B", 121);
  let c = cpu();
  for (let i = 0; i < 200; i++) (i % 2 ? a : b).visibleIds();
  console.log(`${which} alternating visibleIds ${((cpu() - c) / 200).toFixed(3)}ms`);
  c = cpu();
  for (let i = 0; i < 200; i++) a.visibleIds();
  console.log(`${which} same-window visibleIds ${((cpu() - c) / 200).toFixed(3)}ms`);
  const st = which === "pre" ? a.state : a.window.store.getState();
  console.log("sessions", Object.keys(st.sessions).length, "conversations", Object.keys(st.conversations ?? {}).length, "pending", Object.keys(st.pending).length);
  if (which === "post") {
    const { __inboxStoreSimSlots } = await import("../../inboxStore");
    c = cpu();
    for (let i = 0; i < 200; i++) { __inboxStoreSimSlots().resetMemos(); placeInboxRows(st as any, { scope: "mine", now: H.now() }); }
    console.log(`${which} raw placeInboxRows ${((cpu() - c) / 200).toFixed(3)}ms`);
  }
  H.uninstallSim();
}, 600_000);

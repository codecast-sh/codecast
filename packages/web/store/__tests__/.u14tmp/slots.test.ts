import { test } from "bun:test";
import * as H from "../inboxSimHarness";
import { saveSlots, restoreSlots, WINDOW_SLOTS } from "../sim/windowSlots";
import { __changeFeedSimSlots } from "../../../hooks/useSyncChangeFeed";
test("slots", async () => {
  H.installSim();
  const s = saveSlots();
  console.log(Object.keys(s), JSON.stringify(s).length);
  let t = Bun.nanoseconds();
  for (let i = 0; i < 2000; i++) restoreSlots(saveSlots());
  console.log(`save+restore ${(Bun.nanoseconds() - t) / 1e6 / 2000}ms each`);
  const cf = __changeFeedSimSlots();
  t = Bun.nanoseconds();
  for (let i = 0; i < 2000; i++) cf.set(cf.get());
  console.log(`changefeed ${(Bun.nanoseconds() - t) / 1e6 / 2000}ms each`);
  for (const [file] of Object.entries(s)) {
    t = Bun.nanoseconds();
    for (let i = 0; i < 2000; i++) { const x = saveSlots(); }
  }
  H.uninstallSim();
});

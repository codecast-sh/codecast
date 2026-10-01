import { it } from "bun:test";
import { SimServer, seededWorld, installSim, uninstallSim, bootReplica } from "../inboxSimHarness";
it("one boot", async () => { installSim(); const s = new SimServer(seededWorld(21)); await bootReplica(s, "A", 21); uninstallSim(); });

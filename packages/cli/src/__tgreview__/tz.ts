import { waitAddedLine, parkAfterBlocking, holdingBlockers, parkHeldLine } from "../taskGraphCommands.js";
import { listedBlockers, listedBlockerEntries } from "../listedReadiness.js";
import { parkingLine } from "@codecast/shared/tasks";

const now = Date.parse("2026-10-09T03:00:00Z");
const w: any = { id: "wmuzbybjykqr", kind: "time", at: Date.parse("2026-10-09T05:25:00Z"), state: "waiting", created_at: now };
const words = { now, repository: "codecast-sh/codecast" };  // what checkoutWords gives: no absolute
const pulse: any = { task: "ct-9", started: true };

console.log("TZ =", process.env.TZ, "| Intl:", Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log("--- cast task dep ct-9 --blocked-by 2h ---");
console.log("ok " + waitAddedLine("ct-9", { wait: w, met: false }, words));
console.log(parkAfterBlocking("sess", "ct-9", [w], pulse, words));
console.log("--- cast task start ct-9 (still blocked) ---");
const result = { open_blockers: [w] };
console.log(`Still blocked by: ${listedBlockers(result as any, words).join(", ")}. ${parkingLine(listedBlockerEntries(result as any), "ct-9", words)}`);

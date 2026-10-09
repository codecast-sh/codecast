import { taskGraphSections } from "/Users/codecast/work/codecast-mv-f80f7e69/packages/cli/src/taskGraphCommands.js";
import { prWords, waitMetCause, waitLine, formatTaskResume, parkingLine } from "@codecast/shared/tasks";
import { graphChange, graphChangeText } from "@codecast/shared/tasks";

const at = Date.UTC(2026, 9, 14, 9, 0);
const timeWait: any = { id: "wmuzbybjykqr", kind: "time", at, state: "met", created_at: at - 7200000, created_by: "u1", settled_at: at, note: "passed" };
const waiting: any = { id: "wabc1234", kind: "time", at: Date.now() + 7200000, state: "waiting", created_at: Date.now(), created_by: "u1" };
const prWait: any = { id: "wpr99", kind: "pr_merged", repository: "other/repo", pr_number: 42, state: "waiting", created_at: Date.now(), created_by: "u1" };

const words = prWords("codecast-sh/codecast");
console.log("--- cast task show / context Blocked by ---");
for (const s of taskGraphSections({ waits: [timeWait, waiting, prWait] }, { blocked_by: [] }, { ...words })) {
  console.log(s.label + ":"); for (const i of s.items) console.log("    " + i);
}
console.log("\n--- stored history text (server, absolute) ---");
console.log(waitLine(timeWait, { absolute: true }));
console.log(waitLine(waiting, { absolute: true }));
console.log("\n--- CLI history line rendering ---");
console.log(graphChangeText(graphChange({ field: "waits", old_value: "", new_value: waitLine(waiting, { absolute: true }) })!));
console.log(graphChangeText(graphChange({ field: "waits", old_value: waitLine(waiting, {absolute:true}), new_value: waitLine(timeWait, { absolute: true }) })!));
console.log("\n--- wake message cause ---");
console.log("ct-1 is unblocked: " + waitMetCause(timeWait, { absolute: true }) + ".");
console.log("\n--- parking line (no words forwarded) ---");
console.log(parkingLine([prWait, waiting], "ct-9"));
console.log("\n--- resume block ---");
console.log(formatTaskResume({ task: { short_id: "ct-9", title: "Build it", status: "in_progress", priority: "high" }, held: true, blockers: [prWait, waiting], progress: null, plan: null } as any, { nonce: "N", ...words }));

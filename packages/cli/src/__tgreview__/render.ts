import { taskGraphSections, offFrontierLines, holdingBlockers, parkHeldLine, waitAddedLine, noWaitRemovedLine, routeBlockerRef } from "../taskGraphCommands.js";
import { AGENT_WAIT_WORDS, formatTaskResume, parkingLine, blockerLabel, waitRefLine, notReadyLabel } from "@codecast/shared/tasks";

const now = Date.parse("2026-10-09T03:00:00Z");
const waits: any[] = [
  { id: "wmuzbybjykqr", kind: "time", at: Date.parse("2026-10-09T05:25:00Z"), state: "waiting", created_at: now },
  { id: "w1", kind: "pr_merged", repository: "codecast-sh/codecast", pr_number: 42, state: "waiting", created_at: now },
  { id: "w2", kind: "pr_checks_green", repository: "codecast-sh/codecast", pr_number: 51, state: "met", settled_at: now, note: "checks green", created_at: now },
  { id: "w3", kind: "decision", decision: "sd-412", state: "failed", note: "dismissed", settled_at: now, created_at: now },
];
const t: any = { short_id: "ct-58077", status: "in_progress", blocked_by: ["ct-58076"], waits };
const links: any = { blocked_by: [{ kind: "task", ref: "ct-58076", status: "open", title: "Build the API" }], blocks: [{ short_id: "ct-58080", title: "Review", status: "open" }] };

console.log("=== cast task show (person words, local clock) ===");
for (const s of taskGraphSections(t, links, { now, repository: "codecast-sh/codecast" })) {
  console.log(`  ${s.label}:`);
  for (const i of s.items) console.log(`    ${i}`);
}
console.log("\n=== cast task context (agent words, UTC absolute) ===");
const words = { ...AGENT_WAIT_WORDS, now, repository: "codecast-sh/codecast" };
for (const s of taskGraphSections(t, links, { ...words, inline: (x: string) => x })) {
  console.log(`${s.label}:`);
  for (const i of s.items) console.log(`  ${i}`);
}
const pulse: any = { task: "ct-58077", started: true };
console.log(parkHeldLine(pulse, "ct-58077", holdingBlockers(t, links), { ...words, underway: true }));

console.log("\n=== parkingLine, time wait only ===");
console.log(parkingLine([waits[0]], "ct-58077", { now, underway: false }));

console.log("\n=== waitAddedLine ===");
console.log(waitAddedLine("ct-58077", { wait: waits[0], met: false }, { now }));
console.log(waitAddedLine("ct-58077", { wait: waits[2], met: true }, { now, repository: "codecast-sh/codecast" }));

console.log("\n=== compaction block ===");
console.log(formatTaskResume({
  task: { short_id: "ct-58077", title: "Task graph readiness", status: "in_progress", priority: "high" },
  held: true,
  blockers: [{ kind: "task", ref: "ct-58076", status: "open", title: "Build the API" } as any, waits[0], waits[1]],
  progress: null,
  plan: { short_id: "pl-851", title: "Task graph", status: "active", done: 8, total: 12, next: { short_id: "ct-58080", title: "Review", priority: "medium" } },
} as any, { now, ...AGENT_WAIT_WORDS, repository: "codecast-sh/codecast", nonce: "NONCE" }));

console.log("\n=== offFrontierLines ===");
console.log(offFrontierLines({ status: "open", ephemeral: true, created_from_conversation: "x" } as any, "parent_active"));
console.log("\n=== errors ===");
for (const bad of ["42", "foo", "#0", "2026-10-08T09:00", "owner/repo", "#42:checkz"]) {
  try { routeBlockerRef(bad, { now }); console.log(`${bad} -> ok`); } catch (e: any) { console.log(`${bad} -> ${e.message}`); }
}
try { routeBlockerRef("foo", { now, removing: true }); } catch (e: any) { console.log(`remove foo -> ${e.message}`); }
console.log(noWaitRemovedLine("ct-58077", { kind: "wait_id", id: "wabc" }));

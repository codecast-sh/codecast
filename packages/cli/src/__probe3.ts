import { parseBlockerRef, notReadyLabel, failedWaitAdvice, waitRemoveRef } from "@codecast/shared/tasks";
import { routeBlockerRef } from "./taskGraphCommands.js";
const now = Date.now();
for (const s of ["2h", "ct-0", "#0", "sd-0", "tomorrow", "next week", "PR 42", "42", "ct-12x", "2026-10-14 09:00", "9am", "#42:cheks", "ct 12", ""]) {
  const r = parseBlockerRef(s, { now });
  console.log(JSON.stringify(s).padEnd(22), r.ok ? JSON.stringify(r) : "ERR: " + r.error);
}
console.log("\n-- routeBlockerRef errors --");
for (const s of ["tomorrow", "w123"]) {
  for (const removing of [false, true]) {
    try { console.log(removing ? "rm " : "add", JSON.stringify(s), "->", JSON.stringify(routeBlockerRef(s, { now, removing }))); }
    catch (e) { console.log(removing ? "rm " : "add", JSON.stringify(s), "-> ERR:", (e as Error).message); }
  }
}
console.log("\n-- 2h offset --", (parseBlockerRef("2h", { now }) as any).at - now);
console.log("\n-- notReadyLabel --");
const t: any = { short_id: "ct-9", status: "open", blocked_by: ["ct-5"], waits: [] };
for (const reason of ["blocked", "parent_working", "parent_unknown", "superseded", "triage", "status", "ephemeral", "stale"] as any[]) {
  try { console.log(reason.padEnd(16), notReadyLabel(t, { ready: false, reason } as any)); } catch (e) { console.log(reason, "ERR", (e as Error).message); }
}

// The note a template role hears when a bind changes something (orgTemplates.ts tellRoleOfBind).

import { routineState, type RoutineReadiness } from "@codecast/shared/contracts/orgTemplateReadiness";

export type RoutineRow = { id: string; title: string; every: string; mode: "propose" | "apply"; external: boolean; retired: boolean; trigger: { id: string; short_id?: string; status: string; run_at?: number; precheck?: string; interval_ms?: number; run_count?: number; last_run_at?: number; last_run_failed?: boolean } | null };

const listed = (words: string[]) => words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
/**
 * What a role hears, once, when its host step finishes or a secret is bound:
 * what is bound now, what is still missing, and where each routine stands.
 * Plain words, because it arrives in the standing session as a message.
 */
export function bindNote(o: { instance: string; machine?: string; becameReady: boolean; newlyBound: string[]; secrets: { key: string; label: string; bound: boolean; unlocks?: string[] }[]; routines: RoutineRow[]; readiness: Record<string, RoutineReadiness> }): string {
  const on = o.machine ? ` on ${o.machine}` : "";
  const fresh = o.secrets.filter((s) => o.newlyBound.includes(s.key));
  const missing = o.secrets.filter((s) => !s.bound);
  const lines: string[] = [];
  if (o.becameReady) lines.push(`The host step for ${o.instance} finished${on}: the template is installed, the instance file is written and your routines exist; each turns on as soon as it is ready.`);
  if (fresh.length) {
    const unlocks = [...new Set(fresh.flatMap((s) => s.unlocks ?? []))];
    lines.push(`${listed(fresh.map((s) => s.label))} ${fresh.length === 1 ? "is" : "are"} now bound for ${o.instance}${on}: the value is in a file there and its path is in the instance file.${unlocks.length ? ` ${listed(unlocks)} needed it.` : ""}`);
  }
  if (o.secrets.length) lines.push(missing.length ? `Still missing: ${listed(missing.map((s) => s.label))}.` : "Every secret this template asks for is bound.");
  const live = o.routines.filter((r) => !r.retired);
  if (live.length) {
    lines.push("Routines:");
    for (const r of live) {
      const needs = o.readiness[r.id]?.missing ?? [];
      lines.push(`- ${r.title}${r.trigger?.short_id ? ` (${r.trigger.short_id})` : ""}: ${routineState(r, o.readiness[r.id])}${needs.length ? `; ${needs.join("; ")}` : ""}`);
    }
  }
  return lines.join("\n");
}

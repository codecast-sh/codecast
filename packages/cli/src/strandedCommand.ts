// `cast task stranded`'s output, loaded only when the command runs so its
// formatting stays off index.ts's static graph (bench/bootGraph.guard.test.ts).
import { c, fmt } from "./colors.js";
import { formatAge } from "./decideCommand.js";
import type { StrandedList } from "@codecast/shared/contracts/strandedHandoff";

export { STRANDED_AFTER_DAYS } from "@codecast/shared/contracts/strandedHandoff";

export function strandedLines({ rows, capped_at }: StrandedList, days: number, now: number): string[] {
  // Past the cap only the least recently touched were judged: a newer handoff may be missing.
  const capped = capped_at ? [fmt.muted(`  Read only the ${capped_at} least recently touched of more than ${capped_at} tasks in review.`)] : [];
  if (!rows.length) return [fmt.muted(`No finished handoff in review is older than ${days}d without landing.`), ...capped];
  return [
    ...rows.flatMap((r) => {
      const where = [
        ...r.prs.map((p) => `${p.repository ?? ""}#${p.number} ${p.state ?? "unknown"}`),
        ...r.branches.map((b) => `branch ${b}`),
      ];
      return [
        `${c.cyan}${r.short_id}${c.reset} ${r.title}`,
        fmt.muted(`  handed off ${formatAge(now - r.handed_off_at)}${r.handed_off_by ? ` by ${r.handed_off_by}` : ""}${r.assignee ? ` · ${r.assignee}` : ""}${where.length ? ` · ${where.join(" · ")}` : ""}`),
      ];
    }),
    "",
    fmt.muted(`  ${rows.length} stranded handoff${rows.length === 1 ? "" : "s"}, handed off over ${days}d ago with nothing landed.`),
    fmt.muted("  Ship one: cast flow run change --task <id> · already on main: cast task done <id> · abandoned: cast task drop <id>"),
    ...capped,
  ];
}

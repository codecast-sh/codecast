// `cast org loose` (org-staffing.md S43): the person's sessions nothing places
// yet, as the Head of People's daily look reads them, and `--new`, the quiet
// gate that look runs behind: exit 0 only when one started since it last ran.

import { FILE_SESSION_EXAMPLE, FILE_SESSION_SHAPE } from "@codecast/shared/contracts/orgSessionFiling";
import { formatRelative } from "@codecast/shared/time";
import { fmt } from "./colors.js";
import type { OrgInitDeps } from "./orgInit.js";

export type LooseAnswer = { count: number; rows: Array<{ short_id: string; title: string; state: string; last_active_at: number; project_path: string | null }>; last_look_at: number | null; new: string[] };

/** The gate's exit code and its one line: 0 runs the look, 1 skips it. */
export function looseGate(a: LooseAnswer | null): { code: 0 | 1; line: string } {
  if (!a) return { code: 1, line: "no org here to look at" };
  return a.new.length ? { code: 0, line: `${a.new.length} new loose session${a.new.length === 1 ? "" : "s"}` } : { code: 1, line: "no new loose session since the last look" };
}

export async function showLoose(deps: OrgInitDeps, options: { team?: string; new?: boolean; json?: boolean }): Promise<void> {
  const ws = await deps.readWorkspace(options.team);
  const a: LooseAnswer | null = await deps.cliPost("/cli/org/loose", deps.workspaceArgs(ws));
  if (options.new) {
    const gate = looseGate(a);
    console.log(gate.line);
    process.exitCode = gate.code;
    return;
  }
  if (!a) { console.error(`You are not a member of ${deps.workspaceLabel(ws)}, or its org is off.`); process.exitCode = 1; return; }
  if (options.json) { console.log(JSON.stringify(a, null, 2)); return; }
  console.log(looseLines(a, Date.now()).join("\n"));
}

/** What `cast org loose` prints: the count, each session with the new ones marked, and how a filing is written. */
export function looseLines(a: LooseAnswer, now: number): string[] {
  const fresh = new Set(a.new);
  return [
    `${a.count} loose session${a.count === 1 ? "" : "s"}${a.count > a.rows.length ? ` (newest ${a.rows.length} shown)` : ""}${a.last_look_at ? fmt.muted(` · last look ${formatRelative(a.last_look_at, now)}`) : ""}`,
    ...a.rows.map((r) => `  ${fresh.has(r.short_id) ? fmt.highlight("new") : "   "} ${r.short_id} ${r.title} ${fmt.muted(`· ${r.state} · ${formatRelative(r.last_active_at, now)}${r.project_path ? ` · ${r.project_path}` : ""}`)}`),
    fmt.muted(`\nFiling one is a proposal change (cast org propose, or cast org revise op-N --add on an open proposal of yours; cast org proposals lists them): ${FILE_SESSION_SHAPE}. One change in a spec reads:`),
    fmt.muted(`  ${FILE_SESSION_EXAMPLE}`),
  ];
}

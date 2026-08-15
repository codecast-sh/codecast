/**
 * `cast browser audit` — where this session's browsing has been.
 *
 * Registered by every driver path (built-in CDP, engine): it reads only the
 * on-disk trail, so it works with the browser stopped and does not care which
 * engine wrote the rows.
 */

import type { Command } from "commander";
import { auditPath, readAudit } from "./audit.js";
import { describeSources, loadSitePolicy } from "./policy.js";
import { fmt, icons } from "../colors.js";

/** Tab column: a CDP target id is shortened; an engine session reads as "engine". */
function tabLabel(tab: string): string {
  if (tab === "-") return "";
  if (tab.startsWith("engine:")) return " · engine";
  return ` · tab ${tab.slice(0, 8)}`;
}

export function registerAuditCommand(br: Command, me: () => string | null): void {
  br.command("audit")
    .description("Origins this session's browsing has landed on (always recorded)")
    .option("--all", "Every session on this machine, not just this one")
    .option("-n <count>", "How many rows", "40")
    .action(async (o: { all?: boolean; n: string }) => {
      const session = me();
      const rows = o.all ? readAudit() : readAudit().filter((r) => r.session === session);
      const policy = loadSitePolicy();
      if (policy) {
        console.log(fmt.muted(`policy: ${describeSources(policy)}`));
      }
      if (!rows.length) {
        console.log(fmt.muted(o.all ? "(no browsing recorded on this machine)" : "(nothing recorded for this session — --all shows every session)"));
        return;
      }
      const n = parseInt(o.n, 10);
      for (const r of rows.slice(-n)) {
        const d = new Date(r.t);
        const pad = (x: number) => String(x).padStart(2, "0");
        const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const mark = r.blocked ? fmt.error(icons.cross) : " ";
        const who = o.all ? ` ${fmt.muted((r.session ?? "shell").replace(/^(session|env|pane):/, "").slice(0, 10).padEnd(10))}` : "";
        const how = `${r.via}${tabLabel(r.tab)}${r.blocked ? " · blocked" : ""}`;
        console.log(`${fmt.muted(stamp)} ${mark}${who} ${r.origin.padEnd(38)} ${fmt.muted(how)}`);
      }
      if (rows.length > n) console.log(fmt.muted(`  … ${rows.length - n} earlier (-n ${rows.length} for everything)`));
      const blocked = rows.filter((r) => r.blocked).length;
      console.log(fmt.muted(`\n${rows.length} visit(s)${blocked ? `, ${blocked} blocked/off-policy` : ""} · ${auditPath()}`));
    });
}

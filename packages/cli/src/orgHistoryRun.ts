import { orgLogEntryLine, type OrgLogEntry } from "@codecast/shared/contracts/orgChange";
import { groupOrgLogByDay, orgLogClock, orgLogDoorWords } from "@codecast/shared/contracts/orgLog";
import { orgEveryToMs } from "@codecast/shared/contracts/orgProposal";
import type { OrgInitDeps } from "./orgInit.js";

type OrgLogArgs = { team_id?: string; role?: string; since?: number; limit: number };
type OrgLogResult = { entries: OrgLogEntry[]; has_more: boolean } | null;

async function readOrgLog(args: OrgLogArgs): Promise<OrgLogResult> {
  const { convexClient } = await import("./remote/convexClient.js");
  const { client, token, api } = await convexClient();
  return client.query(api.orgChanges.list, { api_token: token, ...args });
}

export async function showOrgLog(
  deps: OrgInitDeps,
  options: { team?: string; role?: string; since?: string; json?: boolean },
  query: (args: OrgLogArgs) => Promise<OrgLogResult> = readOrgLog,
): Promise<void> {
  const now = Date.now();
  const duration = options.since === undefined ? undefined : orgEveryToMs(options.since);
  if (duration === null || duration !== undefined && !Number.isFinite(duration)) {
    console.error("--since needs a positive duration such as 7d, 12h, 30m, or 2w.");
    process.exit(1);
  }
  const ws = await deps.readWorkspace(options.team);
  const result = await query({
    ...deps.workspaceArgs(ws),
    ...(options.role ? { role: options.role } : {}),
    ...(duration === undefined ? {} : { since: now - duration }),
    limit: 100,
  });
  if (!result) {
    console.error(`You are not a member of ${deps.workspaceLabel(ws)}.`);
    process.exit(1);
  }
  if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
  if (!result.entries.length) { console.log("No org changes match these filters."); return; }
  for (const group of groupOrgLogByDay(result.entries, now)) {
    console.log(group.label);
    for (const entry of group.entries) {
      console.log(`  ${orgLogEntryLine(entry)}`);
      console.log(`    ${entry.actor.name} · ${orgLogClock(entry.at)} · ${orgLogDoorWords(entry)}`);
      if (entry.undone_by) console.log(`    Taken back by ${entry.undone_by.name}, ${orgLogClock(entry.undone_by.at)}`);
    }
  }
  if (result.has_more) console.log("Showing the latest 100 changes. Narrow with --role or --since.");
}

export function refuseOrgUndo(deps: Pick<OrgInitDeps, "webUrl">): never {
  console.error(`Undo and redo are for a person in the browser. Sessions cannot undo org changes. Open History on the org page to review what will change: ${deps.webUrl().replace(/\/$/, "")}/org`);
  process.exit(1);
}

// `cast team focus "<words>"`: who decides for which areas, set in plain
// words (convex/decisionAreas.ts). The server maps the words onto the team's
// members and projects with one model call and applies the map; --dry-run
// shows the map and changes nothing. With no words it shows the areas as
// they stand.
import { fmt } from "./colors.js";

export type FocusResult = {
  assignments: Array<{ user_id: string; name: string; takes_decisions: boolean; projects: Array<{ id: string; title: string }> }>;
  unplaced: string[];
  text: string;
  applied?: number;
  current?: boolean;
};

/** The map as lines: each member and the projects they decide for, then what the words named that matched nothing. */
export function formatFocus(r: FocusResult, opts: { dryRun?: boolean; team: string }): string {
  const width = Math.max(8, ...r.assignments.map((a) => a.name.length)) + 2;
  const lines = [`\n${fmt.highlight(r.current ? `Areas in ${opts.team}` : opts.dryRun ? `Areas in ${opts.team} (not applied)` : `Areas in ${opts.team}, applied`)}\n`];
  for (const a of r.assignments) {
    const areas = a.projects.length ? a.projects.map((p) => p.title).join(", ") : fmt.muted("no areas");
    lines.push(`  ${a.name.padEnd(width)}${areas}${a.takes_decisions ? "" : fmt.muted("  (takes no decisions)")}`);
  }
  if (r.unplaced.length) lines.push(`\n${fmt.muted("Matched no project:")} ${r.unplaced.join(", ")}`);
  if (r.current) lines.push(`\n${fmt.muted("Change them:")} cast team focus "Name: area, area; Name: area"`);
  else if (opts.dryRun) lines.push(`\n${fmt.muted("Nothing changed. Run it without --dry-run to apply.")}`);
  else lines.push(`\n${fmt.muted("New decisions about these projects go to whoever covers them, fewest open first.")}`);
  return lines.join("\n");
}

export async function runTeamFocus<W extends { kind: string; teamId?: string }>(
  post: (route: string, body: Record<string, unknown>) => Promise<any>,
  ws: W,
  label: (ws: W) => string,
  words: string | undefined,
  dryRun: boolean,
): Promise<void> {
  if (ws.kind !== "team" || !ws.teamId) {
    console.error('Areas are a team\'s. Name the team: cast team focus "<words>" <team>');
    process.exit(1);
  }
  const result: FocusResult = await post("/cli/team/focus", { team_id: ws.teamId, ...(words?.trim() ? { words } : {}), ...(dryRun ? { dry_run: true } : {}) });
  console.log(formatFocus(result, { dryRun, team: label(ws) }));
}

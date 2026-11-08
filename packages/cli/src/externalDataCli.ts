// What `cast sources`, `cast events`, `cast replay`, `cast metrics` and
// `cast connector` share (docs/architecture/external-data.md X10): the scope
// a read or write goes to, how a verb prints (text, or --json for agents),
// and how a source is named in a line. Each command module holds only its own
// verbs.
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { formatAge, formatSpan } from "./decideCommand.js";
import { scopeFor } from "./lineScope.js";
import { notFoundLine } from "./argChecks.js";
import { elsewhereHint, loadWorkspaceRoster, otherWorkspacesWith, workspaceScope, type Workspace } from "./resolveWorkspace.js";

export { formatAge, formatSpan };

export function fail(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

/** Every verb prints for a person, or the server's answer whole under --json. */
export function emit(json: boolean | undefined, data: unknown, text: () => string): void {
  console.log(json ? JSON.stringify(data, null, 2) : text());
}

/** POST a read with the workspace scope folded in: --team, else the repo profile's, else the session's (signalCommand.scopeFor). */
export async function scopedRead(deps: PublishDeps, path: string, body: Record<string, unknown>, team?: string): Promise<any> {
  const scope = await scopeFor(deps, team, false);
  return await postOrFail(deps, path, { ...body, ...scope }, { read: true, scope });
}

/** POST a write with the workspace scope folded in. */
export async function scopedWrite(deps: PublishDeps, path: string, body: Record<string, unknown>, team?: string): Promise<any> {
  const scope = await scopeFor(deps, team, true);
  return await postOrFail(deps, path, { ...body, ...scope }, { scope });
}

/**
 * apiPost that exits on a refusal with the refusal and its next step: a
 * "not found" names the command that lists the valid ids, and a source that
 * is not found lists the workspace's sources by name.
 */
export async function postOrFail(
  deps: PublishDeps,
  path: string,
  body: Record<string, unknown>,
  opts: { read?: boolean; scope?: Record<string, unknown> } = {},
): Promise<any> {
  try {
    return await apiPost(deps, path, body, { read: opts.read, exitOnError: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(await explainRefusal(deps, message, opts.scope));
  }
}

/** eg-12 for a bare 12: a short id typed without its prefix. */
export function shortRef(prefix: "eg" | "mw" | "rp", ref: string): string {
  const t = ref.trim();
  return /^\d+$/.test(t) ? `${prefix}-${t}` : t;
}

/** The command that lists the ids each kind of "not found" refusal names. */
const LISTERS: [RegExp, string][] = [
  [/^Group /, "cast events groups"],
  [/^Metric watch /, "cast metrics ls"],
  [/^Replay /, "cast replay ls"],
  [/^Source /, "cast sources ls"],
];

/** A "not found" refusal ("Group eg-9 not found.") as the CLI's one not-found line, with the
 *  command that lists what exists; any other refusal as it came. */
export function describeLookupError(error: string): string {
  const hit = LISTERS.find(([re]) => re.test(error));
  const parts = /^(.+?) (\S+) not found\.?$/.exec(error);
  return hit && parts ? notFoundLine(parts[1]!.toLowerCase(), parts[2]!, hit[1]) : error;
}

async function explainRefusal(deps: PublishDeps, message: string, scope: Record<string, unknown> | undefined): Promise<string> {
  if (!/^Source .*not found/.test(message)) return describeLookupError(message);
  const elsewhere = await sourceElsewhere(deps, /^Source (.+?) not found/.exec(message)?.[1] ?? "", scope);
  if (elsewhere) return `${message}. ${elsewhere}.`;
  const rows: { name: string; provider: string }[] | null = await apiPost(deps, "/cli/sources/list", { ...(scope ?? {}) }, { read: true, exitOnError: false }).catch(() => null);
  if (!rows?.length) return `${message}. This workspace has no sources yet: cast sources add <provider> <name>.`;
  return `${message}. Sources in this workspace: ${rows.map((s) => `${s.name} (${s.provider})`).join(", ")}.`;
}

/** Where a source this workspace lacks lives among the caller's other
 *  workspaces, as the hint to rerun with; null when nowhere. Without --team
 *  the server chose the workspace, so every one is probed: the one that
 *  missed cannot match. */
async function sourceElsewhere(deps: PublishDeps, ref: string, scope: Record<string, unknown> | undefined): Promise<string | null> {
  if (!ref) return null;
  const list = (body: Record<string, unknown>) => apiPost(deps, "/cli/sources/list", body, { read: true, exitOnError: false });
  const roster = await loadWorkspaceRoster(() => apiPost(deps, "/cli/teams", {}, { read: true, exitOnError: false })).catch(() => null);
  if (!roster) return null;
  const { normalizeSourceName } = await import("@codecast/shared/contracts/ingest");
  const current: Workspace = scope?.workspace === "personal" ? { kind: "personal" } : { kind: "team", teamId: String(scope?.team_id ?? "") };
  const name = normalizeSourceName(ref);
  const hits = await otherWorkspacesWith(roster, current, async (ws) =>
    ((await list(workspaceScope(ws))) as { name: string; short_id?: string }[]).some((s) => s.short_id === ref || normalizeSourceName(s.name) === name));
  return elsewhereHint(`Source ${ref}`, hits);
}

/** "a, b , c" as a list, blanks dropped. */
export function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/** commander's property name for a flag: --base-url arrives as baseUrl. */
export const optionKey = (flag: string) => flag.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());

/** Collects a repeatable option (`--arg a=1 --arg b=2`). */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export const TEAM_OPTION = ["--team <name|id|personal>", "Workspace to use (default: the repo profile's [line] team, else the session's team, else the directory's mapping)"] as const;
export const JSON_OPTION = ["--json", "Machine-readable output"] as const;

const SPARK = "▁▂▃▄▅▆▇█";

/** Hourly counts as one row of block glyphs, scaled to the largest. */
export function sparkline(counts: readonly number[]): string {
  const max = Math.max(0, ...counts);
  if (max === 0) return "";
  return counts.map((n) => SPARK[Math.min(SPARK.length - 1, Math.floor((n / max) * (SPARK.length - 1)))]).join("");
}

export function ago(at: number | null | undefined, now: number = Date.now()): string {
  return at ? formatAge(now - at) : "never";
}

/** A time ahead, "in 10d". */
export function until(at: number, now: number = Date.now()): string {
  return `in ${formatSpan(at - now, Math.round)}`;
}

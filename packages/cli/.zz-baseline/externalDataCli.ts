// What `cast sources`, `cast events`, `cast replay`, `cast metrics` and
// `cast connector` share (docs/architecture/external-data.md X10): the scope
// a read or write goes to, how a verb prints (text, or --json for agents),
// and how a source is named in a line. Each command module holds only its own
// verbs.
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { formatAge } from "./decideCommand.js";
import { scopeFor } from "./signalCommand.js";

export { formatAge };

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
  return await apiPost(deps, path, { ...body, ...(await scopeFor(deps, team, false)) }, { read: true });
}

/** POST a write with the workspace scope folded in. */
export async function scopedWrite(deps: PublishDeps, path: string, body: Record<string, unknown>, team?: string): Promise<any> {
  return await apiPost(deps, path, { ...body, ...(await scopeFor(deps, team, true)) });
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

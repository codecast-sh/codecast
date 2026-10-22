/**
 * What a rehearsal of one session's move found, on the machine that holds the
 * session's files (cast migrate rehearse): whether the transfer would land,
 * and what the session uses that the destination lacks. Blockers stop the
 * move while the session still runs where it is; the rest is what a person
 * confirms or chooses to bring along.
 *
 * PURE isomorphic data: the CLI writes it, Convex stores it, the web reads it.
 */
export type MoveRehearsalPath = {
  /** Absolute path on the source machine. */
  path: string;
  kind: "repo" | "folder";
  /** Size of what would cross (a repository's tracked and untracked files, not what git ignores). */
  bytes?: number;
  /** Files the session wrote there; uses are reads and shell mentions. */
  writes: number;
  uses: number;
};

export type MoveRehearsal = {
  session_id: string;
  destination_id: string;
  at: number;
  /** The move would fail now; nothing is stopped or sent. */
  blockers: string[];
  /** How the session's own checkout crosses. */
  transfer: { method: "git" | "files"; bytes?: number; note?: string };
  /** Repositories and folders the session works in that the destination lacks; a move can bring them. */
  missing: MoveRehearsalPath[];
  /** Launchd services from the session's work that keep running on the source. */
  services: Array<{ label: string; running: boolean }>;
  /** Commands the session ran that the destination lacks, and which of those the move installs. */
  tools: { missing: string[]; installs: string[] };
  /** Differences in the machines themselves, one short line each ("macOS 26.2 → 15.7"). */
  machine: string[];
};

/** A move's extra paths, as a batch row carries them. */
export const MAX_BRING_PATHS = 20;

/** Why a list of paths to bring is refused, or null: absolute, no `..`, a bounded number. */
export function invalidBringPaths(paths: readonly string[] | undefined): string | null {
  if (!paths?.length) return null;
  if (paths.length > MAX_BRING_PATHS) return `At most ${MAX_BRING_PATHS} paths to bring`;
  const bad = paths.find((p) => !p.startsWith("/") || p.length > 500 || p.split("/").includes(".."));
  return bad ? `Paths to bring must be absolute: ${bad.slice(0, 80)}` : null;
}

/** Paths a move brings by default: ones the session wrote to, or leaned on heavily. */
export function bringsByDefault(p: MoveRehearsalPath): boolean {
  return p.writes > 0 || p.uses >= 20;
}

/**
 * What a person accepts by moving the session as rehearsed, one line each:
 * the paths it leaves behind, services that keep running on the source,
 * commands the host lacks and will not get, and machine differences. The web
 * shows them on the session and the server requires them confirmed
 * (resourceOffload.start), so both build them here.
 */
export function rehearsalPending(r: MoveRehearsal, bring: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const m of r.missing) if (!bring.includes(m.path)) out.push(`Leaves behind ${m.path}`);
  for (const s of r.services) if (s.running) out.push(`Keeps running here: ${s.label}`);
  const absent = r.tools.missing.filter((t) => !r.tools.installs.includes(t));
  if (absent.length) out.push(`Host lacks ${absent.join(", ")}`);
  out.push(...r.machine);
  return out;
}

/** A rehearsal speaks for this long; after that the runner's own rehearsal before the move is the check. */
export const REHEARSAL_TTL_MS = 15 * 60_000;

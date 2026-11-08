// The heap a tsc watcher runs with, and how a watcher that died of a full heap
// says so. Pure; check.ts spawns the watcher and reads its log.
import * as os from "node:os";

/**
 * A big program needs more heap than node's default. A watch pass holds the
 * old program beside the new one, so it needs well over a full pass: web's
 * full pass reached ~4.1 GB and its incremental passes aborted at 6 GB
 * (2026-11-05). The cap only bites when tsc would otherwise crash.
 */
export const TSC_HEAP_MB = 8192;
/**
 * Carries an asker's larger heap cap to the watcher: a launchd job keeps only
 * CAST_* and a few other variables (launchdJob.ts), never NODE_OPTIONS.
 */
export const CHECK_HEAP_ENV = "CAST_CHECK_HEAP_MB";
const HEAP_FLAG = /^--max[-_]old[-_]space[-_]size=(\d+)$/;

/** The heap cap, in MB, a NODE_OPTIONS string sets; undefined when it sets none. */
export function heapCapMb(nodeOptions: string | undefined): number | undefined {
  let cap: number | undefined;
  for (const tok of (nodeOptions ?? "").split(/\s+/)) {
    const n = Number(tok.match(HEAP_FLAG)?.[1]);
    if (n > 0) cap = n;
  }
  return cap;
}

/**
 * NODE_OPTIONS for tsc: the caller's own flags, with a heap cap no lower than
 * TSC_HEAP_MB. An agent's `NODE_OPTIONS=--max-old-space-size=7168` once
 * replaced the default outright and lowered the cap the program needs.
 */
export function tscNodeOptions(inherited: string | undefined, extraMb?: string | number): string {
  const cap = Math.max(TSC_HEAP_MB, heapCapMb(inherited) ?? 0, Number(extraMb) || 0);
  const rest = (inherited ?? "").split(/\s+/).filter((t) => t && !HEAP_FLAG.test(t));
  return [...rest, `--max-old-space-size=${cap}`].join(" ");
}

/** A line of a native stack trace (`55: 0x1039d4ef0 Builtins_...`), which V8 prints after a fatal error. */
export const isNativeFrame = (line: string): boolean => /^\s*\d+: 0x[0-9a-f]+ /.test(line);
/** V8's own line for a heap exhaustion: `FATAL ERROR: ... JavaScript heap out of memory`. */
export const isHeapFatal = (line: string): boolean => /heap out of memory|heap limit|FATAL ERROR: .*Allocation failed/i.test(line);

/**
 * The line a watcher ends its log with when tsc died of a full heap, or
 * undefined when it died some other way. An asker reads it as the reason.
 */
export function heapDeath(opts: { project: string; signal: string | null; fatal: string | null; nodeOptions: string; totalBytes?: number }): string | undefined {
  if (!opts.fatal || (opts.signal && opts.signal !== "SIGABRT" && opts.signal !== "SIGTRAP")) return undefined;
  const capMb = heapCapMb(opts.nodeOptions) ?? TSC_HEAP_MB;
  const gb = (mb: number): string => String(Math.round((mb / 1024) * 10) / 10);
  const total = Math.round(((opts.totalBytes ?? os.totalmem()) / 2 ** 30) * 10) / 10;
  return `tsc ran out of memory on ${opts.project} at its ${gb(capMb)} GB heap cap (${opts.fatal.trim()}). ` +
    `Asking again starts a new watcher from the last finished pass; if it hits the cap again, raise it for this project: ` +
    `NODE_OPTIONS=--max-old-space-size=${capMb + 4096} cast check --fresh ${opts.project} (this machine has ${total} GB)`;
}

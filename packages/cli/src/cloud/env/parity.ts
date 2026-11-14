/**
 * The parity ledger behind `cast cloud`: every piece of this laptop's
 * environment the inventory found, and what happened to it on the cloud
 * machine.
 *
 * An item enters the ledger once, when the inventory finds it, either planned
 * (something is meant to carry or install it) or already skipped with the
 * reason it cannot go. Every later step settles planned items by key. When the
 * run ends, `finish` turns any item still planned into a failure, so an item
 * no step reported on shows up as a failure in the report instead of
 * vanishing. Skipped and failed items must carry a reason; the ledger throws
 * when one does not.
 */

export type ParityArea = "repo" | "files" | "folder" | "tool" | "mcp" | "config" | "login" | "env" | "service" | "machine";

/** carried: copied over. installed: the host got its own copy. present: already there and verified. */
export type ParityStatus = "planned" | "carried" | "installed" | "present" | "skipped" | "failed";

export interface ParityItem {
  key: string;
  area: ParityArea;
  /** What a person recognises: a repo path, a tool, a file. */
  name: string;
  /** Size, version, counts. */
  detail?: string;
  status: ParityStatus;
  /** Why it was skipped or failed. Required for both. */
  reason?: string;
  /** What closes the gap: a command or a change to make. */
  fix?: string;
  /** Every path an item stands for, when it groups several (a repo's left-behind files). */
  paths?: string[];
}

export interface ParityReport {
  version: 1;
  created_at: string;
  /** This laptop, by host name. */
  laptop: string;
  /** Where the environment went, or "dry run". */
  target: string;
  dry_run: boolean;
  /** What the inventory read, so a reader knows the report's bounds. */
  scope: string[];
  items: ParityItem[];
  counts: Record<ParityStatus, number>;
}

const AREA_ORDER: ParityArea[] = ["repo", "files", "folder", "config", "login", "env", "tool", "mcp", "service", "machine"];

export const AREA_TITLES: Record<ParityArea, string> = {
  repo: "Repositories",
  files: "Files inside repositories",
  folder: "Folders",
  config: "Agent config",
  login: "Logins",
  env: "Shell environment",
  tool: "Tools",
  mcp: "MCP servers",
  service: "Services",
  machine: "Machine",
};

export const parityKey = (area: ParityArea, name: string) => `${area}:${name}`;

export class ParityLedger {
  private readonly items = new Map<string, ParityItem>();
  readonly scope: string[] = [];

  /** Something a step will carry or install. Returns its key. Re-planning keeps the first entry. */
  plan(area: ParityArea, name: string, opts: { detail?: string; paths?: string[] } = {}): string {
    const key = parityKey(area, name);
    if (!this.items.has(key)) this.items.set(key, { key, area, name, status: "planned", ...opts });
    return key;
  }

  /** Something that will not go, and why. Overrides a plan. */
  skip(area: ParityArea, name: string, reason: string, opts: { detail?: string; fix?: string; paths?: string[] } = {}): string {
    const key = parityKey(area, name);
    const prev = this.items.get(key);
    // Only what this skip says: an earlier plan's paths or fix belong to what was planned, not to why it stays.
    this.set({ key, area, name, detail: opts.detail ?? prev?.detail, status: "skipped", reason, ...(opts.fix ? { fix: opts.fix } : {}), ...(opts.paths ? { paths: opts.paths } : {}) });
    return key;
  }

  /** A step's outcome for a planned item. An unplanned key is added, so an outcome is never lost. */
  settle(key: string, status: Exclude<ParityStatus, "planned">, opts: { reason?: string; fix?: string; detail?: string } = {}): void {
    const prev = this.items.get(key);
    const [area, ...rest] = key.split(":");
    // A new outcome brings its own reason and fix; the previous one's do not carry over.
    const { fix: _fix, reason: _reason, ...kept } = prev ?? { key, area: area as ParityArea, name: rest.join(":"), status };
    this.set({ ...kept, ...opts, detail: opts.detail ?? prev?.detail, status });
  }

  /** Settle every still-planned item that `match` selects. */
  settleWhere(match: (item: ParityItem) => boolean, status: Exclude<ParityStatus, "planned">, opts: { reason?: string; fix?: string } = {}): number {
    let n = 0;
    for (const item of this.items.values()) if (item.status === "planned" && match(item)) { this.settle(item.key, status, opts); n++; }
    return n;
  }

  get(key: string): ParityItem | undefined {
    return this.items.get(key);
  }

  all(): ParityItem[] {
    return [...this.items.values()];
  }

  private set(item: ParityItem): void {
    if ((item.status === "skipped" || item.status === "failed") && !item.reason?.trim()) {
      throw new Error(`parity item ${item.key} is ${item.status} without a reason`);
    }
    if (item.status !== "skipped" && item.status !== "failed") delete item.reason;
    this.items.set(item.key, item);
  }

  /**
   * The report. Outside a dry run, an item still planned is a failure: some
   * step was meant to report on it and did not.
   */
  finish(meta: { laptop: string; target: string; dryRun?: boolean; now?: Date }): ParityReport {
    if (!meta.dryRun) {
      for (const item of this.items.values()) {
        if (item.status === "planned") this.set({ ...item, status: "failed", reason: "no step reported what happened to it" });
      }
    }
    const items = this.all().sort((a, b) =>
      AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area) || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
    const counts = { planned: 0, carried: 0, installed: 0, present: 0, skipped: 0, failed: 0 } as Record<ParityStatus, number>;
    for (const i of items) counts[i.status]++;
    return { version: 1, created_at: (meta.now ?? new Date()).toISOString(), laptop: meta.laptop, target: meta.target, dry_run: !!meta.dryRun, scope: [...this.scope], items, counts };
  }
}

const STATUS_ORDER: ParityStatus[] = ["failed", "skipped", "planned", "carried", "installed", "present"];

const STATUS_WORD: Record<ParityStatus, string> = {
  planned: "will carry", carried: "carried", installed: "installed", present: "present", skipped: "skipped", failed: "FAILED",
};

/** How many paths of a grouped item the terminal shows before "and N more". */
const PATHS_SHOWN = 8;

/**
 * The report for a terminal. Every skipped and failed item gets its own line
 * with its reason. Items that made it are summed per area unless `all`.
 */
export function renderParityText(r: ParityReport, opts: { all?: boolean } = {}): string {
  const lines: string[] = [];
  const c = r.counts;
  const done = c.carried + c.installed + c.present;
  lines.push(r.dry_run
    ? `Dry run for ${r.laptop}: ${c.planned} to carry, ${c.skipped} staying behind`
    : `${r.laptop} → ${r.target}: ${done} carried or installed, ${c.skipped} skipped, ${c.failed} failed`);
  for (const area of AREA_ORDER) {
    const items = r.items.filter((i) => i.area === area);
    if (!items.length) continue;
    const ok = items.filter((i) => i.status === "carried" || i.status === "installed" || i.status === "present" || i.status === "planned");
    const gaps = items.filter((i) => i.status === "skipped" || i.status === "failed");
    lines.push("", `${AREA_TITLES[area]}  ${ok.length} ${r.dry_run ? "to carry" : "ok"}${gaps.length ? `, ${gaps.length} not` : ""}`);
    const shown = opts.all ? items : gaps;
    for (const i of shown) {
      lines.push(`  ${STATUS_WORD[i.status].padEnd(10)} ${i.name}${i.detail ? ` (${i.detail})` : ""}${i.reason ? `: ${i.reason}` : ""}`);
      if (i.fix) lines.push(`             fix: ${i.fix}`);
      if (i.paths?.length && (gaps.includes(i) || opts.all)) {
        for (const p of i.paths.slice(0, opts.all ? i.paths.length : PATHS_SHOWN)) lines.push(`             ${p}`);
        if (!opts.all && i.paths.length > PATHS_SHOWN) lines.push(`             and ${i.paths.length - PATHS_SHOWN} more (--all lists them)`);
      }
    }
    if (!opts.all && ok.length) lines.push(`  ${ok.length > 6 ? `${ok.slice(0, 6).map((i) => i.name).join(", ")} and ${ok.length - 6} more` : ok.map((i) => i.name).join(", ")}`);
  }
  if (r.scope.length) lines.push("", "Read from this laptop:", ...r.scope.map((s) => `  ${s}`));
  return lines.join("\n");
}

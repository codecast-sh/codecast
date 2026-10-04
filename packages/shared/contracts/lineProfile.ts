// The line profile's shape (docs/architecture/line-profile.md LP2, LP3): what
// `.codecast/line.toml` resolves to, and the copy `cast line profile --publish`
// writes onto each project it files into (projects.line_profile). The CLI
// loader, the Convex mutation and the web store all name these types, so the
// three cannot drift. Pure types and one comparison; no runtime deps.
import { canonicalJson } from "./appConnector";
import type { SignalKind } from "./signalFingerprint";

export type LineValueSource = "file" | "default";

export interface LineFinder {
  id: string;
  source: string;
  /** The kinds it files, or "any" for a finder that types each signal itself (a person). */
  kind: SignalKind[] | "any";
  fingerprint: string;
  runs?: string;
  /** The project its signals go to, when not the profile's. */
  project?: string;
}

export interface LineProfile {
  team: string | null;
  project: string | null;
  principles: string[];
  prompting: string;
  size_budget: number;
  watch_days: number;
  commands: { check: string; prove: string | null; eval: string | null; ship: string | null };
  caps: { cards: number };
  finders: LineFinder[];
}

/** A finder as a project row holds it: the project it files into is the row. Kinds are stored as written. */
export type LineFinderDecl = Omit<LineFinder, "project" | "kind"> & { kind: "any" | string[] };

/**
 * The resolved profile apart from its finders (which are published per
 * project), with where each value came from and what the loader said.
 * `file` is repo relative (`.codecast/line.toml`), or null when the repo has none.
 */
export type LineProfileFacts = Omit<LineProfile, "finders"> & {
  /** By dotted key (team, commands.check, caps.cards, finders, ...). */
  sources: Record<string, LineValueSource>;
  notes: string[];
  warnings: string[];
  file: string | null;
};

/**
 * projects.line_profile. finders/root/default/changed_at have been written
 * since LP3; the rest arrives with every publish from a CLI that sends the
 * whole profile, so a row published before that lacks them.
 *
 * changed_at: when the profile's content (values, finders, sources, notes,
 * warnings, default) last changed. published_at: when the row was last
 * written, which a move to another checkout or device also does.
 */
export type PublishedLineProfile = {
  finders: LineFinderDecl[];
  root?: string;
  default?: boolean;
  changed_at: number;
} & Partial<LineProfileFacts & {
  /** The device whose daemon published it: where an edit of the file is routed. */
  device_id: string;
  published_at: number;
}>;

const FACT_KEYS = ["team", "project", "principles", "prompting", "size_budget", "watch_days", "commands", "caps", "sources", "notes", "warnings"] as const;

/** The content changed_at tracks: every fact but where it lives and who published it. */
export function lineProfileContentKey(p: Omit<PublishedLineProfile, "changed_at"> | null | undefined): string {
  if (!p) return "";
  const facts: Record<string, unknown> = { default: !!p.default, finders: p.finders };
  for (const k of FACT_KEYS) facts[k] = p[k];
  return canonicalJson(facts);
}

/** Whether a publish would write anything: content, or where the file lives and which device holds it. */
export function lineProfileUnchanged(prev: PublishedLineProfile | null | undefined, next: Omit<PublishedLineProfile, "changed_at" | "published_at">): boolean {
  return !!prev
    && lineProfileContentKey(prev) === lineProfileContentKey(next)
    && prev.root === next.root
    && (prev.file ?? null) === (next.file ?? null)
    && prev.device_id === next.device_id;
}

// Parser for a standing role's wake frame, the user message convex/orgWakes.ts
// buildFrame delivers into the role's standing session (docs/architecture/
// org-roles-standing.md T3). The detection predicate lives in
// @codecast/shared/contracts (machineMessages.ts) so the send classifier and
// the card previews agree; this module reads the frame into what the wake card
// renders.
//
//   <role-wake or-8 wake="rw-12" at="2026-09-15T04:01:55.078Z" causes="9" held="2">
//   ## You
//   Reliability lead (@reliability, or-8) · trust understand · reports to Ashot
//   Scope: project Codecast: Sync & Reliability, plan pl-497 …
//   Today: 1/40 wakes · 0/6 hands · 0/400000 tokens
//
//   ## Why you are awake
//   - task ct-51321 "…" is done
//   - (held) (passive) decision sd-4 answered
//   - and 26 more changes
//
//   ## Your scope now
//   …
//   </role-wake>
//
// `wake`, `causes` and `held` arrived with the card; a frame from before then
// has none, so the counts fall back to the Why lines themselves.
import { ROLE_WAKE_OPEN_RE, isRoleWakeFrame, stripInjectionNoise } from "@codecast/shared/contracts";

export { isRoleWakeFrame };

/** Lines the card shows of a section before "show all N lines". */
export const ROLE_WAKE_LINE_CAP = 12;

export type RoleWakeSectionKey = "you" | "why" | "scope" | "hands" | "channels" | "charter" | "brief" | "other";

export type RoleWakeSection = {
  key: RoleWakeSectionKey;
  title: string;
  /** Non-empty lines, as written (a list item keeps its "- "). */
  lines: string[];
};

export type RoleWakeYou = {
  name: string;
  handle: string;
  trust?: string;
  reportsTo?: string;
  scope?: string;
  today?: string;
};

export type RoleWakeFrame = {
  roleShortId: string;
  /** Epoch ms from the `at` attribute; null when it does not parse. */
  at: number | null;
  wakeShortId?: string;
  /** Outbox groups behind this wake, backlog included. */
  causes: number;
  /** Groups an earlier flush held back (a cap, a pause). */
  held: number;
  /** Groups that were facts for the next frame rather than a wake of their own. */
  passive: number;
  you?: RoleWakeYou;
  sections: RoleWakeSection[];
  /** The first frame after a restart: the charter and brief ride in full. */
  restart: boolean;
};

const SECTION_KEYS: Array<[RegExp, RoleWakeSectionKey]> = [
  [/^you$/i, "you"],
  [/^why you are awake$/i, "why"],
  [/^your scope now$/i, "scope"],
  // "Hands say" is the heading frames carried before org-roles-run-work.md R1.
  [/^(your sessions|hands say)$/i, "hands"],
  [/^channels$/i, "channels"],
  [/^charter$/i, "charter"],
  [/^brief$/i, "brief"],
];

const NOTHING_QUEUED = /^- \(nothing queued\)$/;
const MORE_LINE = /^- and (\d+) more /;

function sectionKey(title: string): RoleWakeSectionKey {
  for (const [re, key] of SECTION_KEYS) if (re.test(title)) return key;
  return "other";
}

function readAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([a-z_]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function readYou(lines: string[]): RoleWakeYou | undefined {
  const head = lines[0]?.match(/^(.+?) \(@([^,\s)]+), or-\d+\)(?: · trust (\S+))?(?: · reports to (.+))?$/);
  if (!head) return undefined;
  const field = (label: string) => lines.find((l) => l.startsWith(`${label}: `))?.slice(label.length + 2);
  return { name: head[1], handle: head[2], trust: head[3], reportsTo: head[4], scope: field("Scope"), today: field("Today") };
}

/** The Why lines that are causes: not the empty marker, not the overflow count. */
export function causeLines(section: RoleWakeSection | undefined): string[] {
  return (section?.lines ?? []).filter((l) => l.startsWith("- ") && !NOTHING_QUEUED.test(l) && !MORE_LINE.test(l));
}

// Exactly one frame, and nothing else: a role's turn is the frame alone, so a
// prompt that carries other text around a frame is not a wake and renders as
// whatever it is.
export function parseRoleWakeFrame(rawContent: string | null | undefined): RoleWakeFrame | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent).trim();
  const open = text.match(ROLE_WAKE_OPEN_RE);
  if (!open) return null;
  const closeAt = text.lastIndexOf("</role-wake>");
  if (closeAt === -1 || text.slice(closeAt + "</role-wake>".length).trim()) return null;
  const body = text.slice(open[0].length, closeAt);
  const attrs = readAttrs(open[2] ?? "");

  const sections: RoleWakeSection[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trimEnd();
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      const title = heading[1].trim();
      sections.push({ key: sectionKey(title), title, lines: [] });
      continue;
    }
    if (!line.trim()) continue;
    if (sections.length === 0) sections.push({ key: "other", title: "", lines: [] });
    sections[sections.length - 1].lines.push(line);
  }

  const why = sections.find((s) => s.key === "why");
  const listed = causeLines(why);
  const more = why?.lines.map((l) => l.match(MORE_LINE)).find(Boolean);
  const countAttr = (name: string): number | null => (attrs[name] !== undefined && /^\d+$/.test(attrs[name]) ? Number(attrs[name]) : null);
  const causes = countAttr("causes") ?? listed.length + (more ? Number(more[1]) : 0);
  const held = countAttr("held") ?? listed.filter((l) => l.startsWith("- (held)")).length;
  const passive = listed.filter((l) => /^- (?:\(held\) )?\(passive\)/.test(l)).length;

  const at = attrs.at ? Date.parse(attrs.at) : NaN;
  const you = readYou(sections.find((s) => s.key === "you")?.lines ?? []);
  const charter = sections.find((s) => s.key === "charter");
  const restart = !!charter && !charter.lines[0]?.startsWith("hash ") && sections.some((s) => s.key === "brief");
  return {
    roleShortId: open[1],
    at: Number.isNaN(at) ? null : at,
    wakeShortId: attrs.wake || undefined,
    causes,
    held,
    passive,
    you,
    sections,
    restart,
  };
}

/** The frame quotes a work item's title after its id ("task ct-5 "Deploy" is
 *  done") so an agent reads it without a lookup; a surface that renders the id
 *  as a pill already shows the title, so the quote would say it twice. */
export function dedupeTitles(line: string): string {
  return line.replace(/\b((?:ct|pl|or|rw|sd)-\d+) "[^"\n]*"/g, "$1");
}

/** What a person reads of the wake at rest: the first cause as written, its
 *  quoted title dropped (the pill says it) and its held/passive marks dropped
 *  (they are the role's reading, not the person's), then "and N more" for the
 *  rest. An empty queue says so. */
export function wakeLine(frame: Pick<RoleWakeFrame, "sections" | "causes">): string {
  const first = causeLines(frame.sections.find((s) => s.key === "why"))[0]?.replace(/^- (?:\(held\) )?(?:\(passive\) )?/, "");
  if (!first) return "nothing queued";
  const more = frame.causes - 1;
  return more > 0 ? `${dedupeTitles(first)}, and ${more} more` : dedupeTitles(first);
}

/** "woke on 9 changes, 2 held" — the open card's one-line account of the wake. */
export function describeWake(frame: Pick<RoleWakeFrame, "causes" | "held">): string {
  const n = frame.causes;
  const head = n === 0 ? "woke on nothing queued" : `woke on ${n} ${n === 1 ? "change" : "changes"}`;
  return frame.held > 0 ? `${head}, ${frame.held} held` : head;
}

// ── Where a message went (scopes-and-feed.md F4.2) ──────────────────────────
//
// The role says the routing in its own words; the card under the wake shows
// it from what the role actually did in that turn, never from what it said.
// A hand it started is a conversation row spawned by the standing session
// whose start falls inside the turn: from this wake until the next turn
// boundary. A hand it sent to is a `cast send <id>` the role ran in the turn.

/** A person wrote into the scope: the wake carries a "<name> wrote:" cause. */
export function personWrote(frame: Pick<RoleWakeFrame, "sections">): boolean {
  return causeLines(frame.sections.find((s) => s.key === "why")).some((l) => /^- (?:\(held\) )?(?:\(passive\) )?.+ wrote:/.test(l));
}

/** The hands whose start falls inside one turn: at or after the wake, before
 *  the next turn boundary (`until` null = the turn is the latest). Oldest first. */
export function handsStartedInTurn<T extends { started_at: number }>(hands: readonly T[], at: number | null, until: number | null): T[] {
  if (at == null) return [];
  return hands.filter((h) => h.started_at >= at && (until == null || h.started_at < until)).sort((a, b) => a.started_at - b.started_at);
}

/** The session a `cast send` reached: the first bare word after the verb
 *  (flags such as --wake may come first). Null for any other cast command. */
export function sentToRef(cmd: { category: string; subcommand: string; args: string } | null | undefined): string | null {
  if (!cmd || cmd.category !== "send") return null;
  const words = [cmd.subcommand, ...cmd.args.split(/\s+/)].filter(Boolean);
  for (const w of words) {
    if (w.startsWith("-")) continue;
    return /^[A-Za-z0-9]{5,}$/.test(w) ? w : null;
  }
  return null;
}

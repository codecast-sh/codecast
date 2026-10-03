// The small pieces a story is drawn from, shared by the lead, the section rows,
// In brief and the drawer, so a story reads the same wherever it sits: its area
// tag, kind glyph, risk texture, the release that carried it, the people and
// sessions behind it, and the line that says where its "why" came from.
import { useRef, useState, type ReactNode } from "react";
import { ChevronUp, CircleDashed, CornerUpLeft, Zap } from "lucide-react";
import { leadSentences } from "@codecast/shared/changes";
import type { StoryRow } from "../../hooks/useSyncChanges";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { memberAvatarUrl } from "../../lib/liveEntities";
import { AuthorAvatar } from "../entityDisplay";
import { EntityIdPill, TextWithMentions } from "../EntityIdPill";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { areaColor, areaLabel, KIND_COLOR, RISK_HATCH } from "./areaColor";
import { peopleOf, riskText } from "./editionModel";
import { glueUnits } from "./format";
import { useAreaColors, useStoryCtx } from "./storyContext";

/** A wall-clock time, "15:27" in the reader's locale. */
export const clockOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** Whether an element's text is cut by its own box (a line clamp, or a truncate): the element, or the `data-clip` text inside it. */
const isClipped = (trigger: HTMLElement | null) => {
  const el = trigger?.querySelector<HTMLElement>("[data-clip]") ?? trigger;
  return !!el && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
};

/**
 * A tooltip in the page's quiet register, opened by hover or keyboard focus.
 * With `whenClipped` it opens only while its trigger's text (or the
 * `data-clip` element inside it) is cut short, so text on screen whole is
 * never said twice.
 */
export function Tip({ text, children, side = "top", whenClipped = false }: {
  text: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  whenClipped?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement>(null);
  if (!text) return <>{children}</>;
  return (
    <Tooltip open={open} onOpenChange={(o) => setOpen(o && (!whenClipped || isClipped(trigger.current)))}>
      <TooltipTrigger asChild ref={trigger as any}>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-[320px] border border-sol-border/40 bg-sol-bg px-2 py-1 font-mono text-[10px] leading-relaxed text-sol-text shadow-md">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

/** The 6px square in an area's color on this page. */
export function AreaDot({ area }: { area: string }) {
  const colors = useAreaColors();
  return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-[1px]" style={{ background: areaColor(area, colors) }} />;
}

/** A 6px square in the area color, then the area name. */
export function AreaTag({ area, className = "" }: { area: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] text-sol-text/60 ${className}`}>
      <AreaDot area={area} />
      {areaLabel(area)}
    </span>
  );
}

const KIND_ICON = { feature: ChevronUp, fix: CircleDashed, perf: Zap, revert: CornerUpLeft } as const;
const KIND_LABEL: Record<string, string> = { feature: "Feature", fix: "Fix", perf: "Performance", revert: "Revert" };

/** Feature, fix, perf and revert carry a glyph; docs, tests and chores carry none. */
export function KindGlyph({ kind }: { kind: string }) {
  const Icon = KIND_ICON[kind as keyof typeof KIND_ICON];
  if (!Icon) return <span aria-hidden className="inline-block w-3 shrink-0" />;
  return (
    <span className="inline-flex w-3 shrink-0 justify-center" title={KIND_LABEL[kind]} style={{ color: KIND_COLOR[kind] }}>
      <Icon className="h-3 w-3" strokeWidth={kind === "fix" ? 3 : 2.25} aria-label={KIND_LABEL[kind]} />
    </span>
  );
}

/** The story's risks for a screen reader, inside the control that names the story. */
export function RiskSrText({ story }: { story: Pick<StoryRow, "risks" | "risk_lines"> }) {
  if (!story.risks.length) return null;
  return <span className="sr-only">Risk: {riskText(story)}</span>;
}

/**
 * The story's left edge: the area rail, or the risk hatch in its place. On a
 * card it runs the card's height. A `compact` row wears it as a tick beside
 * its headline's first line, so two flagged rows in a row read as two ticks,
 * not one dashed rule. Screen readers hear the risk from RiskSrText.
 */
export function StoryEdge({ story, width = 2, compact = false }: { story: Pick<StoryRow, "area" | "risks" | "risk_lines">; width?: number; compact?: boolean }) {
  const colors = useAreaColors();
  const place = compact ? "top-[6px] h-[12px] rounded-[1px]" : "inset-y-0 rounded-l-[inherit]";
  if (!story.risks.length) {
    return <span aria-hidden className={`absolute left-0 ${place}`} style={{ width, background: areaColor(story.area, colors) }} />;
  }
  // The hatch is 3px; the tooltip answers on a 10px strip over it.
  return (
    <Tip text={<span className="whitespace-pre-line">{riskText(story)}</span>} side="left">
      <span aria-hidden className={`absolute left-0 z-[1] w-2.5 cursor-help ${place}`}>
        <span className={`absolute left-0 ${compact ? "inset-y-0 rounded-[1px]" : "inset-y-0 rounded-l-[inherit]"}`} style={{ width: 3, background: RISK_HATCH }} />
      </span>
    </Tip>
  );
}

/** A stored risk line cut short ends in an ellipsis; on the page it reads as a closed sentence. */
const closeLine = (line: string) => line.replace(/\s*(?:…|\.\.\.)$/, ".");

/** One worded risk: what the line says, and the whole of it, evidence included, for its tip. */
export type RiskLineItem = { code: string; text: string; tip: string };

/**
 * The lines under a dek that name a story's risks in words, one per worded
 * risk (spec 4.4). A size note (`bulk`) comes after every real hazard, so a
 * row that shows two never drops a hazard for it. Empty when it has none.
 */
export function riskLines(story: Pick<StoryRow, "risks" | "risk_lines">): RiskLineItem[] {
  if (!story.risks.length) return [];
  const ordered = [...story.risks].sort((a, b) => Number(a.code === "bulk") - Number(b.code === "bulk"));
  const worded = ordered.flatMap((r) => {
    const line = story.risk_lines?.[r.code]?.trim();
    return line ? [{ code: r.code, text: closeLine(line), tip: closeLine(line) }] : [];
  });
  return worded.length ? worded : [{ code: "flagged", text: `Flagged: ${ordered.map((r) => r.code).join(", ")}`, tip: riskText({ risks: ordered, risk_lines: story.risk_lines }) }];
}

/** A file path two folders deep or more (`packages/convex/convex/migrations/x.sql`): the line shows its file name. */
const LONG_PATH = /(?:[\w.@-]+\/){2,}([\w.@-]+)/g;

/** Risk text with every long file path cut to its last segment; the full text is the line's tip. */
export const shortPaths = (text: string) => text.replace(LONG_PATH, "$1");

/** Risks a row shows before "+N more": the rest are in its open drawer. */
const ROW_RISKS = 2;

/**
 * A story's risks in words under its prose (spec 4.4): the hatch swatch, then
 * one line per worded risk with long paths cut to their file names. `full`
 * (the lead card, the week's biggest story) shows every risk whole. Without
 * it (a row) each risk is clamped at two lines and the first two show, then
 * "+N more"; the row's open drawer lifts the clamp and shows the rest
 * (globals.css), so the whole of every risk is a keypress away. A row's
 * RiskSrText speaks every risk inside its control, so the clamped line is
 * for the eye only. A line's tip holds it in full, paths included, and opens
 * when a path was cut or the clamp cut the line.
 */
export function RiskLine({ story, full = false, className = "" }: { story: Pick<StoryRow, "risks" | "risk_lines">; full?: boolean; className?: string }) {
  const risks = riskLines(story);
  if (!risks.length) return null;
  const more = full ? 0 : risks.length - ROW_RISKS;
  return (
    <span aria-hidden={full ? undefined : true} className={`chg-ui flex items-start gap-2 text-[13px] leading-[1.55] text-sol-text/70 ${className}`}>
      <span aria-hidden className="mt-[0.45em] h-2.5 w-3.5 shrink-0 rounded-[2px]" style={{ background: RISK_HATCH }} />
      <span className="min-w-0 flex-1">
        {risks.map((r, i) => {
          const short = shortPaths(r.text);
          const cls = full ? "" : `chg-risk-clamp line-clamp-2${i >= ROW_RISKS ? " chg-risk-extra" : ""}`;
          return (
            <Tip key={r.code} text={<span className="whitespace-pre-line [overflow-wrap:anywhere]">{r.tip}</span>} whenClipped={short === r.tip}>
              <span className={`block [overflow-wrap:anywhere] ${i ? "mt-1" : ""} ${cls}`}>{short}</span>
            </Tip>
          );
        })}
        {more > 0 && <span className="chg-risk-more mt-0.5 block font-mono text-[11px] text-sol-text/55">+{more} more</span>}
      </span>
    </span>
  );
}

/**
 * The opener of a card whose headline is already said above it (the day's
 * lead, the week's biggest story): a lede a step above the body, so the card
 * opens on it. One class, so the two cards cannot drift apart.
 */
export const CARD_LEDE = "chg-ui mt-2.5 text-[17px] font-medium leading-[1.5] text-sol-text [overflow-wrap:anywhere]";

/** A card's body text, and its dek under a shown headline. */
export const CARD_BODY = "chg-ui text-[15px] leading-[1.6] text-sol-text/80 [overflow-wrap:anywhere]";

/** Words of a story's body a card opens with when its headline is already said. */
const OPENER_WORDS = 40;

/**
 * What a card says under a headline the reader has already read: the first
 * sentences of the story's body, since its dek mostly paraphrases the
 * headline, and `rest` the body after them. A story with no body opens with
 * its dek.
 */
export function storyOpener(story: Pick<StoryRow, "body" | "dek">): { text: string; rest: string } {
  const body = story.body ? leadSentences(story.body, OPENER_WORDS) : null;
  return body?.lead ? { text: body.lead, rest: body.rest } : { text: story.dek, rest: "" };
}

/** The main column when the filters match nothing: what they missed, and the way out. */
export function NoMatch({ what, onClear }: { what: string; onClear: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-sol-border/40 px-5 py-8 text-center">
      <p className="chg-ui text-[14px] text-sol-text/70">No {what} match these filters.</p>
      <button type="button" onClick={onClear} className="mt-2 font-mono text-[11px] text-sol-text/60 underline-offset-2 hover:text-sol-text hover:underline">
        clear filters
      </button>
    </div>
  );
}

/** "shipped in cli 1.1.163" when a release of the story's surface followed it. */
export function ReleaseTag({ story }: { story: Pick<StoryRow, "release"> }) {
  if (!story.release) return null;
  const r = story.release;
  return (
    <span className="font-mono text-[11px] text-sol-text/55">
      shipped in {r.surface} {r.version ?? r.sha.slice(0, 7)}
    </span>
  );
}

/**
 * Text that crossfades when it changes: the deterministic headline giving way
 * to prose. Keyed by the text, so only a change remounts it, and only a change
 * after the first paint fades. Short ids (`jx7c6zk`, `#412`) render as pills,
 * and a number keeps its unit on its line (glueUnits).
 */
export function FadeText({ text, className = "" }: { text: string; className?: string }) {
  const first = useRef(text);
  return (
    <span key={text} className={`${text !== first.current ? "chg-prose-in" : ""} ${className}`}>
      <TextWithMentions text={glueUnits(text)} />
    </span>
  );
}

const WHY: Record<string, string> = { commit: "from commit message", pr: "from PR", none: "not stated" };

type WhyFacts = Pick<StoryRow, "why_source" | "conversation_ids" | "pr_ids" | "prose_status">;

/**
 * Whether a story has a "why" line to show. "not stated" accuses a session or
 * PR that existed and gave no reason; a story with neither had nowhere to
 * state one, so it says nothing.
 */
export const hasProvenance = (story: WhyFacts) =>
  story.why_source !== "none" || story.conversation_ids.length > 0 || story.pr_ids.length > 0;

/** Where the story's "why" came from: the page's trust mechanism (spec 4.4). */
export function Provenance({ story, className = "" }: { story: WhyFacts; className?: string }) {
  const { proseLive } = useStoryCtx();
  if (!hasProvenance(story)) return null;
  const src = story.why_source;
  const session = story.conversation_ids[0];
  let body: ReactNode;
  if (src === "session" && session) {
    body = (
      <>
        why: from session <EntityIdPill type="session" id={String(session)} compact />
      </>
    );
  } else if (src && WHY[src]) {
    body = <>why: {WHY[src]}</>;
  } else {
    // "notes pending" only while notes can still come (StoryContext.proseLive): never on a capped, failed or old day.
    body = <>{story.prose_status === "pending" && proseLive ? "written from commit subjects; notes pending" : "written from commit subjects"}</>;
  }
  return <span className={`inline-flex min-w-0 flex-wrap items-center gap-1 font-mono text-[11px] text-sol-text/55 ${className}`}>{body}</span>;
}

/** The people behind a story, one face per person (editionModel.peopleOf), the faces from the live roster. */
export function People({ story, size = 16, max = 4 }: { story: Pick<StoryRow, "actor_user_ids" | "author_names">; size?: number; max?: number }) {
  const roster = useTeamRosterIdentity();
  const people = peopleOf([story], roster).map((p) => {
    const m = p.userIds.map((id) => roster.find((r) => String(r._id) === id)).find(Boolean);
    return { key: p.key, name: p.name, image: m ? memberAvatarUrl(m) : undefined };
  });
  if (!people.length) return null;
  const shown = people.slice(0, max);
  const names = people.map((p) => p.name).join(", ");
  return (
    <span className="inline-flex items-center" title={names}>
      {shown.map((p, i) => (
        <span key={p.key} className="inline-flex rounded-full bg-sol-bg" style={{ marginLeft: i ? -4 : 0 }}>
          <AuthorAvatar name={p.name} avatar={p.image} size={size} />
        </span>
      ))}
      {people.length > max && <span className="ml-1 font-mono text-[10px] text-sol-text/45">+{people.length - max}</span>}
    </span>
  );
}

/** The sessions behind a story, as pills. */
export function SessionPills({ story, max = 3, className = "" }: { story: { conversation_ids: readonly string[] }; max?: number; className?: string }) {
  if (!story.conversation_ids.length) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 font-mono text-[11px] text-sol-text/55 ${className}`}>
      {story.conversation_ids.slice(0, max).map((id) => (
        <EntityIdPill key={String(id)} type="session" id={String(id)} compact />
      ))}
      {story.conversation_ids.length > max && (
        <span className="font-mono text-[10px] text-sol-text/45">+{story.conversation_ids.length - max}</span>
      )}
    </span>
  );
}

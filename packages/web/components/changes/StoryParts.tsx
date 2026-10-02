// The small pieces a story is drawn from, shared by the lead, the section rows,
// In brief and the drawer, so a story reads the same wherever it sits: its area
// tag, kind glyph, risk texture, the release that carried it, the people and
// sessions behind it, and the line that says where its "why" came from.
import { createContext, useContext, useRef, type ReactNode } from "react";
import { ChevronUp, CircleDashed, CornerUpLeft, Zap } from "lucide-react";
import type { StoryRow } from "../../hooks/useSyncChanges";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { memberAvatarUrl, memberDisplayName } from "../../lib/liveEntities";
import { AuthorAvatar } from "../entityDisplay";
import { EntityIdPill, TextWithMentions } from "../EntityIdPill";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { areaColor, KIND_COLOR, RISK_HATCH } from "./areaColor";

/** What every story on the page needs from the page: which story has the
 *  keyboard, which wait behind a ship, and how to pick one. */
export type StoryContext = {
  focused: string | null;
  waiting: ReadonlySet<string>;
  dimmed: ReadonlySet<string>;
  /** Give a story the focus (a click on it). */
  pick: (storyKey: string) => void;
};

export const StoryCtx = createContext<StoryContext>({ focused: null, waiting: new Set(), dimmed: new Set(), pick: () => {} });

export const useStoryCtx = () => useContext(StoryCtx);

/** A wall-clock time, "15:27" in the reader's locale. */
export const clockOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** A tooltip in the page's quiet register. */
export function Tip({ text, children, side = "top" }: { text: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  if (!text) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-[320px] border border-sol-border/40 bg-sol-bg px-2 py-1 font-mono text-[10px] leading-relaxed text-sol-text shadow-md">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

/** A 6px square in the area color, then the area name. */
export function AreaTag({ area, className = "" }: { area: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] text-sol-text/60 ${className}`}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-[1px]" style={{ background: areaColor(area) }} />
      {area}
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

/** Every risk on a story, worded when prose worded it, else its code and evidence. */
export function riskText(story: Pick<StoryRow, "risks" | "risk_lines">): string {
  return story.risks
    .map((r) => {
      const line = story.risk_lines?.[r.code];
      const evidence = r.evidence.length ? ` (${r.evidence.slice(0, 4).join(", ")}${r.evidence.length > 4 ? ", ..." : ""})` : "";
      return line ? `${line}${evidence}` : `${r.code}${evidence}`;
    })
    .join("\n");
}

/** The story's left edge: the area rail, or the risk hatch in its place. */
export function StoryEdge({ story, width = 2 }: { story: Pick<StoryRow, "area" | "risks" | "risk_lines">; width?: number }) {
  const risky = story.risks.length > 0;
  const edge = (
    <span
      aria-hidden={!risky}
      className="absolute inset-y-0 left-0 rounded-l-[inherit]"
      style={risky ? { width: 3, background: RISK_HATCH } : { width, background: areaColor(story.area) }}
    />
  );
  return risky ? <Tip text={<span className="whitespace-pre-line">{riskText(story)}</span>} side="left">{edge}</Tip> : edge;
}

/** The one line under a dek that names a risk in words (spec 4.4). */
export function riskLine(story: Pick<StoryRow, "risks" | "risk_lines">): string | null {
  if (!story.risks.length) return null;
  const worded = story.risks.map((r) => story.risk_lines?.[r.code]).filter(Boolean);
  if (worded.length) return worded.join(" ");
  return `Flagged: ${story.risks.map((r) => r.code).join(", ")}`;
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
 * after the first paint fades. Short ids (`jx7c6zk`, `#412`) render as pills.
 */
export function FadeText({ text, className = "" }: { text: string; className?: string }) {
  const first = useRef(text);
  return (
    <span key={text} className={`${text !== first.current ? "chg-prose-in" : ""} ${className}`}>
      <TextWithMentions text={text} />
    </span>
  );
}

const WHY: Record<string, string> = { commit: "from commit message", pr: "from PR", none: "not stated" };

/** Where the story's "why" came from: the page's trust mechanism (spec 4.4). */
export function Provenance({ story, className = "" }: { story: Pick<StoryRow, "why_source" | "conversation_ids" | "prose_status">; className?: string }) {
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
    body = <>{story.prose_status === "pending" ? "written from commit subjects; notes pending" : "written from commit subjects"}</>;
  }
  return <span className={`inline-flex min-w-0 flex-wrap items-center gap-1 font-mono text-[11px] text-sol-text/55 ${className}`}>{body}</span>;
}

/** The people behind a story: session owners from the live roster, then commit authors by name. */
export function People({ story, size = 16, max = 4 }: { story: Pick<StoryRow, "actor_user_ids" | "author_names">; size?: number; max?: number }) {
  const roster = useTeamRosterIdentity();
  const people: { key: string; name: string; image?: string }[] = [];
  const seen = new Set<string>();
  for (const id of story.actor_user_ids) {
    const m = roster.find((r) => r._id === String(id));
    if (!m) continue;
    const name = memberDisplayName(m);
    seen.add(name.toLowerCase());
    people.push({ key: String(id), name, image: memberAvatarUrl(m) });
  }
  for (const name of story.author_names) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const m = roster.find((r) => (r.name ?? "").toLowerCase() === name.toLowerCase());
    people.push({ key: `a:${name}`, name, image: m ? memberAvatarUrl(m) : undefined });
  }
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
export function SessionPills({ story, max = 3 }: { story: Pick<StoryRow, "conversation_ids">; max?: number }) {
  if (!story.conversation_ids.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {story.conversation_ids.slice(0, max).map((id) => (
        <EntityIdPill key={String(id)} type="session" id={String(id)} compact />
      ))}
      {story.conversation_ids.length > max && (
        <span className="font-mono text-[10px] text-sol-text/45">+{story.conversation_ids.length - max}</span>
      )}
    </span>
  );
}

"use client";
// The wake card: how a standing role's wake frame reads in the conversation
// view (docs/architecture/org-roles-standing.md T3, T6). The frame is one
// user message; raw, it is a wall of markdown with no way to tell who sent it
// or to act on it. A person reading the role's thread needs one quiet line
// from it, so at rest the card is that line: the role woke, and why, in a few
// words, with where the turn's message went beneath it. The whole frame is one
// click away: the same fold the card's sections use, opening the counts, the
// sections (Why open, the rest closed, so a long frame never fills the
// viewport), task and plan references as live pills, and the role's controls.
//
// Pure: everything it paints arrives as props. RoleWakeBlock.tsx connects it
// to the org store; the mount test drives this component alone.
import { useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { BellRing, ChevronDown, ChevronRight, Pause, Play, SlidersHorizontal, History, ArrowUpRight } from "lucide-react";
import { entityRemarkPlugins } from "../lib/remarkEntityIds";
import { MESSAGE_MD_COMPONENTS, MESSAGE_MD_REHYPE } from "./messageMarkdown";
import { compactAge } from "../lib/threadState";
import { cn } from "../lib/utils";
import type { HandStarted } from "../hooks/useHandsStartedBy";
import { EntityIdPill } from "./EntityIdPill";
import { ORG_STATE_META } from "./org/orgMeta";
import type { OrgRole } from "./org/orgTypes";
import { RoleFace } from "./org/RoleFace";
import { RoleHoverCard } from "./identity/RoleHoverCard";
import { ROLE_WAKE_LINE_CAP, dedupeTitles, describeWake, wakeLine, type RoleWakeFrame, type RoleWakeSection } from "./roleWake";

/** Where the message went, from what the role did in this turn (roleWake.ts):
 *  the hands it started, and the hands it sent a follow up to. */
export type RoleWakeRouting = { hands: HandStarted[]; sentTo: string[] };

export type RoleWakeCardProps = {
  frame: RoleWakeFrame;
  /** The message's own time; the frame's `at` wins when it parses. */
  timestamp?: number;
  now: number;
  /** The role from the org tree; null while the tree is cold or the role is gone. */
  role: OrgRole | null;
  /** Whether the viewer may pause and resume the role (lib/scopePage canEditRole). */
  canEdit: boolean;
  onSetPaused?: (paused: boolean) => void;
  routing?: RoleWakeRouting;
};

// Where the turn's message went (scopes-and-feed.md F4.2): each hand the role
// started in this turn as the live session reference, with the state word and
// colour the panel's Sessions tab groups it under (ORG_STATE_META on the
// observed work state, so a card here and a row there never disagree); then
// each hand a follow up was sent to. Rows that exist, rendered; nothing here
// comes from the role's prose. At rest the hands sit on one wrapping line
// under the wake's own; open, each is a row with its pinned line, its task
// and its age.
function WhereItWent({ routing, now, compact }: { routing: RoleWakeRouting; now: number; compact?: boolean }) {
  if (routing.hands.length === 0 && routing.sentTo.length === 0) return null;
  const rowCls = compact ? "inline-flex items-center gap-1.5 min-w-0 max-w-full" : "flex items-center gap-2 min-w-0 text-[12.5px]";
  return (
    <div
      className={cn(compact ? "px-3 pb-1.5 pl-[34px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]" : "border-t px-3 py-2 space-y-1.5")}
      style={compact ? undefined : { borderColor: soft(18) }}
      data-routing
    >
      {!compact && <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Where it went</div>}
      {routing.hands.map((h) => {
        const meta = ORG_STATE_META[h.state] ?? ORG_STATE_META.idle;
        return (
          <div key={h._id} className={rowCls} data-hand={h._id}>
            <span className="shrink-0" style={{ color: "var(--sol-text-muted)" }}>started</span>
            <EntityIdPill type="session" id={h._id} label={h.title || h.short_id || "a hand"} />
            <span className="inline-flex items-center gap-1 shrink-0 text-[10.5px] font-medium" style={{ color: meta.color }} data-hand-state={h.state}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: meta.color }} aria-hidden />
              {meta.label}
            </span>
            {!compact && h.state_line && <span className="min-w-0 truncate text-[11.5px]" style={{ color: "var(--sol-text-muted)" }} title={h.state_line}>{h.state_line}</span>}
            {!compact && h.task_short_id && <EntityIdPill shortId={h.task_short_id} compact />}
            {!compact && <span className="ml-auto shrink-0 text-[10px] tabular-nums" style={{ color: "var(--sol-text-dim)" }} title={new Date(h.started_at).toLocaleString()}>{compactAge(Math.max(0, now - h.started_at))}</span>}
          </div>
        );
      })}
      {routing.sentTo.map((ref) => (
        <div key={ref} className={rowCls} data-sent-to={ref}>
          <span className="shrink-0" style={{ color: "var(--sol-text-muted)" }}>sent to</span>
          <EntityIdPill type="session" shortId={ref} />
        </div>
      ))}
    </div>
  );
}

const violet = "var(--sol-violet)";
const soft = (pct: number) => `color-mix(in srgb, var(--sol-violet) ${pct}%, transparent)`;

function Tag({ children, color = "var(--sol-text-dim)", bg = "color-mix(in srgb, var(--sol-border) 40%, transparent)", title }: { children: React.ReactNode; color?: string; bg?: string; title?: string }) {
  return (
    <span className="inline-flex items-center h-[18px] px-1.5 rounded-md text-[10px] font-medium tabular-nums whitespace-nowrap" style={{ color, background: bg }} title={title}>
      {children}
    </span>
  );
}

// One frame line. A list item drops its dash; a label line ("Plans:") reads as
// a subhead; everything else is inline markdown so ct-/pl-/jx ids become pills.
function FrameLine({ line }: { line: string }) {
  const item = line.startsWith("- ");
  const text = item ? line.slice(2) : line;
  if (!item && /^[A-Z][^:]{0,40}:$/.test(text)) {
    return <div className="mt-1.5 first:mt-0 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>{text.slice(0, -1)}</div>;
  }
  const held = item && text.startsWith("(held) ");
  const rest = held ? text.slice("(held) ".length) : text;
  const passive = item && rest.startsWith("(passive) ");
  const body = dedupeTitles(passive ? rest.slice("(passive) ".length) : rest);
  return (
    <div className={cn("flex gap-2 text-[12.5px] leading-[1.45]", item && "pl-0.5")}>
      {item && <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full" style={{ background: held ? "var(--sol-yellow)" : soft(70) }} aria-hidden />}
      <div className="min-w-0 flex-1 [&_p]:m-0 [&_code]:text-[11.5px]" style={{ color: passive ? "var(--sol-text-muted)" : "var(--sol-text)" }}>
        {held && <Tag color="var(--sol-yellow)" bg="color-mix(in srgb, var(--sol-yellow) 14%, transparent)" title="Held back by a limit or a pause before this wake">held</Tag>}
        {held && " "}
        {passive && <Tag title="A fact for this frame, not a wake of its own">passive</Tag>}
        {passive && " "}
        <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MESSAGE_MD_COMPONENTS}>{body}</ReactMarkdown>
      </div>
    </div>
  );
}

export function RoleWakeSectionGroup({ section, defaultOpen }: { section: RoleWakeSection; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  const n = section.lines.length;
  const shown = all ? section.lines : section.lines.slice(0, ROLE_WAKE_LINE_CAP);
  return (
    <div className="border-t" style={{ borderColor: soft(18) }} data-section={section.key}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-sol-bg-highlight/40 transition-colors"
      >
        <ChevronRight className={cn("w-3 h-3 shrink-0 transition-transform", open && "rotate-90")} style={{ color: violet }} />
        <span className="text-[12px] font-medium" style={{ color: "var(--sol-text)" }}>{section.title}</span>
        <span className="ml-auto text-[10px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{n} {n === 1 ? "line" : "lines"}</span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pl-[26px] space-y-1">
          {shown.map((line, i) => <FrameLine key={i} line={line} />)}
          {n > shown.length && (
            <button type="button" onClick={() => setAll(true)} className="text-[11px] hover:underline" style={{ color: violet }}>
              show all {n} lines
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FooterButton({ icon: Icon, label, href, onClick, title, disabled }: { icon: any; label: string; href?: string; onClick?: () => void; title?: string; disabled?: boolean }) {
  const cls = "inline-flex items-center gap-1 h-6 px-2 rounded-md border text-[11px] font-medium transition-colors hover:bg-sol-bg-highlight/60 disabled:opacity-50 disabled:cursor-default";
  const style = { borderColor: soft(30), color: "var(--sol-text)" };
  const inner = (<><Icon className="w-3 h-3" style={{ color: violet }} />{label}</>);
  if (href) return <Link href={href} className={cls} style={style} title={title}>{inner}</Link>;
  return <button type="button" onClick={onClick} className={cls} style={style} title={title} disabled={disabled}>{inner}</button>;
}

export function RoleWakeCard({ frame, timestamp, now, role, canEdit, onSetPaused, routing }: RoleWakeCardProps) {
  const [open, setOpen] = useState(false);
  const at = frame.at ?? (timestamp && timestamp > 0 ? timestamp : null);
  const name = role?.name ?? frame.you?.name ?? frame.roleShortId;
  const handle = role?.handle ?? frame.you?.handle;
  const rolePath = `/org/${frame.roleShortId}`;
  const wakesPath = `${rolePath}?tab=wakes${frame.wakeShortId ? `&wake=${frame.wakeShortId}` : ""}`;
  const paused = role?.status === "paused";
  const retired = role?.status === "retired";
  const toggle = () => setOpen((o) => !o);
  return (
    <div className="mb-2 mx-1 rounded-lg overflow-hidden" style={open ? { background: soft(5), border: `1px solid ${soft(24)}` } : undefined} data-role-wake={frame.roleShortId} data-open={open || undefined}>
      {/* The line: who woke and why. The row toggles the frame; the name and
          the pills inside the why are links of their own, so they stop the
          toggle, and the chevron is the control a keyboard reaches. The why
          is a flex row rather than clipped text: an ellipsis on the text
          hides a pill whole once it no longer fits, so instead the pill
          shrinks and truncates its own title and the words around it stay. */}
      <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-sol-bg-highlight/40 transition-colors" onClick={toggle} data-role-wake-line>
        <BellRing className="w-3.5 h-3.5 shrink-0" style={{ color: violet }} />
        {/* The role's face (S13); what it looks after is one hover away
            (org-roles-run-work.md R3). The frame always names the role's id,
            so the line works before the tree is warm. */}
        <span className="inline-flex min-w-0 shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
          <RoleHoverCard role={{ short_id: frame.roleShortId, name, handle: handle ?? "", avatar: role?.avatar }} side="bottom" triggerClassName="inline-flex min-w-0 items-center gap-1.5">
            {handle && <RoleFace role={{ avatar: role?.avatar, handle, name }} size={18} className="shrink-0" />}
            <Link href={rolePath} className="min-w-0 truncate text-[12.5px] font-medium hover:underline" style={{ color: "var(--sol-text)" }}>{name}</Link>
          </RoleHoverCard>
        </span>
        <span className="min-w-0 flex-1 flex items-center gap-1 overflow-hidden whitespace-nowrap text-[12.5px] [&_p]:m-0 [&_p]:min-w-0 [&_p]:flex [&_p]:items-center [&_p]:gap-1 [&_code]:text-[11.5px] [&_.entity-ref]:min-w-[7rem] [&_.entity-ref]:shrink [&_.entity-ref]:max-w-[14rem] [&_.entity-ref>span:last-child]:truncate" style={{ color: "var(--sol-text-muted)" }} onClick={(e) => { if ((e.target as HTMLElement).closest("a")) e.stopPropagation(); }} data-role-wake-why>
          <span className="shrink-0">woke:</span>
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MESSAGE_MD_COMPONENTS}>{wakeLine(frame)}</ReactMarkdown>
        </span>
        {paused && !open && <Tag color="var(--sol-yellow)" bg="color-mix(in srgb, var(--sol-yellow) 14%, transparent)">paused now</Tag>}
        {at != null && (
          <span className="text-[10px] shrink-0 tabular-nums" style={{ color: "var(--sol-text-dim)" }} title={new Date(at).toLocaleString()}>{compactAge(Math.max(0, now - at))}</span>
        )}
        <button type="button" onClick={(e) => { e.stopPropagation(); toggle(); }} aria-expanded={open} aria-label={open ? "Fold the wake frame" : "Open the wake frame"} title={open ? "Fold the wake frame" : "The whole frame the role read"} className="shrink-0 -mr-1 p-0.5 rounded hover:bg-sol-bg-highlight/60">
          <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")} style={{ color: "var(--sol-text-dim)" }} />
        </button>
      </div>
      {!open && routing && <WhereItWent routing={routing} now={now} compact />}
      {open && (
        <>
          <div className="flex items-center gap-2 px-3 pb-1.5 pl-[34px] flex-wrap text-[11px]" style={{ color: "var(--sol-text-muted)" }} data-role-wake-detail>
            {handle && <span style={{ fontFamily: "var(--font-mono)" }}>@{handle}</span>}
            {frame.wakeShortId && (
              <Link href={wakesPath} className="hover:underline" title="This wake in the role's log">
                <Tag color={violet} bg={soft(12)}>{frame.wakeShortId}</Tag>
              </Link>
            )}
            <span>{describeWake(frame)}</span>
            {frame.held > 0 && <Tag color="var(--sol-yellow)" bg="color-mix(in srgb, var(--sol-yellow) 14%, transparent)" title={`${frame.held} of these were held back by a limit or a pause and ride this wake`}>held backlog</Tag>}
            {frame.restart && <Tag title="The first frame after a restart carries the charter and the brief in full">after restart</Tag>}
            {paused && <Tag color="var(--sol-yellow)" bg="color-mix(in srgb, var(--sol-yellow) 14%, transparent)">paused now</Tag>}
            {retired && <Tag>retired</Tag>}
            {frame.you?.today && <span className="tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{frame.you.today}</span>}
          </div>
          <div>
            {frame.sections.map((section, i) => (
              <RoleWakeSectionGroup key={`${section.key}-${i}`} section={section} defaultOpen={section.key === "why"} />
            ))}
          </div>
          {routing && <WhereItWent routing={routing} now={now} />}
          <div className="flex items-center gap-1.5 px-3 py-2 flex-wrap border-t" style={{ borderColor: soft(18) }}>
            <FooterButton icon={ArrowUpRight} label="Open role" href={rolePath} title="The role's page: brief, charter, hands, settings" />
            {canEdit && role && !retired && (
              <FooterButton
                icon={paused ? Play : Pause}
                label={paused ? "Resume" : "Pause"}
                onClick={() => onSetPaused?.(!paused)}
                title={paused ? "Held wakes ship as one frame" : "Hands stop at a safe point; wakes hold"}
              />
            )}
            <FooterButton icon={SlidersHorizontal} label="Limits" href={`${rolePath}?tab=settings`} title="The most it may do in one day, behind its settings" />
            <FooterButton icon={History} label="Why did this wake me" href={wakesPath} title="The wake log: every wake, its causes and its size" />
          </div>
        </>
      )}
    </div>
  );
}

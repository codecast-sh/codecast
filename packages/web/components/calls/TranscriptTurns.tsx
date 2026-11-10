// The transcript, as turns. One renderer for a call's words wherever they
// appear: the calls page (which adds turn selection on top), the huddle digest
// row in chat, and the huddle summary card in a session. Grouping consecutive
// segments by speaker is the reading unit everywhere, so the shape lives here
// once.
import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useLongPress } from "../../hooks/useLongPress";
import { firstName, speakerColor, speakerShortName } from "./speakers";
import { formatCallTime } from "@codecast/shared/entities";
import { ParticipantTag } from "./GuestTag";
import { groupTurns, turnsAnchor, type Turn } from "./transcriptTurnModel";
import { CallLinkButton } from "./CallLinkButton";
import { lineFilmed } from "@codecast/shared/contracts";

/** The line a click (or a key) landed on, read from its `data-seq`; the
 *  turn's first line when it landed on the speaker row or between lines.
 *  Where that seeks is the caller's (lineSeekMs), since it knows what was
 *  filmed. */
function clickedLine(t: Turn, target: EventTarget | null): ClickedLine {
  const seq = (target as Element | null)?.closest?.("[data-seq]")?.getAttribute("data-seq");
  const line = seq == null ? undefined : t.segments.find((s) => String(s.seq) === seq);
  return line ?? t.segments[0] ?? { t0: t.t0 };
}

/** The line a turn was clicked on: when its words began and ended. */
export type ClickedLine = { t0: number; t1?: number };

/** A list's lines, with media to follow: each line holds a 2px rail on its
 *  left (drawn into its own margin, so the words do not move), lit for the
 *  line being said, a dim REC red over the stretches that were filmed, and
 *  clear elsewhere. The other lines of the turn being said step back a
 *  shade, so the eye lands on the one line. */
function lineClass(s: { seq: number; t0: number; t1?: number }, followed: boolean, inActive: boolean, activeSeq: number | null | undefined, filmed?: ReadonlyArray<{ fromMs: number; toMs: number }>): string {
  const base = "text-[13px] leading-relaxed";
  if (!followed) return `${base} text-sol-text`;
  const rail =
    activeSeq === s.seq
      ? "border-sol-cyan text-sol-text"
      : `${filmed && lineFilmed(filmed, s) ? "border-sol-red/25" : "border-transparent"} ${inActive ? "text-sol-text-secondary" : "text-sol-text"}`;
  return `${base} -ml-2 border-l-2 pl-1.5 transition-colors ${rail}`;
}

// The turn list itself. Selection is the calls page's concern: pass isSelected
// and onTurnClick to get the clickable variant; leave them off for a read-only
// transcript (the digest rows).
export function TranscriptTurnList({
  turns,
  isSelected,
  onTurnClick,
  onTurnHold,
  compact,
  activeIndex,
  activeSeq,
  filmed,
  callId,
}: {
  turns: Turn[];
  isSelected?: (index: number) => boolean;
  /** `line` is the line clicked: the one under the pointer when the click
   *  landed on one (a turn can hold minutes of one speaker, and "click a line
   *  to see that moment" means that line), else the turn's first. Seek it
   *  with lineSeekMs. */
  onTurnClick?: (index: number, e: React.MouseEvent, line: ClickedLine) => void;
  /** A finger held on a turn (useLongPress), where a finger has no Shift key
   *  to start a selection with. Only touch and pen presses hold; the click
   *  the hold ends in is spent. */
  onTurnHold?: (index: number) => void;
  /** Time plus words, no speaker name. A recording has one microphone. */
  compact?: boolean;
  /** The turn the media is in, if any. */
  activeIndex?: number | null;
  /** The line inside it being said (lineSeqAt): lit on its own rail. Given
   *  (even null) only where media plays, which is what turns the rails on. */
  activeSeq?: number | null;
  /** The stretches of the call that were filmed (videoStretches): their
   *  lines carry a dim red rail. */
  filmed?: ReadonlyArray<{ fromMs: number; toMs: number }>;
  /** The call these turns belong to: each turn offers a link to itself. */
  callId?: string;
}) {
  const selectable = !!onTurnClick;
  const hold = useLongPress((index: number) => onTurnHold?.(index));
  const holds = selectable && !!onTurnHold;
  const followed = activeSeq !== undefined;
  const link = (t: Turn) => {
    const anchor = callId ? turnsAnchor([t]) : null;
    return anchor ? (
      <CallLinkButton callId={callId!} anchor={anchor} title="Copy a link to this turn" className="ml-1 align-middle" />
    ) : null;
  };
  return (
    <>
      {turns.map((t) => {
        const active = activeIndex === t.index;
        const selected = isSelected?.(t.index);
        return (
        <div
          key={t.index}
          data-turn={t.index}
          {...(selectable
            ? {
                role: "button",
                tabIndex: 0,
                "aria-pressed": selected,
                "aria-label": compact
                  ? `Line at ${formatCallTime(t.t0)}`
                  : `Turn by ${speakerShortName(t.speaker_name, t.speaker_id)} at ${formatCallTime(t.t0)}`,
                onClick: (e: React.MouseEvent) => {
                  if (hold.takeSpent()) return;
                  onTurnClick(t.index, e, clickedLine(t, e.target));
                },
                ...(holds
                  ? {
                      onPointerDown: (e: React.PointerEvent) => {
                        if (e.pointerType !== "mouse") hold.start(t.index);
                      },
                      onPointerUp: hold.cancel,
                      onPointerLeave: hold.cancel,
                      onPointerCancel: hold.cancel,
                      // The phone's own long press (select text, a callout)
                      // would land on the same finger.
                      onContextMenu: (e: React.MouseEvent) => {
                        if ((e.nativeEvent as PointerEvent).pointerType !== "mouse") e.preventDefault();
                      },
                    }
                  : {}),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onTurnClick(t.index, e as any, clickedLine(t, e.target));
                  }
                },
              }
            : {})}
          className={`group -mx-2 rounded-md px-2 py-1 ${
            selectable ? "cursor-pointer transition-colors " : ""
          }${holds ? "[@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none] " : ""}${
            selected
              ? "bg-sol-violet/10 ring-1 ring-inset ring-sol-violet/40"
              : active
                ? "bg-sol-bg-alt/60"
                : selectable
                  ? "hover:bg-sol-bg-alt/40"
                  : ""
          }`}
        >
          {compact ? (
            <div className="flex gap-3">
              <span className="w-10 shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-sol-text-dim">
                {formatCallTime(t.t0)}
              </span>
              <div className="min-w-0 flex-1">
                {t.segments.map((s) => (
                  <p key={s.seq} data-seq={s.seq} className={lineClass(s, followed, active, activeSeq, filmed)}>
                    {s.text}
                  </p>
                ))}
              </div>
              {link(t)}
            </div>
          ) : (
            <>
              <div className={`text-[11px] font-medium ${speakerColor(t.speaker_id)}`}>
                {firstName(t.speaker_name)}
                <ParticipantTag identity={t.speaker_id} name={t.speaker_name} className="ml-1.5 align-[1px]" />
                <span className="ml-2 font-normal text-sol-text-dim">{formatCallTime(t.t0)}</span>
                {link(t)}
              </div>
              {t.segments.map((s) => (
                <p key={s.seq} data-seq={s.seq} className={lineClass(s, followed, active, activeSeq, filmed)}>
                  {s.text}
                </p>
              ))}
            </>
          )}
        </div>
        );
      })}
    </>
  );
}

// The fold under a huddle digest row: closed it is one dim line, open it is
// the whole speaker-attributed transcript, fetched only at that moment — the
// digest row itself carries no words, so a channel of digests costs nothing
// until somebody reads one. Enrichment only (the summary above it stands on
// its own), hence useQueryNoThrow.
export function CallTranscriptDisclosure({
  transcriptId,
  className = "",
}: {
  transcriptId: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: call } = useQueryNoThrow(
    api.transcripts.webGetCall,
    open ? { transcript_id: transcriptId as any } : "skip",
  );
  const turns = groupTurns(call?.segments ?? []);
  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          transcript
        </button>
        <a
          href={`/calls/${transcriptId}`}
          className="flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
          title="Open the call page"
        >
          <ExternalLink className="w-3 h-3" /> call page
        </a>
      </div>
      {open && (
        <div className="mt-1.5 max-h-80 space-y-0.5 overflow-y-auto rounded border border-sol-border/25 bg-sol-bg-alt/30 px-3 py-2">
          {call === undefined ? (
            <div className="text-[12px] text-sol-text-dim">Loading transcript…</div>
          ) : call === null ? (
            <div className="text-[12px] text-sol-text-dim">
              Transcript not available (not yours to see, or deleted).
            </div>
          ) : turns.length === 0 ? (
            <div className="text-[12px] text-sol-text-dim">Nothing was transcribed.</div>
          ) : (
            <TranscriptTurnList turns={turns} callId={transcriptId} />
          )}
        </div>
      )}
    </div>
  );
}

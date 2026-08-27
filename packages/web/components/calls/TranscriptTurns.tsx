// The transcript, as turns. One renderer for a call's words wherever they
// appear: the calls page (which adds turn selection on top), the huddle digest
// row in chat, and the huddle summary card in a session. Grouping consecutive
// segments by speaker is the reading unit everywhere, so the shape lives here
// once.
import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { firstName, fmtClock, speakerColor } from "./speakers";
import { groupTurns, type Turn } from "./transcriptTurnModel";

// The turn list itself. Selection is the calls page's concern: pass isSelected
// and onTurnClick to get the clickable variant; leave them off for a read-only
// transcript (the digest rows).
export function TranscriptTurnList({
  turns,
  isSelected,
  onTurnClick,
}: {
  turns: Turn[];
  isSelected?: (index: number) => boolean;
  onTurnClick?: (index: number, e: React.MouseEvent) => void;
}) {
  const selectable = !!onTurnClick;
  return (
    <>
      {turns.map((t) => (
        <div
          key={t.index}
          {...(selectable
            ? {
                role: "button",
                tabIndex: 0,
                "aria-pressed": isSelected?.(t.index),
                "aria-label": `Turn by ${firstName(t.speaker_name)} at ${fmtClock(t.t0)}`,
                onClick: (e: React.MouseEvent) => onTurnClick(t.index, e),
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onTurnClick(t.index, e as any);
                  }
                },
              }
            : {})}
          className={`-mx-2 rounded-md px-2 py-1 ${
            selectable
              ? `cursor-pointer transition-colors ${
                  isSelected?.(t.index)
                    ? "bg-sol-violet/10 ring-1 ring-inset ring-sol-violet/40"
                    : "hover:bg-sol-bg-alt/40"
                }`
              : ""
          }`}
        >
          <div className={`text-[11px] font-medium ${speakerColor(t.speaker_id)}`}>
            {firstName(t.speaker_name)}
            <span className="ml-2 font-normal text-sol-text-dim">{fmtClock(t.t0)}</span>
          </div>
          {t.segments.map((s) => (
            <p key={s.seq} className="text-[13px] leading-relaxed text-sol-text">
              {s.text}
            </p>
          ))}
        </div>
      ))}
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
            <TranscriptTurnList turns={turns} />
          )}
        </div>
      )}
    </div>
  );
}

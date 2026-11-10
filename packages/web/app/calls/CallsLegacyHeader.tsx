// The Calls page's own headers, kept for Classic and Minimal (Modern draws
// components/ui/page-header). The controls come from the page, built once, so
// both styles press the same thing.
import type { ReactNode } from "react";
import { Link2, Mic, PanelLeftClose, PhoneCall, Sparkles } from "lucide-react";
import { GuestInvite } from "../../components/calls/GuestDoor";

/** The list column's head: its name, the hide-list press, the record buttons. */
export function CallsListLegacyHead({ onHide, records, huddlesOff }: { onHide?: () => void; records: ReactNode; huddlesOff: ReactNode }) {
  return (
            <div className="shrink-0 border-b border-sol-border/20 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-sol-text" title="Huddles with their transcripts and video, and voice notes. Your agents can read them too.">Calls</h2>
                {onHide && (
                  <button
                    type="button"
                    onClick={onHide}
                    title="Hide the list"
                    aria-label="Hide the list"
                    className="rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-bg-alt hover:text-sol-text"
                  >
                    <PanelLeftClose className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {records}
              {huddlesOff}
            </div>
  );
}

/** A call's header while its record loads: the title, or a bar where it goes. */
export function CallSkeletonLegacyHead({ lead, title, bar, meta }: { lead?: ReactNode; title?: string; bar: string; meta: ReactNode }) {
  return (
      <div className="shrink-0 border-b border-sol-border/20 px-6 py-4">
        <div className="flex items-center gap-2.5">
          {lead}
          {title ? (
            <h1 className="min-w-0 line-clamp-2 text-[17px] font-medium leading-snug text-sol-text">{title}</h1>
          ) : (
            <div className={`${bar} h-[22px] w-72 max-w-full`} />
          )}
        </div>
        <div className="mt-2 flex items-center gap-3 text-[12px] text-sol-text-dim">
          {meta}
        </div>
      </div>
  );
}

/** A call's header: what this call was, who spoke, the ways in. */
export function CallLegacyHeader({ lead, recording, title, marks, meta, del, share, guestRoom, onJoin, onSend }: {
  lead?: ReactNode;
  recording: boolean;
  title: string;
  /** LIVE / RECORDING and the room's filmed mark. */
  marks: ReactNode;
  /** When, how long, video, scope, the mic, who spoke, the sessions it feeds. */
  meta: ReactNode;
  del: ReactNode;
  share: ReactNode;
  /** The live room a guest can be invited to. */
  guestRoom: string | null;
  onJoin: (() => void) | null;
  onSend: (() => void) | null;
}) {
  return (
      <div className="shrink-0 border-b border-sol-border/20 px-6 py-4">
        <div className="flex items-center gap-2.5">
          {lead}
          {recording && <Mic className="h-4 w-4 shrink-0 text-sol-text-dim" />}
          <h1 className="min-w-0 line-clamp-2 text-[17px] font-medium leading-snug text-sol-text">
            {title}
          </h1>
          {marks}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-sol-text-dim">
          {meta}
          <span className="flex-1" />
          {del}
          {share}
          {/* Bring in somebody from outside the team while it is happening:
              the same link and panel as the stage's door group. */}
          {guestRoom && (
            <GuestInvite
              roomKey={guestRoom}
              align="end"
              trigger={({ open, toggle }) => (
                <button
                  onClick={toggle}
                  aria-expanded={open}
                  className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-sol-yellow transition-colors ${
                    open ? "bg-sol-yellow/20" : "bg-sol-yellow/10 hover:bg-sol-yellow/20"
                  }`}
                  title="Invite someone outside the team: a link they join from in a browser, no account"
                >
                  <Link2 className="h-3.5 w-3.5" /> Invite guest
                </button>
              )}
            />
          )}
          {onJoin && (
            <button
              onClick={onJoin}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-sol-green/15 px-3 py-1.5 text-xs font-medium text-sol-green transition-colors hover:bg-sol-green/25"
            >
              <PhoneCall className="h-3.5 w-3.5" /> Join
            </button>
          )}
          {/* Nothing to send until a word was said; on a live call the
              button appears with the first turn. */}
          {onSend && (
            <button
              onClick={onSend}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-sol-violet/15 px-3 py-1.5 text-xs font-medium text-sol-violet transition-colors hover:bg-sol-violet/25"
              title="Send the whole transcript to an agent session or doc"
            >
              <Sparkles className="h-3.5 w-3.5" /> Send to agent
            </button>
          )}
        </div>
      </div>
  );
}

// The huddle thread's rows, one component per kind: a spoken passage, the
// recap, an event line (who came and went), a typed or agent line. Props only;
// RoomThread owns the reads and the writes and lays these out in time order.

import { useState } from "react";
import { Captions, CaptionsOff, ChevronRight, ListChecks, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { ChatAttachments } from "../chat/ChatMessage";
import { MESSAGE_MD_COMPONENTS, MESSAGE_MD_REHYPE, USER_MD_REMARK } from "../messageMarkdown";
import { EntityAwareLink } from "../EntityIdPill";
import { PublishedPagePill } from "../PublishedPageEmbed";
import { pageShareUrl } from "../../lib/publishedPageUrls";
import { fmtClock as fmtWallClock, fmtDuration } from "../triggerCadence";
import { CrossfadeText } from "../SessionActivityLine";
import { prefersReducedMotion } from "../../hooks/useBottomAnchoredList";
import { Avatar } from "./Avatar";
import { SessionFace } from "../identity";
import { TranscriptTurnList } from "./TranscriptTurns";
import { CallLinkButton } from "./CallLinkButton";
import { turnsAnchor } from "./transcriptTurnModel";
import { firstName, fmtClock, speakerColor } from "./speakers";
import { HEARS, type EventRow, type Passage, type ThreadRow } from "./roomThreadModel";
import "../chat/chat.css";
import "./roomThread.css";

/** A thread row as the thread renders it: a sent line is pending until it lands. */
export type LocalRow = ThreadRow & { pending?: boolean };

export type RoomThreadSelection = {
  isSelected: (index: number) => boolean;
  onTurnClick: (index: number, e: React.MouseEvent) => void;
  activeIndex?: number | null;
  /** A line under the recap that says how selecting works, until a turn is chosen. */
  hint?: string | null;
};

/** A body that folds with motion both ways: a grid row that goes from 0fr to
 *  1fr and back over 200ms. The row itself is always mounted, so opening has
 *  something to transition from; the body stays mounted through the close
 *  and leaves when the transition ends. With reduced motion there is no
 *  transition to wait for, so the body leaves at once. */
export function Fold({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [wasOpen, setWasOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    setClosing(!open && !prefersReducedMotion());
  }
  return (
    <div
      className="rt-fold"
      data-open={open}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget) setClosing(false);
      }}
    >
      <div className="rt-fold-in">{(open || closing) && children}</div>
    </div>
  );
}

export function PassageBlock({
  passage,
  idPrefix,
  open,
  live,
  fresh,
  recording,
  dayOf,
  onToggle,
  selection,
  callId,
}: {
  passage: Passage;
  /** Per thread instance: the stage rail and the call page can both be mounted. */
  idPrefix: string;
  open: boolean;
  /** The newest passage of a live call: it reads like captions, not history. */
  live: boolean;
  /** Began after the thread mounted: it rises in like any other new row. */
  fresh: boolean;
  recording: boolean;
  /** The call's start: a wall clock on the same day drops its date. */
  dayOf: number | undefined;
  onToggle: () => void;
  selection?: RoomThreadSelection;
  /** The call the passage belongs to: its turns and its head offer links. */
  callId?: string;
}) {
  const units = recording ? "line" : "turn";
  const n = passage.turns.length;
  const bodyId = `${idPrefix}p${passage.index}`;
  const className = `rt-passage${open ? " rt-passage-open" : ""}${live ? " rt-passage-live" : ""}${fresh ? " rt-in" : ""}`;
  // One turn of a huddle: its row already carries the name and the clock,
  // so a head over it would say the same twice and outweigh the words.
  // The rule stays, so it still reads as spoken.
  if (!recording && n === 1) {
    return (
      <section className={className}>
        <div className="rt-passage-body">
          <TranscriptTurnList
            turns={passage.turns}
            isSelected={selection?.isSelected}
            onTurnClick={selection?.onTurnClick}
            activeIndex={selection?.activeIndex ?? null}
            callId={callId}
          />
        </div>
      </section>
    );
  }
  const anchor = callId ? turnsAnchor(passage.turns) : null;
  return (
    <section className={className}>
      <div className="group flex items-baseline">
      <button
        type="button"
        className="rt-passage-head"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
        title={`${open ? "Fold" : "Open"} this passage · ${n} ${units}${n === 1 ? "" : "s"}`}
      >
        <ChevronRight className="rt-chevron h-3 w-3" aria-hidden="true" />
        <span className="rt-passage-who">
          {recording ? (
            <span className="text-sol-text-muted">Spoken</span>
          ) : (
            passage.speakers.map((sp, i) => (
              <span key={sp.id} className={speakerColor(sp.id)}>
                {firstName(sp.name)}
                {i < passage.speakers.length - 1 ? ", " : ""}
              </span>
            ))
          )}
        </span>
        <span className="rt-when">
          {/* A huddle's head keeps the wall clock the typed and event rows
              use, so one thread has one clock; the turn rows inside read as
              the offset into the call. A recording keeps the offset, since a
              click seeks the audio by it. */}
          {recording ? fmtClock(passage.t0) : fmtWallClock(passage.at, dayOf)} · {fmtDuration(Math.max(1000, passage.t1 - passage.t0))}
          {/* The count leaves the head on the stage (roomThread.css): the
              names need the room more, and the title carries it. */}
          <span className="rt-passage-turns">
            {" "}· {n} {units}
            {n === 1 ? "" : "s"}
          </span>
        </span>
        {!open && <span className="rt-passage-preview">{passage.preview}</span>}
      </button>
      {anchor && <CallLinkButton callId={callId!} anchor={anchor} title="Copy a link to this passage" className="ml-1" />}
      </div>
      <Fold open={open}>
        <div id={bodyId} className="rt-passage-body">
          <TranscriptTurnList
            turns={passage.turns}
            isSelected={selection?.isSelected}
            onTurnClick={selection?.onTurnClick}
            compact={recording}
            activeIndex={selection?.activeIndex ?? null}
            callId={callId}
          />
        </div>
      </Fold>
    </section>
  );
}

// ── The recap so far ───────────────────────────────────────────────────────

/** Up to the first end of sentence: a period, question or exclamation mark
 *  followed by a space or the end, so "3.5 million" does not end one. */
function firstSentence(text: string): string {
  const m = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : text).trim();
}

export function RecapCard({
  summary,
  items,
  live,
  callId,
  focus,
}: {
  summary: string;
  items: string[];
  live: boolean;
  /** The call the recap belongs to: the summary and each item offer links. */
  callId?: string;
  /** A link landed on the summary or on one item: the recap opens for it. */
  focus?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (focus && focus !== openedFor) {
    setOpenedFor(focus);
    setOpen(true);
  }
  const label = live ? "So far" : "Summary";
  return (
    <section className={`rt-recap${open ? " rt-recap-open" : ""}`}>
      <button
        type="button"
        className="rt-recap-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={open ? "Fold the recap" : live ? "What has been said so far, in a few lines" : "The summary and the action items"}
      >
        <ChevronRight className="rt-chevron h-3 w-3" aria-hidden="true" />
        <span className="rt-recap-label">
          <Sparkles className="h-3 w-3" />
          {label}
        </span>
        {/* The sentence regenerates every 90 s while the call runs; the old
            one fades out under the new so words never swap mid read. */}
        {!open && <CrossfadeText text={firstSentence(summary)} className="rt-recap-line" />}
      </button>
      <Fold open={open}>
        <div className="rt-recap-body">
          <p className="group" data-call-anchor="summary">
            {summary}
            {callId && (
              <CallLinkButton callId={callId} anchor={{ kind: "summary" }} title="Copy a link to the summary" className="ml-1 align-middle" />
            )}
          </p>
          {items.length > 0 && (
            <div className="rt-recap-items">
              <div className="rt-recap-items-label">
                <ListChecks className="h-3 w-3" /> Action items
              </div>
              <ul>
                {items.map((a, i) => (
                  <li key={i} className="group" data-call-anchor={`action-${i}`}>
                    <span className="text-sol-violet">→</span>
                    <span>
                      {a}
                      {callId && (
                        <CallLinkButton
                          callId={callId}
                          anchor={{ kind: "action", index: i }}
                          title="Copy a link to this action item"
                          className="ml-1 align-middle"
                        />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Fold>
    </section>
  );
}

// ── Who came and went ──────────────────────────────────────────────────────

export function EventLine({
  row,
  me,
  ownRoomId,
  ended,
  explain,
  fresh,
  dayOf,
  onOpen,
}: {
  row: EventRow;
  me: string | null;
  ownRoomId: string | null;
  /** The call is over: what an agent did is in the past. */
  ended: boolean;
  /** Say what an agent does here; once per call, on the first agent event. */
  explain: boolean;
  /** Landed after the thread mounted: it rises in. */
  fresh: boolean;
  dayOf: number | undefined;
  onOpen: (id: string) => void;
}) {
  const actor = me && row.user_id === me ? "You" : firstName(row.user_name);
  const agent = row.agent;
  const name = agent ? (
    <button type="button" className="rt-event-agent" onClick={() => onOpen(agent.conversation_id)} title={`Open ${agent.title}`}>
      {agent.name ?? agent.title}
    </button>
  ) : (
    <span className="rt-event-agent">an agent</span>
  );
  // The room's own agent is not somebody's guest: it was in the room before
  // anyone, so the line says it is here rather than who brought it.
  const ownRoom = !!agent && !!ownRoomId && (agent.conversation_id === ownRoomId || agent.short_id === ownRoomId);
  const Glyph = row.event === "transcribe_off" ? CaptionsOff : row.event === "transcribe_on" ? Captions : Sparkles;
  // On and joined keep their accents; off and left go dim, as an ended thing should.
  const tone =
    row.event === "transcribe_on" ? "text-sol-green" : row.event === "agent_joined" ? "text-sol-violet" : "text-sol-text-dim";
  return (
    <div className={`rt-event${fresh ? " rt-in" : ""}`} role="note">
      <span className="rt-event-glyph flex w-5 shrink-0 justify-center" aria-hidden="true">
        <Glyph className={`h-3 w-3 ${tone}`} />
      </span>
      <span className="min-w-0 flex-1">
        {row.event === "agent_joined" ? (
          <>
            {ownRoom ? (
              <>
                {name} {ended ? "was" : "is"} in the room
              </>
            ) : (
              <>
                {actor} added {name}
              </>
            )}
            {explain ? ` · it ${HEARS}` : ""}
          </>
        ) : row.event === "agent_left" ? (
          <>{name} left the room</>
        ) : (
          <>
            {actor} switched transcription {row.event === "transcribe_on" ? "on" : "off"}
          </>
        )}
      </span>
      <span className="rt-when rt-event-when">{fmtWallClock(row.at, dayOf)}</span>
    </div>
  );
}

// ── Typed lines and agent answers ──────────────────────────────────────────

/** The stage rail is 340px wide, so a page link typed on a line of its own
 *  is the titled pill there, not the 420px card that would fill the rail
 *  from header to composer. The card's text is how remarkEntityIds hands
 *  the link over: "embed:artifact:<slug>|<caption>" (see EntityAwareLink). */
function StageLink({ children, ...props }: any) {
  const text = typeof children === "string" ? children : Array.isArray(children) ? children.map(String).join("") : String(children ?? "");
  const m = /^embed:artifact:([^|]+)(?:\|([\s\S]*))?$/.exec(text);
  if (m) return <PublishedPagePill slug={m[1]} href={pageShareUrl(m[1])} label={m[2] || undefined} />;
  return <EntityAwareLink {...props}>{children}</EntityAwareLink>;
}
const STAGE_MD_COMPONENTS = { ...MESSAGE_MD_COMPONENTS, a: StageLink };

export function ChatLine({
  m,
  sameAuthor,
  fresh,
  dayOf,
  stage,
  onOpen,
}: {
  m: LocalRow;
  sameAuthor: boolean;
  /** Landed after the thread mounted: it rises in. */
  fresh: boolean;
  dayOf: number | undefined;
  /** In the rail: a page link is a pill, not a card. */
  stage: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <div className={`rt-line${sameAuthor ? " rt-line-cont" : ""}${fresh ? " rt-in" : ""}`}>
      <span className="w-5 shrink-0 pt-0.5">
        {!sameAuthor &&
          (m.agent ? (
            // The agent's face (session-characters.md S3): the character the
            // room addresses, the same face its session wears everywhere.
            <SessionFace
              row={{
                _id: m.agent.conversation_id,
                title: m.agent.title,
                character_avatar: m.agent.character_avatar ?? null,
                character_name: m.agent.character_name ?? null,
              }}
              size={20}
              className="shrink-0"
            />
          ) : (
            <Avatar m={{ user_image: m.user_image, user_name: m.user_name }} size={20} />
          ))}
      </span>
      <div className="min-w-0 flex-1">
        {!sameAuthor && (
          <div className="mb-0.5 flex items-baseline gap-1.5">
            {m.agent ? (
              <button
                type="button"
                onClick={() => onOpen(m.agent!.conversation_id)}
                className="rt-name max-w-[200px] truncate text-sol-violet hover:underline"
                title={`Open ${m.agent.title}`}
              >
                {m.agent.name ?? m.agent.title}
              </button>
            ) : (
              <span className="rt-name text-sol-text">{m.mine ? "you" : firstName(m.user_name)}</span>
            )}
            <span className="rt-when">{fmtWallClock(m.at, dayOf)}</span>
          </div>
        )}
        {m.text ? (
          // A human's line is typed text (a pasted link, a newline), an
          // agent's is prose with the odd list: the same pipeline renders
          // both, so a link is a link whoever typed it.
          <div className={`rt-line-body rt-md break-words ${m.pending ? "text-sol-text-muted" : "text-sol-text"}`}>
            <ReactMarkdown
              remarkPlugins={USER_MD_REMARK}
              rehypePlugins={MESSAGE_MD_REHYPE}
              components={stage ? STAGE_MD_COMPONENTS : MESSAGE_MD_COMPONENTS}
            >
              {m.text}
            </ReactMarkdown>
          </div>
        ) : null}
        {(m.attachments?.length ?? 0) > 0 && <ChatAttachments messageId={m._id} attachments={m.attachments as any} />}
      </div>
    </div>
  );
}

import { Fragment, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AlignLeft,
  Captions,
  CaptionsOff,
  ChevronRight,
  ChevronsDownUp,
  ExternalLink,
  EyeOff,
  ImagePlus,
  ListChecks,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useMutation } from "convex/react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  humanizeConvexError,
  isRecRoomKey,
  sessionRoomConversationId,
} from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { navigateMainWindow } from "../../lib/desktop";
import { settleComposerAttachments } from "../../lib/draftImages";
import { getRoom, startTranscribing } from "../../lib/calls/callManager";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useConversationFileDrop } from "../../hooks/useConversationFileDrop";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { MessageInput } from "../MessageInput";
import { ChatAttachments } from "../chat/ChatMessage";
import { MESSAGE_MD_COMPONENTS, MESSAGE_MD_REHYPE, USER_MD_REMARK } from "../messageMarkdown";
import { EntityAwareLink } from "../EntityIdPill";
import { PublishedPagePill } from "../PublishedPageEmbed";
import { pageShareUrl } from "../../lib/publishedPageUrls";
import type { ChatAttachment } from "../../store/chatSlice";
import { fmtClock as fmtWallClock, fmtDuration } from "../triggerCadence";
import { CrossfadeText, LivePulseDot } from "../SessionActivityLine";
import { prefersReducedMotion } from "../../hooks/useBottomAnchoredList";
import { Avatar } from "./Avatar";
import { FeedChip } from "./FeedChip";
import { SessionFace } from "../identity";
import { TranscribeSwitch } from "./TranscribePanel";
import { TranscriptTurnList } from "./TranscriptTurns";
import { openFeedTargetPicker, useAddLiveFeed, useAgentsInRoom, useRemoveLiveFeed, type FeedTarget } from "./useCallFeed";
import { firstName, fmtClock, speakerColor } from "./speakers";
import {
  PASSAGE_PREVIEW_CHARS,
  buildPassages,
  clip,
  mergeTimeline,
  type EventRow,
  type Passage,
  type ThreadRow,
  type TranscriptSegment,
} from "./roomThreadModel";
import "../chat/chat.css";
import "./roomThread.css";

// THE HUDDLE HAS ONE THREAD. Everything that happens in a room lands here in
// time order: what people SAID (the transcript, folded into passages so it
// never buries the rest), what people TYPED (chat lines, with images), what
// an AGENT answered (its reply rows), and who came and went (an agent added
// or removed, transcription switched on or off).
//
// One component, two places. The call stage renders it in a rail while the
// huddle runs; the call page renders it as the main column, live or after
// the fact. The parent owns the reads: `call` is transcripts.webGetCall
// (segments, summary, routes, status) and `rows` is callChat.list, so the
// stage can count unread lines from the same subscription and the call page
// can select turns by the same indices this thread renders. The thread
// itself only writes (post a line, add or remove a feed).
//
// Spoken and typed read apart at a glance without tabs: a passage is a quiet
// block behind a thin rule in dimmer, smaller text; a typed line is the chat
// row (avatar, name, time); an agent's line keeps its violet icon, the link
// to its session and a markdown body. The newest passage stays open while
// the call is live and follows the words, so it does the captions' job.

export type RoomThreadRoute = { kind: string; target: string; mode: string; added_by: string };

/** What the thread reads of transcripts.webGetCall. */
export type RoomThreadCall = {
  _id: string;
  status: string;
  started_at: number;
  segments: TranscriptSegment[];
  summary: string | null;
  action_items: string[];
  summary_status?: string | null;
  routes: RoomThreadRoute[];
};

export type RoomThreadSelection = {
  isSelected: (index: number) => boolean;
  onTurnClick: (index: number, e: React.MouseEvent) => void;
  activeIndex?: number | null;
  /** A line under the recap that says how selecting works, until a turn is chosen. */
  hint?: string | null;
};

type Density = "folded" | "full" | "hidden";
type Surface = "stage" | "page";

const DENSITY_KEY = (surface: Surface) => `codecast.roomThread.words.${surface}`;

function readDensity(surface: Surface): Density {
  try {
    const v = window.localStorage.getItem(DENSITY_KEY(surface));
    if (v === "folded" || v === "full" || v === "hidden") return v;
  } catch {
    /* no storage: the default below */
  }
  return surface === "page" ? "full" : "folded";
}

/** The one promise the thread makes about an agent, worded once: on the
 *  Add button, in the empty card, on the event line and in the picker. */
const HEARS = "hears the room and answers here";
const ADD_AGENT_TITLE = `Add an agent: it ${HEARS}`;

function echoKey(text: string, attachments?: { storage_id: string }[] | null): string {
  return `${text}\0${(attachments ?? []).map((a) => a.storage_id).join(",")}`;
}

type LocalRow = ThreadRow & { pending?: boolean };

export function RoomThread({
  roomKey,
  call,
  rows,
  liveTranscriptId,
  surface,
  seated,
  panel,
  selection,
  className,
}: {
  roomKey: string;
  /** transcripts.webGetCall for this room's transcript: undefined while it loads, null when there is none. */
  call: RoomThreadCall | null | undefined;
  /** callChat.list for this room, read by the parent. */
  rows: ThreadRow[] | null | undefined;
  /** The transcript a feed attaches to, while one is live. */
  liveTranscriptId: string | null;
  surface: Surface;
  /** The viewer is connected in this room: the transcription switch and the transcribe button work. */
  seated: boolean;
  /** The desktop call window: links to a session open in the main window. */
  panel?: boolean;
  selection?: RoomThreadSelection;
  className?: string;
}) {
  const recording = isRecRoomKey(roomKey);
  const transcribing = !!liveTranscriptId;
  const ended = !!call && call.status !== "live";
  const post = useMutation(api.callChat.post);
  const [pending, setPending] = useState<Array<{ key: string; text: string; attachments: ChatAttachment[]; at: number }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the tail while the call is live (the newest words are the point);
  // an ended call opens at the top, where the recap is. The stage only shows
  // the rail during a live huddle, so it always starts at the bottom, even
  // before the first word is transcribed.
  const stuckRef = useRef(surface === "stage" || (!!call && call.status === "live"));
  useWatchEffect(() => {
    // A rail that watched transcription start follows the new passage.
    if (liveTranscriptId) stuckRef.current = true;
  }, [liveTranscriptId]);
  // Images land anywhere on the thread; the composer's strip is where they
  // go (MessageInput installs the handler on dropFilesRef).
  const {
    dropFilesRef,
    isDragging: dragging,
    handleDragEnter: onDragEnter,
    handleDragOver: onDragOver,
    handleDragLeave: onDragLeave,
    handleDrop: onDrop,
  } = useConversationFileDrop();
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const idPrefix = useId();
  const draftKey = `huddle:${roomKey}`;
  const mentionTeamId = useInboxStore((s: any) => s.clientState?.ui?.active_team_id as string | undefined);
  const myUserId = useInboxStore((s: any) => s.currentUser?._id?.toString?.() ?? null);
  // The room's opt-out (liveRooms): "off" because somebody switched it off
  // reads differently from "nobody has started yet".
  const switchedOff = useInboxStore(
    (s: any) => !!(s.liveRooms as any[] | undefined)?.find((r) => r.room_key === roomKey)?.transcribe_off,
  );
  const scribeError = useSyncExternalStore(subscribeScribe, () => getScribeStatus().error, () => null);

  const [storedDensity, setDensityState] = useState<Density>(() => readDensity(surface));
  // A recording is only spoken words and has no density control, so the
  // page's stored choice never applies to it: "hidden" would blank the page
  // and "folded" would leave every passage a preview with no way to unfold.
  const density: Density = recording ? "full" : storedDensity;
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const setDensity = (d: Density) => {
    setDensityState(d);
    setOverrides({});
    try {
      window.localStorage.setItem(DENSITY_KEY(surface), d);
    } catch {
      /* the choice lasts the session */
    }
  };

  const chatRows = useMemo<LocalRow[]>(() => {
    const server: ThreadRow[] = recording ? [] : rows ?? [];
    // A pending row retires once the server echoes a row of mine with the
    // same text and the same attached storage ids (image-only lines have
    // empty text, so text alone would retire the wrong row).
    const echoed = new Set(server.filter((r) => r.mine && !r.event).map((r) => echoKey(r.text, r.attachments)));
    const stillPending = pending.filter((p) => !echoed.has(echoKey(p.text, p.attachments)));
    return [
      ...server,
      ...stillPending.map<LocalRow>((p) => ({
        _id: p.key,
        user_id: myUserId ?? "",
        user_name: "you",
        user_image: undefined,
        text: p.text,
        attachments: p.attachments,
        at: p.at,
        mine: true,
        pending: true,
        agent: null,
      })),
    ];
  }, [rows, pending, recording, myUserId]);

  const segments = call?.segments;
  // Only rows the server has echoed split passages: the call page builds its
  // flat turn list from the same server rows, and a pending row's client
  // clock would move the indices under a selection until the echo landed.
  const breakAts = useMemo(() => chatRows.filter((r) => !r.pending).map((r) => r.at), [chatRows]);
  const passages = useMemo(() => buildPassages(segments ?? [], breakAts, { recording }), [segments, breakAts, recording]);
  const startedAt = call?.started_at;
  // An event row is the room's log for one call: an agent that came and went
  // in an earlier call is not "earlier in this room", it is over. With no
  // call to anchor on (the stage before transcription starts, or after it
  // was switched off) every event is an earlier call's, so none shows. Typed
  // and agent lines from earlier calls stay, set apart by the divider below.
  const visibleRows = useMemo(
    () => chatRows.filter((r) => !r.event || (startedAt !== undefined && r.at >= startedAt)),
    [chatRows, startedAt],
  );
  const timeline = useMemo(() => mergeTimeline(passages, visibleRows), [passages, visibleRows]);

  const routes = call?.routes ?? [];
  // After the call the routes are history: the chips still say who was in
  // the room (roster), but nobody hears a line typed now and nobody is
  // working on it (agents).
  const roster = useAgentsInRoom(routes);
  const agents = transcribing ? roster : [];
  const working = agents.filter((a) => a.working);
  const ownRoomId = sessionRoomConversationId(roomKey);

  const addFeed = useAddLiveFeed({ roomKey, liveTranscriptId, routes, getRoom });
  const removeFeed = useRemoveLiveFeed(liveTranscriptId);
  // addRoute/startScribe can refuse (room authorization, ended transcript);
  // a silent close-and-nothing is the one wrong outcome.
  const onPickFeed = (t: FeedTarget) =>
    void addFeed(t).catch((err: any) => toast.error(humanizeConvexError(err, "Could not add the agent")));
  const openAddAgent = () =>
    openFeedTargetPicker({ title: "Add an agent to the room", gesture: "feed", showSlack: true, onPick: onPickFeed });
  // The explanation of what an agent does is said once per call, on the
  // first agent event of this call; the later ones just say who came.
  const explainEventId = chatRows.find((r) => r.event === "agent_joined" && r.at >= (startedAt ?? 0))?._id;
  const transcribeAlone = () =>
    void startTranscribing(roomKey).then((ok) => {
      if (!ok) toast.error("Somebody else is transcribing this huddle already");
    });

  // Adding is allowed while a live feed could attach: on the stage whenever
  // the huddle runs (adding starts transcription when nobody is scribing),
  // on the page only while the call is live. A recording has no room to add
  // anyone to, and an ended call has nothing to attach to.
  const canAdd = !recording && !ended && (surface === "stage" || transcribing);
  const canRemove = transcribing;

  // Follow the tail while the reader is at the bottom; a reader who scrolled
  // up to quote something keeps their place, and a count of what landed
  // below the fold meanwhile shows on a pill (team chat's), so a new line
  // never arrives in silence.
  const [behind, setBehind] = useState(0);
  const lastLenRef = useRef(timeline.length);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (stuckRef.current) setBehind((b) => (b ? 0 : b));
  };
  const scrollToEnd = (el: HTMLDivElement, smooth: boolean) => {
    // Smooth over a short distance, a jump over a long one: a stuck reader
    // never watches a long animated scroll, and a smooth scroll never
    // crosses the 160px line that onScroll reads as "scrolled away".
    const delta = el.scrollHeight - el.clientHeight - el.scrollTop;
    const behavior = smooth && delta > 0 && delta < 160 && !prefersReducedMotion() ? "smooth" : "auto";
    // The test DOM has no scrollTo.
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior });
    else el.scrollTop = el.scrollHeight;
  };
  const lastPassage = passages[passages.length - 1];
  const tailSize = lastPassage?.segments.length ?? 0;
  useWatchEffect(() => {
    const el = scrollRef.current;
    const grew = timeline.length - lastLenRef.current;
    const hadRows = lastLenRef.current > 0;
    lastLenRef.current = timeline.length;
    if (el && stuckRef.current) scrollToEnd(el, true);
    // Only a live room lands lines below a reader who scrolled up; the first
    // load of a call, and the page of an ended one, is history, not news.
    else if (grew > 0 && hadRows && !ended) setBehind((b) => b + grew);
  }, [timeline.length, tailSize, working.length]);
  // A fold that opens or closes changes the list's height over 200ms; a
  // stuck reader stays at the end when it settles.
  const onFoldSettled = (e: React.TransitionEvent) => {
    const el = scrollRef.current;
    if (el && stuckRef.current && e.propertyName === "grid-template-rows") scrollToEnd(el, false);
  };
  const jumpToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    stuckRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    setBehind(0);
  };
  // Rows that arrive after the thread mounted rise in; opening the rail does
  // not animate the whole history.
  const mountedAt = useRef(Date.now());

  const send = (body: string, attachments: ChatAttachment[]) => {
    if (!body && attachments.length === 0) return;
    const key = `p:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    setPending((p) => [...p, { key, text: body, attachments, at: Date.now() }]);
    stuckRef.current = true;
    void post({
      room_key: roomKey,
      text: body,
      attachments: attachments.length
        ? attachments.map((a) => ({
            storage_id: a.storage_id as Id<"_storage">,
            mime: a.mime,
            name: a.name,
            width: a.width,
            height: a.height,
          }))
        : undefined,
    }).catch(() => {
      setPending((p) => p.filter((x) => x.key !== key));
    });
  };

  const openSession = (id: string) => {
    if (panel) return void navigateMainWindow(`/conversation/${id}`);
    useInboxStore.getState().openSidePanel(id);
  };

  const composer = !recording;
  // The stage's box holds about 45 characters a line: room for the promise
  // that an agent hears a typed line, not for a long title; the page has
  // room to name the agent.
  const placeholder =
    surface === "stage"
      ? agents.length === 1
        ? "Message the room · the agent hears you"
        : agents.length > 1
          ? "Message the room · the agents hear you"
          : "Message the room"
      : agents.length === 1
        ? `Message the room · ${clip(agents[0].name, 22)} hears you`
        : agents.length > 1
          ? "Message the room · the agents hear you"
          : "Message the room";

  const newestIndex = passages.length - 1;
  const activeIndex = selection?.activeIndex ?? null;
  const isOpen = (p: Passage) =>
    (activeIndex !== null && p.turns.some((t) => t.index === activeIndex)) ||
    (overrides[p.index] ?? (density === "full" || (transcribing && p.index === newestIndex)));
  const toggle = (p: Passage) => {
    const opening = !isOpen(p);
    // Opening history pushes the tail down without a scroll event; a reader
    // who did that is reading, not following.
    if (opening && p.index !== newestIndex) stuckRef.current = false;
    setOverrides((o) => ({ ...o, [p.index]: opening }));
  };

  // Event rows are the room's log, not its content: a room that has only
  // ever seen agents come and go is still empty.
  const empty = passages.length === 0 && chatRows.every((r) => r.event);
  const showChips = routes.length > 0;
  // Nothing to fold, open or hide until someone has spoken.
  const showDensity = !recording && passages.length > 0;
  const showSwitch = seated && !recording;
  const showHead = showChips || canAdd || showDensity || showSwitch;
  // Only the density control: no band, no rule, it sits with the recap row.
  const quietHead = showHead && !showChips && !canAdd && !showSwitch;
  // The empty card leads while nobody is in the room; the header's own Add
  // button would be the same call twice, so it steps aside for the card.
  const emptyCard = empty && !recording && !ended && agents.length === 0;
  // The pinned line is about the silence since transcription started, not
  // about the room's history: a typed line from earlier does not say the
  // room is being listened to now.
  const listening = transcribing && !recording && passages.length === 0 && density !== "hidden" && agents.length > 0;
  const spokenHidden = density === "hidden" && passages.length > 0;
  // "Earlier in this room": the chat outlives one call, so rows before this
  // call started are set apart from it.
  const earlier = startedAt !== undefined ? timeline.filter((i) => i.at < startedAt).length : 0;

  return (
    <div
      className={`rt flex min-h-0 flex-col ${className ?? ""}`}
      data-surface={surface}
      onDragEnter={composer ? onDragEnter : undefined}
      onDragLeave={composer ? onDragLeave : undefined}
      onDragOver={composer ? onDragOver : undefined}
      onDrop={composer ? onDrop : undefined}
    >
      {dragging && (
        <div className="ch-drop-overlay" aria-hidden="true">
          <div className="ch-drop-card">Drop images to attach</div>
        </div>
      )}

      {/* The header: who is in the thread, the way to add an agent, how
          much of the spoken words to show, and the transcription switch.
          Nothing to show, no band. */}
      {showHead && (
        <div className={`rt-head${quietHead ? " rt-head-quiet" : ""}`}>
          {routes.map((r) => {
            const agent = r.kind === "session" ? roster.find((a) => a.target === r.target) : null;
            return (
              <span
                key={`${r.kind}:${r.target}`}
                className="rt-chip"
                title={agent ? `An agent in the room: it ${HEARS}. The arrow opens its session.` : undefined}
              >
                <FeedChip
                  route={r}
                  label={agent?.name}
                  removable={canRemove && !!myUserId && r.added_by === myUserId}
                  onRemove={() => void removeFeed(r.kind, r.target)}
                />
                {agent?.working && transcribing && (
                  <WorkingDots className="text-sol-violet" title={`${agent.name} is working`} />
                )}
                {agent && (
                  <button
                    type="button"
                    onClick={() => openSession(agent.id)}
                    className="rounded p-0.5 text-sol-text-dim transition-colors hover:text-sol-text"
                    title="Open the agent's session"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                )}
              </span>
            );
          })}
          {canAdd && !emptyCard && (
            <button type="button" onClick={openAddAgent} className="rt-add" title={ADD_AGENT_TITLE}>
              <Sparkles className="h-3 w-3" />
              Add an agent
            </button>
          )}
          <span className="rt-head-right">
            {showDensity && <DensityControl value={density} onChange={setDensity} />}
            {showSwitch && <TranscribeSwitch live={transcribing} />}
          </span>
        </div>
      )}

      {/* The room is being transcribed and nothing has been said yet: one
          status line pinned under the header, not a row in the timeline. The
          empty card below already says it when nobody is in the room. */}
      {listening && (
        <p className="rt-note rt-listening">
          <LivePulseDot className="h-1.5 w-1.5" />
          {scribeError ?? "Listening. Words appear here as people speak."}
        </p>
      )}

      {/* What people said is content; the stage around this thread is chrome
          and turns selection off, so the list turns it back on. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onTransitionEnd={onFoldSettled}
        className="rt-list min-h-0 flex-1 select-text overflow-y-auto"
      >
        {call?.summary ? (
          <RecapCard summary={call.summary} items={call.action_items ?? []} live={!ended} />
        ) : ended && !recording && !(empty && call.summary_status === "skipped") ? (
          // An empty call says "Nothing was said." below; "Too short to
          // summarize." would be the same fact on a second line.
          <p className="rt-note">
            {call.summary_status === "skipped"
              ? "Too short to summarize."
              : call.summary_status === "failed"
                ? "Summary generation failed."
                : "Summary pending…"}
          </p>
        ) : null}

        {/* How selecting works: one quiet line after the recap, before the
            first turn it explains, and only while a turn is open to click. */}
        {selection?.hint && density !== "hidden" && passages.some(isOpen) && <p className="rt-hint">{selection.hint}</p>}

        {spokenHidden && (
          <p className="rt-note">
            Spoken words hidden · {passages.length} passage{passages.length === 1 ? "" : "s"}{" "}
            <button type="button" className="rt-note-btn" onClick={() => setDensity("full")} title="Show every spoken word">
              show them
            </button>
          </p>
        )}

        {empty &&
          (recording ? (
            <p className="rt-note">
              {transcribing
                ? "Listening. The transcript appears as people speak. Your microphone hears the room."
                : "Nothing was transcribed."}
            </p>
          ) : ended ? (
            <p className="rt-note">Nothing was said.</p>
          ) : !emptyCard ? null : (
            <div className="rt-empty">
              <p>
                {switchedOff
                  ? "Transcription is off for this huddle. Add an agent, or switch it back on, and what people say shows up here."
                  : transcribing
                    ? `Listening. What people say shows up here. Add an agent and it ${HEARS}.`
                    : `Add an agent to the room. It ${HEARS}.`}
              </p>
              <div className="rt-empty-actions">
                {canAdd && (
                  <button type="button" onClick={openAddAgent} className="rt-btn rt-btn-violet" title={ADD_AGENT_TITLE}>
                    <Sparkles className="h-3.5 w-3.5" />
                    Add an agent
                  </button>
                )}
                {!transcribing && seated && (
                  <button type="button" onClick={transcribeAlone} className="rt-btn rt-btn-green" title="Transcribe the huddle with no agent: what people say shows up in this thread">
                    <Captions className="h-3.5 w-3.5" />
                    Transcribe without one
                  </button>
                )}
              </div>
            </div>
          ))}

        {recording && passages.length === 1 ? (
          // One short run of one microphone: the lines themselves, no fold
          // head over a single passage.
          <div className="rt-passage-body">
            <TranscriptTurnList
              turns={passages[0].turns}
              isSelected={selection?.isSelected}
              onTurnClick={selection?.onTurnClick}
              compact
              activeIndex={activeIndex}
            />
          </div>
        ) : (
          timeline.map((item, i) => {
            const divider =
              earlier > 0 && (i === 0 ? "Earlier in this room" : i === earlier ? "This call" : null);
            let node: React.ReactNode;
            if (item.kind === "passage") {
              if (density === "hidden") return null;
              node = (
                <PassageBlock
                  passage={item}
                  idPrefix={idPrefix}
                  open={isOpen(item)}
                  live={transcribing && item.index === newestIndex}
                  fresh={item.at > mountedAt.current}
                  recording={recording}
                  onToggle={() => toggle(item)}
                  selection={selection}
                />
              );
            } else if (item.kind === "event") {
              node = (
                <EventLine
                  row={item.row}
                  me={myUserId}
                  ownRoomId={ownRoomId}
                  ended={ended}
                  explain={item.row._id === explainEventId}
                  fresh={item.at > mountedAt.current}
                  dayOf={startedAt}
                  onOpen={openSession}
                />
              );
            } else {
              const prev = timeline[i - 1];
              const m = item.row as LocalRow;
              const sameAuthor =
                !!prev &&
                prev.kind === "chat" &&
                prev.row.user_name === m.user_name &&
                !!prev.row.agent === !!m.agent &&
                m.at - prev.at < 180_000;
              // The server's echo of a pending line takes the pending row's
              // place with the same words; it arrived already, so it does
              // not rise a second time.
              const fresh = m.at > mountedAt.current && !(m.mine && !m.pending);
              node = <ChatLine m={m} sameAuthor={sameAuthor} fresh={fresh} dayOf={startedAt} stage={surface === "stage"} onOpen={openSession} />;
            }
            const key = item.kind === "passage" ? `p${item.index}` : item.row._id;
            return divider ? (
              <Fragment key={key}>
                <p className="rt-note rt-divider">{divider}</p>
                {node}
              </Fragment>
            ) : (
              <Fragment key={key}>{node}</Fragment>
            );
          })
        )}
        {working.map((a) => (
          <div key={`working-${a.id}`} className="rt-working rt-in">
            {a.row ? (
              <SessionFace row={a.row} size={20} className="shrink-0" />
            ) : (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sol-violet/15">
                <AgentTypeIcon agentType={a.agentType} className="h-3 w-3" />
              </span>
            )}
            <span className="truncate">{a.name} is working</span>
            <WorkingDots />
          </div>
        ))}
      </div>

      {/* The pill sits above the foot whatever the composer's height, and
          above the list's edge when there is no composer. */}
      <div className="rt-tail">
        {behind > 0 && (
          <button type="button" className="ch-jump" onClick={jumpToEnd}>
            {behind} new {behind === 1 ? "line" : "lines"} ↓
          </button>
        )}
        {composer && (
          <div className="rt-foot">
            <div className="ch-composer ch-composer-flush">
              <MessageInput
                key={draftKey}
                conversationId={draftKey}
                bareComposer
                chatMentionMode
                mentionTeamId={mentionTeamId}
                composerPlaceholder={placeholder}
                onDropFiles={dropFilesRef}
                onGateSend={async (text, images) => {
                  const attachments = await settleComposerAttachments(images);
                  const content = text.trim();
                  if (!content && attachments.length === 0) return;
                  send(content, attachments);
                }}
              />
              <div className="ch-composer-foot">
                <button type="button" className="ch-composer-attach" title="Attach an image" onClick={() => pickerRef.current?.click()}>
                  <ImagePlus className="h-3.5 w-3.5" />
                </button>
                <input
                  ref={pickerRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length) dropFilesRef.current?.(files);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Spoken words ───────────────────────────────────────────────────────────

/** A recording has one microphone: the preview is the words alone, with no
 *  "Speaker:" before every line. */
function spokenPreview(passage: Passage): string {
  return clip(passage.segments.map((s) => s.text.trim()).filter(Boolean).join(" "), PASSAGE_PREVIEW_CHARS);
}

/** Three breathing dots (team chat's typing mark): an agent mid-turn. Hidden
 *  from assistive tech; the words beside them say it. */
function WorkingDots({ className = "", title }: { className?: string; title?: string }) {
  return (
    <span className={`ch-typing-dots ${className}`} title={title} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

/** A body that folds with motion both ways: a grid row that goes from 0fr to
 *  1fr and back over 200ms. The row itself is always mounted, so opening has
 *  something to transition from; the body stays mounted through the close
 *  and leaves when the transition ends. With reduced motion there is no
 *  transition to wait for, so the body leaves at once. */
function Fold({ open, children }: { open: boolean; children: React.ReactNode }) {
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

function PassageBlock({
  passage,
  idPrefix,
  open,
  live,
  fresh,
  recording,
  onToggle,
  selection,
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
  onToggle: () => void;
  selection?: RoomThreadSelection;
}) {
  const units = recording ? "line" : "turn";
  const n = passage.turns.length;
  const bodyId = `${idPrefix}p${passage.index}`;
  return (
    <section className={`rt-passage${open ? " rt-passage-open" : ""}${live ? " rt-passage-live" : ""}${fresh ? " rt-in" : ""}`}>
      <button
        type="button"
        className="rt-passage-head"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
        title={open ? "Fold this passage" : "Open this passage"}
      >
        <ChevronRight className="rt-passage-chevron h-3 w-3" aria-hidden="true" />
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
          {fmtClock(passage.t0)} · {fmtDuration(Math.max(1000, passage.t1 - passage.t0))} · {n} {units}
          {n === 1 ? "" : "s"}
        </span>
        {!open && <span className="rt-passage-preview">{recording ? spokenPreview(passage) : passage.preview}</span>}
      </button>
      <Fold open={open}>
        <div id={bodyId} className="rt-passage-body">
          <TranscriptTurnList
            turns={passage.turns}
            isSelected={selection?.isSelected}
            onTurnClick={selection?.onTurnClick}
            compact={recording}
            activeIndex={selection?.activeIndex ?? null}
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

function RecapCard({ summary, items, live }: { summary: string; items: string[]; live: boolean }) {
  const [open, setOpen] = useState(false);
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
        <ChevronRight className="rt-passage-chevron h-3 w-3" aria-hidden="true" />
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
          <p>{summary}</p>
          {items.length > 0 && (
            <div className="rt-recap-items">
              <div className="rt-recap-items-label">
                <ListChecks className="h-3 w-3" /> Action items
              </div>
              <ul>
                {items.map((a, i) => (
                  <li key={i}>
                    <span className="text-sol-violet">→</span>
                    <span>{a}</span>
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

function EventLine({
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
      <span>
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
        <span className="rt-when rt-event-when">{fmtWallClock(row.at, dayOf)}</span>
      </span>
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

function ChatLine({
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
                className="max-w-[200px] truncate text-[11.5px] font-semibold text-sol-violet hover:underline"
                title={`Open ${m.agent.title}`}
              >
                {m.agent.name ?? m.agent.title}
              </button>
            ) : (
              <span className="text-[11.5px] font-semibold text-sol-text">{m.mine ? "you" : firstName(m.user_name)}</span>
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

// ── How much of the spoken words to show ───────────────────────────────────

const DENSITIES: Array<{ key: Density; icon: LucideIcon; label: string; hint: string }> = [
  { key: "folded", icon: ChevronsDownUp, label: "folded", hint: "Spoken words folded into passages; the newest stays open while the call is live" },
  { key: "full", icon: AlignLeft, label: "full", hint: "Every spoken word, open" },
  { key: "hidden", icon: EyeOff, label: "hidden", hint: "Only typed lines and agent answers" },
];

function DensityControl({ value, onChange }: { value: Density; onChange: (d: Density) => void }) {
  return (
    <span className="rt-density-group">
      <span className="rt-density-label" aria-hidden="true">
        words
      </span>
      <SegmentedRadio label="Spoken words" options={DENSITIES} value={value} onChange={onChange} />
    </span>
  );
}

// ── A control with a few positions ─────────────────────────────────────────

/** One radiogroup of small buttons, the live one raised: the thread's words
 *  control and the stage's view control are both this. One tab stop for the
 *  group; the arrow keys move the check, the radio way. Icons alone by
 *  default (the option's label becomes the button's name); `labels` writes
 *  the label beside the icon. */
export function SegmentedRadio<K extends string>({
  label,
  options,
  value,
  onChange,
  labels = false,
  iconClass = "h-3 w-3",
  className,
}: {
  /** The group's name for assistive tech, and the prefix of each option's name when icons stand alone. */
  label: string;
  options: ReadonlyArray<{ key: K; icon: LucideIcon; label: string; hint: string }>;
  value: K;
  onChange: (next: K) => void;
  labels?: boolean;
  iconClass?: string;
  className?: string;
}) {
  const groupRef = useRef<HTMLSpanElement>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.key === value);
    const next = options[(i + step + options.length) % options.length];
    onChange(next.key);
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-value="${next.key}"]`)?.focus();
  };
  return (
    <span ref={groupRef} role="radiogroup" aria-label={label} className={`rt-seg ${className ?? ""}`} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          data-value={o.key}
          aria-checked={value === o.key}
          aria-label={labels ? undefined : `${label} ${o.label}`}
          tabIndex={value === o.key ? 0 : -1}
          title={o.hint}
          onClick={() => onChange(o.key)}
          className={`rt-seg-btn${labels ? " rt-seg-btn-labeled" : ""}`}
        >
          <o.icon className={iconClass} />
          {labels && o.label}
        </button>
      ))}
    </span>
  );
}

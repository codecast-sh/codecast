import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  X,
} from "lucide-react";
import { useMutation } from "convex/react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  ACTIVE_AGENT_STATUSES,
  humanizeConvexError,
  isRecRoomKey,
  sessionRoomConversationId,
} from "@codecast/shared/contracts";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { AvatarImg } from "../../lib/avatarCache";
import { navigateMainWindow } from "../../lib/desktop";
import { settleComposerAttachments } from "../../lib/draftImages";
import { getRoom, startTranscribing } from "../../lib/calls/callManager";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import { findSessionRow } from "../../lib/calls/findSessionRow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { MessageInput } from "../MessageInput";
import { ChatAttachments } from "../chat/ChatMessage";
import { MESSAGE_MD_COMPONENTS, MESSAGE_MD_REHYPE, USER_MD_REMARK } from "../messageMarkdown";
import type { ChatAttachment } from "../../store/chatSlice";
import { FeedChip } from "./FeedChip";
import { TranscribeSwitch } from "./TranscribePanel";
import { TranscriptTurnList } from "./TranscriptTurns";
import { openFeedTargetPicker, useAddLiveFeed, useRemoveLiveFeed, type FeedTarget } from "./useCallFeed";
import { firstName, fmtClock, speakerColor } from "./speakers";
import {
  PASSAGE_PREVIEW_CHARS,
  buildPassages,
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

/** A row's time, with its date when it is not the call's own day: the room's
 *  chat outlives one call, so a line from an earlier day says so. */
function fmtRowTime(at: number, dayOf: number | undefined): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (dayOf === undefined || d.toDateString() === new Date(dayOf).toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

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
  onClose,
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
  onClose?: () => void;
  selection?: RoomThreadSelection;
  className?: string;
}) {
  const recording = isRecRoomKey(roomKey);
  const transcribing = !!liveTranscriptId;
  const ended = !!call && call.status !== "live";
  const post = useMutation(api.callChat.post);
  const [pending, setPending] = useState<Array<{ key: string; text: string; attachments: ChatAttachment[]; at: number }>>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the tail while the call is live (the newest words are the point);
  // an ended call opens at the top, where the recap is.
  const stuckRef = useRef(!!liveTranscriptId);
  const dropFilesRef = useRef<((files: File[]) => void) | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
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
  // A recording is only spoken words: "hidden" would blank the page.
  const density: Density = recording && storedDensity === "hidden" ? "folded" : storedDensity;
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
  const passages = useMemo(
    () => buildPassages(segments ?? [], chatRows.map((r) => r.at), { recording }),
    [segments, chatRows, recording],
  );
  const timeline = useMemo(() => mergeTimeline(passages, chatRows), [passages, chatRows]);

  const routes = call?.routes ?? [];
  // After the call the routes are history: the chips still say who was in
  // the room (roster), but nobody hears a line typed now and nobody is
  // working on it (agents).
  const roster = useAgentsInRoom(routes);
  const agents = transcribing ? roster : [];
  const working = agents.filter((a) => a.working);
  const ownRoomId = sessionRoomConversationId(roomKey);

  const addFeed = useAddLiveFeed({ roomKey, liveTranscriptId, getRoom });
  const removeFeed = useRemoveLiveFeed(liveTranscriptId);
  // addRoute/startScribe can refuse (room authorization, ended transcript);
  // a silent close-and-nothing is the one wrong outcome.
  const onPickFeed = (t: FeedTarget) =>
    void addFeed(t).catch((err: any) => toast.error(humanizeConvexError(err, "Could not add the agent")));
  const openAddAgent = () =>
    openFeedTargetPicker({ title: "Add an agent to the room", gesture: "feed", showSlack: true, onPick: onPickFeed });
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
  // up to quote something keeps their place.
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  };
  const lastPassage = passages[passages.length - 1];
  const tailSize = lastPassage?.segments.length ?? 0;
  useWatchEffect(() => {
    const el = scrollRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [timeline.length, tailSize, working.length]);

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

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepthRef.current++;
    setDragging(true);
  }, []);
  const onDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  }, []);
  const onDrop = useCallback((e: React.DragEvent) => {
    dragDepthRef.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    dropFilesRef.current?.(files);
  }, []);

  const openSession = (id: string) => {
    if (panel) return void navigateMainWindow(`/conversation/${id}`);
    useInboxStore.getState().openSidePanel(id);
  };

  const composer = !recording;
  // One line of placeholder: a long session title is cut so the hint does
  // not wrap the box to three lines in the rail.
  const placeholder =
    agents.length === 1
      ? `Message the room · ${clip(agents[0].name, 22)} hears you`
      : agents.length > 1
        ? "Message the room · the agents hear you"
        : "Message the room";

  const newestIndex = passages.length - 1;
  const isOpen = (p: Passage) =>
    overrides[p.index] ?? (density === "full" || (transcribing && p.index === newestIndex));
  const toggle = (p: Passage) => setOverrides((o) => ({ ...o, [p.index]: !isOpen(p) }));

  const empty = passages.length === 0 && chatRows.length === 0;

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
          much of the spoken words to show, and the transcription switch. */}
      <div className={`rt-head${onClose ? " rt-head-closable" : ""}`}>
        {routes.map((r) => {
          const agent = r.kind === "session" ? roster.find((a) => a.target === r.target) : null;
          return (
            <span key={`${r.kind}:${r.target}`} className="rt-chip">
              <FeedChip
                route={r}
                removable={canRemove && !!myUserId && r.added_by === myUserId}
                onRemove={() => void removeFeed(r.kind, r.target)}
              />
              {agent?.working && transcribing && (
                <span className="call-chat-dots text-sol-violet" title={`${agent.name} is working`} aria-label="working">
                  <i />
                  <i />
                  <i />
                </span>
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
        {canAdd && (
          <button type="button" onClick={openAddAgent} className="rt-add" title="Add an agent: it hears the room and answers here">
            <Sparkles className="h-3 w-3" />
            Add an agent
          </button>
        )}
        <span className="rt-head-right">
          {!recording && <DensityControl value={density} onChange={setDensity} />}
          {seated && !recording && <TranscribeSwitch live={transcribing} />}
          {onClose && (
            <button type="button" onClick={onClose} className="rt-close" title="Close the thread">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </div>

      {/* What people said is content; the stage around this thread is chrome
          and turns selection off, so the list turns it back on. */}
      <div ref={scrollRef} onScroll={onScroll} className="rt-list min-h-0 flex-1 select-text overflow-y-auto">
        {call?.summary ? (
          <RecapCard summary={call.summary} items={call.action_items ?? []} live={!ended} />
        ) : ended && !recording ? (
          <p className="rt-note">
            {call.summary_status === "skipped"
              ? "Too short to summarize."
              : call.summary_status === "failed"
                ? "Summary generation failed."
                : "Summary pending…"}
          </p>
        ) : null}

        {selection?.hint && passages.length > 0 && <p className="rt-note">{selection.hint}</p>}

        {empty ? (
          recording ? (
            <p className="rt-note">
              {transcribing
                ? "Listening. The transcript appears as people speak. Your microphone hears the room."
                : "Nothing was transcribed."}
            </p>
          ) : ended ? (
            <p className="rt-note">Nothing was said.</p>
          ) : agents.length > 0 ? null : (
            <div className="rt-empty">
              <Sparkles className="h-4 w-4 text-sol-violet" />
              <p>
                {switchedOff
                  ? "Transcription is off for this huddle. Add an agent, or switch it back on, and the words land here."
                  : transcribing
                    ? "Listening. Words appear here as people speak. Add an agent and it answers in this thread."
                    : "Add an agent to the room. It hears what is said and answers in this thread."}
              </p>
              <div className="rt-empty-actions">
                {canAdd && (
                  <button type="button" onClick={openAddAgent} className="rt-btn rt-btn-violet" title="Add an agent: it hears the room and answers here">
                    <Sparkles className="h-3.5 w-3.5" />
                    Add an agent
                  </button>
                )}
                {!transcribing && seated && (
                  <button type="button" onClick={transcribeAlone} className="rt-btn rt-btn-green" title="Transcribe the huddle with no agent: the words land here and on the call page">
                    <Captions className="h-3.5 w-3.5" />
                    Transcribe without one
                  </button>
                )}
              </div>
            </div>
          )
        ) : (
          timeline.map((item, i) => {
            if (item.kind === "passage") {
              if (density === "hidden") return null;
              return (
                <PassageBlock
                  key={`p${item.index}`}
                  passage={item}
                  open={isOpen(item)}
                  live={transcribing && item.index === newestIndex}
                  recording={recording}
                  onToggle={() => toggle(item)}
                  selection={selection}
                />
              );
            }
            if (item.kind === "event") {
              return (
                <EventLine key={item.row._id} row={item.row} me={myUserId} ownRoomId={ownRoomId} dayOf={call?.started_at} onOpen={openSession} />
              );
            }
            const prev = timeline[i - 1];
            const m = item.row as LocalRow;
            const sameAuthor =
              !!prev &&
              prev.kind === "chat" &&
              prev.row.user_name === m.user_name &&
              !!prev.row.agent === !!m.agent &&
              m.at - prev.at < 180_000;
            return <ChatLine key={m._id} m={m} sameAuthor={sameAuthor} dayOf={call?.started_at} onOpen={openSession} />;
          })
        )}
        {/* The room is being transcribed and nothing has been said yet: say
            so at the foot, where the first passage will land. The empty card
            above already says it when nobody is in the room. */}
        {transcribing && !recording && passages.length === 0 && !(empty && agents.length === 0) && (
          <p className="rt-note rt-listening">{scribeError ?? "Listening. Words appear here as people speak."}</p>
        )}
        {working.map((a) => (
          <div key={`working-${a.id}`} className="rt-working">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sol-violet/15">
              <AgentTypeIcon agentType={a.agentType} className="h-3 w-3" />
            </span>
            <span className="truncate">{a.name} is working</span>
            <span className="call-chat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        ))}
      </div>

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
  );
}

// ── Spoken words ───────────────────────────────────────────────────────────

/** A recording has one microphone: the preview is the words alone, with no
 *  "Speaker:" before every line. */
function spokenPreview(passage: Passage): string {
  const words = passage.segments.map((s) => s.text.trim()).filter(Boolean).join(" ");
  return words.length > PASSAGE_PREVIEW_CHARS ? `${words.slice(0, PASSAGE_PREVIEW_CHARS - 1).trimEnd()}…` : words;
}

function fmtLength(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

function PassageBlock({
  passage,
  open,
  live,
  recording,
  onToggle,
  selection,
}: {
  passage: Passage;
  open: boolean;
  /** The newest passage of a live call: it reads like captions, not history. */
  live: boolean;
  recording: boolean;
  onToggle: () => void;
  selection?: RoomThreadSelection;
}) {
  const units = recording ? "line" : "turn";
  const n = passage.turns.length;
  const bodyId = `rt-passage-${passage.index}`;
  return (
    <section className={`rt-passage${open ? " rt-passage-open" : ""}${live ? " rt-passage-live" : ""}`}>
      <button
        type="button"
        className="rt-passage-head"
        aria-expanded={open}
        aria-controls={bodyId}
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
        <span className="rt-passage-when">
          {fmtClock(passage.t0)} · {fmtLength(passage.t1 - passage.t0)} · {n} {units}
          {n === 1 ? "" : "s"}
        </span>
        {!open && <span className="rt-passage-preview">{recording ? spokenPreview(passage) : passage.preview}</span>}
      </button>
      {open && (
        <div id={bodyId} className="rt-passage-body">
          <TranscriptTurnList
            turns={passage.turns}
            isSelected={selection?.isSelected}
            onTurnClick={selection?.onTurnClick}
            compact={recording}
            activeIndex={selection?.activeIndex ?? null}
          />
        </div>
      )}
    </section>
  );
}

// ── The recap so far ───────────────────────────────────────────────────────

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?]*[.!?](?=\s|$)/);
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
        {!open && <span className="rt-recap-line">{firstSentence(summary)}</span>}
      </button>
      {open && (
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
                    <span className="text-sol-cyan">→</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── Who came and went ──────────────────────────────────────────────────────

function EventLine({
  row,
  me,
  ownRoomId,
  dayOf,
  onOpen,
}: {
  row: EventRow;
  me: string | null;
  ownRoomId: string | null;
  dayOf: number | undefined;
  onOpen: (id: string) => void;
}) {
  const actor = me && row.user_id === me ? "You" : firstName(row.user_name);
  const agent = row.agent;
  const name = agent ? (
    <button type="button" className="rt-event-agent" onClick={() => onOpen(agent.conversation_id)} title="Open the agent's session">
      {agent.title}
    </button>
  ) : (
    <span className="rt-event-agent">an agent</span>
  );
  // The room's own agent is not somebody's guest: it was in the room before
  // anyone, so the line says it is here rather than who brought it.
  const ownRoom = !!agent && !!ownRoomId && (agent.conversation_id === ownRoomId || agent.short_id === ownRoomId);
  const spoken = row.event === "transcribe_on" || row.event === "transcribe_off";
  const Glyph = row.event === "transcribe_off" ? CaptionsOff : row.event === "transcribe_on" ? Captions : Sparkles;
  return (
    <div className="rt-event" role="note">
      <Glyph className={`h-3 w-3 ${spoken ? "text-sol-green" : "text-sol-violet"}`} aria-hidden="true" />
      <span>
        {row.event === "agent_joined" ? (
          ownRoom ? (
            <>{name} is in the room · it hears everything and answers here</>
          ) : (
            <>
              {actor} added {name} · it hears the room and answers here
            </>
          )
        ) : row.event === "agent_left" ? (
          <>{name} left the room</>
        ) : (
          <>
            {actor} switched transcription {row.event === "transcribe_on" ? "on" : "off"}
          </>
        )}
        <span className="rt-event-when">{fmtRowTime(row.at, dayOf)}</span>
      </span>
    </div>
  );
}

// ── Typed lines and agent answers ──────────────────────────────────────────

function ChatLine({
  m,
  sameAuthor,
  dayOf,
  onOpen,
}: {
  m: LocalRow;
  sameAuthor: boolean;
  dayOf: number | undefined;
  onOpen: (id: string) => void;
}) {
  return (
    <div className={`rt-line${sameAuthor ? " rt-line-cont" : ""}`}>
      <span className="w-5 shrink-0 pt-0.5">
        {!sameAuthor &&
          (m.agent ? (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sol-violet/15">
              <AgentTypeIcon agentType={m.agent.agent_type} className="h-3 w-3" />
            </span>
          ) : (
            <AvatarImg
              src={m.user_image}
              alt=""
              className="h-5 w-5 rounded-full object-cover"
              fallback={
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sol-bg-highlight text-[9px] font-medium text-sol-text-muted">
                  {(m.user_name || "?").charAt(0).toUpperCase()}
                </span>
              }
            />
          ))}
      </span>
      <div className="min-w-0 flex-1">
        {!sameAuthor && (
          <div className="mb-0.5 flex items-baseline gap-1.5">
            {m.agent ? (
              <button
                type="button"
                onClick={() => onOpen(m.agent!.conversation_id)}
                className="max-w-[200px] truncate text-[11px] font-medium text-sol-violet hover:underline"
                title="Open the agent's session"
              >
                {m.agent.title}
              </button>
            ) : (
              <span className="text-[11px] font-medium text-sol-text">{m.mine ? "you" : firstName(m.user_name)}</span>
            )}
            <span className="text-[9.5px] text-sol-text-dim">{fmtRowTime(m.at, dayOf)}</span>
          </div>
        )}
        {m.agent ? (
          <div className="call-chat-agent-body text-[12.5px] leading-relaxed text-sol-text">
            <ReactMarkdown remarkPlugins={USER_MD_REMARK} rehypePlugins={MESSAGE_MD_REHYPE} components={MESSAGE_MD_COMPONENTS}>
              {m.text}
            </ReactMarkdown>
          </div>
        ) : m.text ? (
          <div className={`whitespace-pre-wrap break-words text-[12.5px] leading-relaxed ${m.pending ? "text-sol-text-muted" : "text-sol-text"}`}>
            {m.text}
          </div>
        ) : null}
        {(m.attachments?.length ?? 0) > 0 && <ChatAttachments messageId={m._id} attachments={m.attachments as any} />}
      </div>
    </div>
  );
}

// ── How much of the spoken words to show ───────────────────────────────────

const DENSITIES: Array<{ key: Density; icon: typeof AlignLeft; label: string; hint: string }> = [
  { key: "folded", icon: ChevronsDownUp, label: "folded", hint: "Spoken words folded into passages; the newest stays open while the call is live" },
  { key: "full", icon: AlignLeft, label: "full", hint: "Every spoken word, open" },
  { key: "hidden", icon: EyeOff, label: "hidden", hint: "Only typed lines and agent answers" },
];

function DensityControl({ value, onChange }: { value: Density; onChange: (d: Density) => void }) {
  return (
    <span role="radiogroup" aria-label="Spoken words" className="rt-density">
      {DENSITIES.map((d) => (
        <button
          key={d.key}
          type="button"
          role="radio"
          aria-checked={value === d.key}
          aria-label={`Spoken words ${d.label}`}
          title={d.hint}
          onClick={() => onChange(d.key)}
          className="rt-density-btn"
        >
          <d.icon className="h-3 w-3" />
        </button>
      ))}
    </span>
  );
}

// ── The agents in the room ─────────────────────────────────────────────────

type AgentInRoom = {
  id: string;
  target: string;
  addedBy: string;
  name: string;
  agentType: string;
  working: boolean;
};

// The sessions the live transcript feeds, as participants: name, kind, and
// whether one is mid-turn. Read from the store's session rows, subscribed
// through a signature of the fields shown so the header does not re-render
// on every heartbeat of every session.
function useAgentsInRoom(routes: RoomThreadRoute[]): AgentInRoom[] {
  const targets = routes.filter((r) => r.kind === "session");
  const sig = targets.map((r) => r.target).join("|");
  const s = useTrackedStore([
    (st: any) =>
      targets
        .map((r) => {
          const row = findSessionRow(st, r.target);
          return row ? `${row._id}:${row.title ?? ""}:${row.agent_type ?? ""}:${row.agent_status ?? ""}` : r.target;
        })
        .join("|"),
  ]);
  return useMemo(
    () =>
      targets.map((r) => {
        const row = findSessionRow(s, r.target);
        return {
          id: String(row?._id ?? r.target),
          target: r.target,
          addedBy: r.added_by,
          name: (row?.title || "agent session").slice(0, 40),
          agentType: row?.agent_type ?? "claude_code",
          working: ACTIVE_AGENT_STATUSES.has(row?.agent_status ?? ""),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the routes list
    [sig, s],
  );
}

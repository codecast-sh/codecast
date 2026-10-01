import { Fragment, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AlignLeft,
  Captions,
  ChevronRight,
  ChevronsDownUp,
  ExternalLink,
  EyeOff,
  ImagePlus,
  Sparkles,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  callAnchorKey,
  isRecRoomKey,
  sessionRoomConversationId,
  type CallAnchor,
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
import type { ChatAttachment } from "../../store/chatSlice";
import { LivePulseDot } from "../SessionActivityLine";
import { prefersReducedMotion } from "../../hooks/useBottomAnchoredList";
import { FeedChip } from "./FeedChip";
import { SessionFace } from "../identity";
import { TranscribeSwitch } from "./TranscribePanel";
import { TranscriptTurnList } from "./TranscriptTurns";
import { ChatLine, EventLine, PassageBlock, RecapCard, type LocalRow, type RoomThreadSelection } from "./RoomThreadRows";
import { useAddToCall, useAgentsInRoom, useRemoveLiveFeed } from "./useCallFeed";
import {
  HEARS,
  buildPassages,
  clip,
  mergeTimeline,
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

export type { RoomThreadSelection } from "./RoomThreadRows";

export type RoomThreadRoute = { kind: string; target: string; mode: string; added_by: string };

/** What the thread reads of transcripts.webGetCall. */
export type RoomThreadCall = {
  _id: string;
  status: string;
  started_at: number;
  ended_at?: number | null;
  segments: TranscriptSegment[];
  summary: string | null;
  action_items: string[];
  summary_status?: string | null;
  routes: RoomThreadRoute[];
  team_id?: string;
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

function echoKey(text: string, attachments?: { storage_id: string }[] | null): string {
  return `${text}\0${(attachments ?? []).map((a) => a.storage_id).join(",")}`;
}

export function RoomThread({
  roomKey,
  call,
  rows,
  liveTranscriptId,
  surface,
  seated,
  panel,
  selection,
  sinceAt,
  focus,
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
  /** When the viewer joined this huddle; the dividers' anchor before any transcript. */
  sinceAt?: number;
  /** A link landed on a place in this call: it opens, scrolls into view and flashes. */
  focus?: CallAnchor | null;
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
  // The viewer's own mute (callManager writes it) and the room's: every
  // seat muted means nobody can say anything for the scribe to hear.
  const muted = useInboxStore((s: any) => s.call?.roomKey === roomKey && !!s.call?.muted);
  const seats = useInboxStore((s: any) => ((s.callOccupancy?.[roomKey] ?? []) as any[]).length);
  const allMuted = useInboxStore((s: any) => {
    const r = (s.callOccupancy?.[roomKey] ?? []) as any[];
    return r.length > 0 && r.every((m) => m.muted);
  });

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
  // The stage hands the thread no call once transcription is off, but the
  // rows it just wrote ("You switched transcription off", "Pearl was in the
  // room") are this call's story: the thread keeps the last call it saw as
  // its anchor while it is mounted. Before any call there is no anchor.
  const lastStartRef = useRef<number | undefined>(undefined);
  if (startedAt !== undefined) lastStartRef.current = startedAt;
  const anchorAt = startedAt ?? lastStartRef.current;
  const endedAt = call?.ended_at ?? undefined;
  // An event row is the room's log for one call: an agent that came and went
  // in an earlier or a later call is not this call's, so only events between
  // the call's start and its end show. With no call to anchor on (the stage
  // before transcription ever started) every event is an earlier call's, so
  // none shows. Typed and agent lines from other calls stay, set apart by
  // the dividers below.
  const inCall = (at: number) => anchorAt !== undefined && at >= anchorAt && (endedAt === undefined || at <= endedAt);
  const visibleRows = useMemo(
    () =>
      chatRows.filter(
        (r) => !r.event || (anchorAt !== undefined && r.at >= anchorAt && (endedAt === undefined || r.at <= endedAt)),
      ),
    [chatRows, anchorAt, endedAt],
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
  // A session's own room has an agent before anyone adds one: the server
  // routes the session in the moment transcription starts (transcripts.ts
  // withDefaultRoutes). Its name is read here for the empty card, so the
  // card can promise who answers. Until the session row lands the name is
  // "new agent", which is nobody: the card says "this session's agent".
  const ownAgent = useAgentsInRoom(ownRoomId && routes.length === 0 ? [{ kind: "session", target: ownRoomId, added_by: "" }] : [])[0];
  const ownName = ownAgent?.row ? ownAgent.name : "this session's agent";
  // In an own room the empty card's button adds a second agent beside the
  // room's own; the words say so.
  const addLabel = ownRoomId ? "Add another agent" : "Add an agent";
  const addTitle = "Ring a teammate in, or bring in a role or an agent that hears the room";

  // The header's button and the empty card's open the call's one add list
  // (AddPeople.tsx): teammates, roles and agents.
  const { open: openAddAgent, adding } = useAddToCall({ roomKey, liveTranscriptId, routes, teamId: call?.team_id });
  const removeFeed = useRemoveLiveFeed(liveTranscriptId);
  // What an agent did is in the past once the call ended or nothing is live
  // (the stage after the switch went off): "was in the room", and none of
  // the present tense promise about what it does here.
  const past = ended || !transcribing;
  // The explanation of what an agent does is said once per call, on the
  // first agent event of this call; the later ones just say who came.
  const explainEventId = past ? undefined : chatRows.find((r) => r.event === "agent_joined" && inCall(r.at))?._id;
  // No room means the server has not let this client into the huddle yet
  // (or refused it), so nothing can be started; a refusal past that point
  // is most often another scribe, but the server does not say which.
  const transcribeAlone = () => {
    if (!getRoom()) return void toast.error("Not connected to the huddle yet. Try again in a moment.");
    void startTranscribing(roomKey).then((ok) => {
      if (!ok) toast.error("Could not start transcribing. Somebody else may be the scribe already.");
    });
  };

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
  // The stage's box holds about 27 characters a line at the 272px rail (less
  // in a monospace theme), and a placeholder that wraps looks like a two line
  // draft: the promise that an agent hears a typed line is kept short there,
  // with a short name. The page has room to say "the room" and name the agent.
  const placeholder =
    surface === "stage"
      ? agents.length === 1
        ? `Message · ${clip(agents[0].name, 12)} hears you`
        : agents.length > 1
          ? "Message · the agents hear you"
          : "Message the room"
      : agents.length === 1
        ? `Message the room · ${clip(agents[0].name, 22)} hears you`
        : agents.length > 1
          ? "Message the room · the agents hear you"
          : "Message the room";

  const newestIndex = passages.length - 1;
  const activeIndex = selection?.activeIndex ?? null;
  // A passage of one turn has no head to fold under (PassageBlock renders
  // its turn row alone), so it is open in every density but hidden; the
  // folded density folds passages of two or more turns.
  const isOpen = (p: Passage) =>
    (activeIndex !== null && p.turns.some((t) => t.index === activeIndex)) ||
    (!recording && p.turns.length === 1) ||
    (overrides[p.index] ?? (density === "full" || (transcribing && p.index === newestIndex)));
  const toggle = (p: Passage) => {
    const opening = !isOpen(p);
    // Opening history pushes the tail down without a scroll event; a reader
    // who did that is reading, not following.
    if (opening && p.index !== newestIndex) stuckRef.current = false;
    setOverrides((o) => ({ ...o, [p.index]: opening }));
  };

  // A link into the call: open what holds the place (its passages, or the
  // recap through RecapCard's focus), then bring it into view once, and
  // stop following the tail so a live call does not scroll away from it.
  const focusKey = focus ? callAnchorKey(focus) : null;
  const landedRef = useRef<string | null>(null);
  const focusTurn =
    focus?.kind === "turns"
      ? passages.flatMap((p) => p.turns).find((t) => t.segments.some((sg) => sg.seq >= focus.from_seq && sg.seq <= focus.to_seq))
      : undefined;
  const hasSummary = !!call?.summary;
  useWatchEffect(() => {
    if (!focus || !focusKey || landedRef.current === focusKey) return;
    if (focus.kind === "turns" ? !focusTurn : !hasSummary) return;
    landedRef.current = focusKey;
    stuckRef.current = false;
    if (focus.kind === "turns") {
      const held = passages.filter((p) =>
        p.turns.some((t) => t.segments.some((sg) => sg.seq >= focus.from_seq && sg.seq <= focus.to_seq)),
      );
      if (density === "hidden") setDensityState("full");
      setOverrides((o) => ({ ...o, ...Object.fromEntries(held.map((p) => [p.index, true])) }));
    }
    const selector =
      focus.kind === "turns" ? `[data-turn="${focusTurn!.index}"]` : `[data-call-anchor="${focus.kind === "summary" ? "summary" : `action-${focus.index}`}"]`;
    // After the fold has mounted what it holds. A timer, not a frame: frames
    // stall in a background tab and the link may open in one.
    setTimeout(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(selector);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.classList.add("cc-msg-flash");
      setTimeout(() => el.classList.remove("cc-msg-flash"), 1300);
    }, 60);
  }, [focusKey, focusTurn, hasSummary]);

  // Event rows are the room's log, not its content: a room that has only
  // ever seen agents come and go is still empty.
  const empty = passages.length === 0 && chatRows.every((r) => r.event);
  // The pick on its way shows as a chip until its route lands among the real ones.
  const joining = adding && !("id" in adding && routes.some((r) => r.target === adding.id)) ? adding : null;
  const showChips = routes.length > 0 || !!joining;
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
  // A muted room says nothing, so "listening" alone reads as a broken scribe
  // to somebody whose mic is off. The words name the silence; the switch
  // stays green, because transcription is on.
  const soloMuted = muted && seats <= 1;
  const listeningText =
    scribeError ??
    (soloMuted
      ? "Listening, but your mic is muted."
      : allMuted
        ? "Listening, but everyone is muted."
        : "Listening. Words show up here.");
  const listeningShort = scribeError ?? (soloMuted ? "Your mic is muted" : allMuted ? "Everyone is muted" : "Nothing said yet");
  const spokenHidden = density === "hidden" && passages.length > 0;
  // The chat outlives one call, so typed and agent lines from before this
  // call started and from after it ended are set apart from it. On the stage
  // the switch already says the room is live, so the header's line is short.
  // Before transcription starts there is no call to anchor on, so the moment
  // the viewer joined this huddle anchors the dividers instead: chat from an
  // earlier huddle in this room falls under "Earlier in this room" rather
  // than reading as agents in the room now. Events keep the call's anchor.
  const dividerAt = anchorAt ?? sinceAt;
  const inDivider = (at: number) => dividerAt !== undefined && at >= dividerAt && (endedAt === undefined || at <= endedAt);
  const earlier = dividerAt !== undefined ? timeline.filter((i) => i.at < dividerAt).length : 0;
  const during = dividerAt !== undefined ? timeline.filter((i) => inDivider(i.at)).length : timeline.length;
  const later = timeline.length - earlier - during;
  // On an ended call's page the earlier lines are a month old "hello"
  // between the recap and the first words: folded until asked for. The
  // stage's earlier lines are minutes old, so they stay open. The call
  // loads after the thread mounts, so the default is read each render
  // until the reader chooses.
  const [earlierOverride, setEarlierOverride] = useState<boolean | null>(null);
  const earlierOpen = earlierOverride ?? (surface === "stage" || !ended);

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
          {joining && (
            <span className="rt-chip" title="Joining the room">
              <FeedChip
                route={{ kind: joining.kind === "new-session" ? "session" : joining.kind, target: "", mode: "live" }}
                label={joining.kind === "new-session" ? "new agent" : "label" in joining ? joining.label : undefined}
                removable={false}
                onRemove={() => {}}
              />
              <WorkingDots
                className="text-sol-violet"
                title={joining.kind === "new-session" ? "Starting the agent's session" : "Joining the room"}
              />
            </span>
          )}
          {canAdd && !emptyCard && (
            <button
              type="button"
              onClick={openAddAgent}
              className="rt-add"
              disabled={!!adding}
              title={adding ? "An agent is joining the room" : addTitle}
            >
              <UserPlus className="h-3 w-3" />
              <span className="rt-add-word">{surface === "stage" ? "Add" : "Add to the call"}</span>
            </button>
          )}
          <span className="rt-head-right">
            {/* On the stage the listening line is the first member of the
                controls' group and truncates in whatever room the chips
                leave. The switch beside it already pulses and says "on", so
                the line only says what is missing; the title has the long form. */}
            {listening && surface === "stage" && (
              <span className="rt-listening rt-head-listening" title={listeningText}>
                <span className="truncate">{listeningShort}</span>
              </span>
            )}
            {showDensity && <DensityControl value={density} onChange={setDensity} />}
            {showSwitch && <TranscribeSwitch live={transcribing} />}
          </span>
        </div>
      )}

      {/* The room is being transcribed and nothing has been said yet: one
          status line pinned under the header, not a row in the timeline. The
          empty card below already says it when nobody is in the room. */}
      {listening && surface !== "stage" && (
        <p className="rt-note rt-listening">
          <LivePulseDot className="h-1.5 w-1.5" />
          {listeningText}
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
          <RecapCard
            summary={call.summary}
            items={call.action_items ?? []}
            live={!ended}
            callId={String(call._id)}
            focus={focus && focus.kind !== "turns" ? focusKey : null}
          />
        ) : ended && !recording && passages.length > 0 ? (
          // A call with no spoken words has nothing a summary would cover:
          // the empty one says "Nothing was said." below, and one with only
          // typed lines needs no note over them.
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
          ) : !emptyCard ? null : ownRoomId && !transcribing ? (
            // A session's own room: its agent joins the moment transcription
            // starts, so transcribing is the first act and adding is for a
            // second agent.
            <div className="rt-empty">
              <p>
                Switch transcription on and {ownName} {HEARS}.
              </p>
              <div className="rt-empty-actions">
                {seated && (
                  <button
                    type="button"
                    onClick={transcribeAlone}
                    className="rt-btn rt-btn-violet"
                    title={`Start transcribing: ${ownName} joins the room and answers here`}
                  >
                    <Captions className="h-3.5 w-3.5" />
                    Transcribe
                  </button>
                )}
                {canAdd && (
                  <button
                    type="button"
                    onClick={openAddAgent}
                    className="rt-btn rt-btn-green"
                    disabled={!!adding}
                    title={adding ? "An agent is joining the room" : addTitle}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Add another agent
                  </button>
                )}
              </div>
            </div>
          ) : (
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
                  <button
                    type="button"
                    onClick={openAddAgent}
                    className="rt-btn rt-btn-violet"
                    disabled={!!adding}
                    title={adding ? "An agent is joining the room" : addTitle}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {addLabel}
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
              callId={call ? String(call._id) : undefined}
            />
          </div>
        ) : (
          timeline.map((item, i) => {
            const inEarlier = earlier > 0 && i < earlier;
            // The earlier group's label is a fold: with the group closed
            // the label stands alone and "This call" has nothing to divide.
            const divider: React.ReactNode =
              earlier > 0 && i === 0 ? (
                <button
                  type="button"
                  className="rt-note rt-divider"
                  aria-expanded={earlierOpen}
                  onClick={() => setEarlierOverride(!earlierOpen)}
                  title={earlierOpen ? "Fold what was typed here before this call" : "Show what was typed here before this call"}
                >
                  <ChevronRight className="rt-chevron h-3 w-3" aria-hidden="true" />
                  Earlier in this room · {earlier} line{earlier === 1 ? "" : "s"}
                </button>
              ) : earlier > 0 && i === earlier && earlierOpen ? (
                <p className="rt-note rt-divider">This call</p>
              ) : later > 0 && i === earlier + during ? (
                <p className="rt-note rt-divider">Later in this room</p>
              ) : null;
            const hidden = (inEarlier && !earlierOpen) || (item.kind === "passage" && density === "hidden");
            if (hidden && !divider) return null;
            let node: React.ReactNode = null;
            if (hidden) {
              /* the divider alone */
            } else if (item.kind === "passage") {
              node = (
                <PassageBlock
                  passage={item}
                  idPrefix={idPrefix}
                  open={isOpen(item)}
                  live={transcribing && item.index === newestIndex}
                  fresh={item.at > mountedAt.current}
                  recording={recording}
                  dayOf={anchorAt}
                  onToggle={() => toggle(item)}
                  selection={selection}
                  callId={call ? String(call._id) : undefined}
                />
              );
            } else if (item.kind === "event") {
              node = (
                <EventLine
                  row={item.row}
                  me={myUserId}
                  ownRoomId={ownRoomId}
                  ended={past}
                  explain={item.row._id === explainEventId}
                  fresh={item.at > mountedAt.current}
                  dayOf={anchorAt}
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
              node = <ChatLine m={m} sameAuthor={sameAuthor} fresh={fresh} dayOf={anchorAt} stage={surface === "stage"} onOpen={openSession} />;
            }
            const key = item.kind === "passage" ? `p${item.index}` : item.row._id;
            return (
              <Fragment key={key}>
                {divider}
                {node}
              </Fragment>
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
          {labels && <span className="rt-seg-word">{o.label}</span>}
        </button>
      ))}
    </span>
  );
}

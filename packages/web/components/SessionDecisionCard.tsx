"use client";

import { approvalButtonLabel } from "@codecast/shared/contracts/assistant";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDecisionAnswer } from "../hooks/useDecisionAnswer";
import { useDecisionDraftText } from "../hooks/useDecisionDraft";
import { PermissionStack } from "./PermissionCard";
import { useInboxStore, getProjectName } from "../store/inboxStore";
import { type DecisionStepper } from "../hooks/useDecisionQueue";
import { useDecisionCardKeys } from "./decisionCardKeys";
import { queueTier, messagesSinceAsk, optionPageSlugs, findDecisionAnchorMessage, decisionDraftKey, type QueueItem } from "../lib/decisionQueue";
import { isOnThreadRoute } from "../lib/openSessionAtMessage";
import { decisionHref, ladderRecommendation, ladderRecommenders } from "../lib/decisionLinks";
import { DecisionAnswerControls } from "./decisions/DecisionAnswerControls";
import { RunFallbackLine } from "./decisions/RunFallbackLine";
import { DecisionPlace } from "./decisions/DecisionPlace";
import { DecisionOptionList, RecommendedMark, TypeAnswerButton } from "./decisions/DecisionOptionList";
import { OptionPages } from "./decisions/OptionPages";
import { ChangeCardHeadline, ChangeCardVerdictBar, ChangeCardView } from "./decisions/ChangeCardView";
import { DecisionDiscussion } from "./decisions/DecisionDiscussion";
import { PassDecision } from "./decisions/PassDecision";
import { DecisionBody, DecisionFacts, DecisionLadder, hasDecisionBody } from "./decisions/DecisionSections";
import { GateRunChip } from "./decisions/DecisionCompactCard";
import { useSyncDecisionDetail, useDecisionDetail } from "../hooks/useSyncDecisionDetail";
import { useJumpToDecisionAsk } from "../hooks/useJumpToDecisionAsk";
import { useOpenSession } from "../hooks/useOpenSession";
import { formatTimeAgo } from "../lib/messageNavigator";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { PublishedPageEmbed } from "./PublishedPageEmbed";
import { useHeldOption } from "../lib/agentTabGuard";
import { NOT_CONFIRMED } from "@codecast/shared/contracts/secrets";
import { ChevronUp, ChevronDown } from "lucide-react";
import { ShareControl } from "./ShareControl";
import { policyTeamOf } from "@codecast/shared/contracts";
import "./decisions/decisions.css";
export { ThreadDecisionCard } from "./decisions/ThreadDecisionCard";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { DecisionProposalOrigin } from "./org/ProposalAuthorPill";
import { RoleFace } from "./org/RoleFace";
import { useIsHostedConversation } from "../hooks/useConversationAgentType";
import { LANE_COPY } from "./simple/lane";
import { useIsModernStyle } from "../hooks/useVisualStyle";
import { ModernDecisionDock } from "./conversation/ModernDecisionDock";
import { registerDecisionOpener } from "../lib/decisionOpenRegistry";
// The decision card lives INSIDE the conversation — it is how a session asks
// its human something, so it renders wherever the session renders (inbox,
// queue, a deep link). It has two sizes:
//
//   full  The sheet. The card owns the pane and reads like the decision page:
//         one row of chrome, then the question, the reasoning, the options
//         and the keys in ONE flow, scrolled together. Nothing is pinned, so
//         a long context never squeezes the options and tall options never
//         squeeze the context. Where the pane is wide enough the reasoning
//         and the options sit side by side and the options stick while the
//         reasoning scrolls; in one column a strip at the foot names the
//         options while they are below the fold and jumps to them.
//   line  The fold: one small badge at the right edge above the composer,
//         the question on its tooltip. The thread is the main event and
//         the fold spends one thin row on it; opening it is the sheet.
//
// A blocking ask parks the session, so it opens as the sheet. The queue is a
// place to decide, so everything there opens as the sheet. An advisory ask in
// a plain session view starts folded: the agent declared a default and kept
// working, and the thread is what the reader came for.
//
// The sheet sets its text in the conversation column (conv-col), the measure
// the messages and the composer use, so a wide pane does not stretch a
// paragraph across the whole screen; two columns widen that only to seat the
// options beside it.
//
// The queue (/questions) renders the same conversation pane and only adds a
// stepper through DecisionStepperContext (hooks/useDecisionQueue): position,
// advance, skip, leave.
//
// VIEWING IS READ-ONLY. Rendering this card must never write to the store or
// the server — a question leaves the queue only through an explicit gesture
// (an answer, a dismissal, Approve/Deny) or through server truth flipping the
// session row. A buffered AskUserQuestion is the case that makes this a hard
// rule: Claude Code holds the question in memory until it is answered, so the
// transcript has no poll and the permissions table has no row — the session
// row's permission_blocked status is the ONLY evidence, and any "nothing
// pending, must be resolved" inference on mount destroys a real question.

// A session can hold several open asks. Its card shows them one at a time:
// an answer brings up the next, already open, so a run of them is one digit
// each. `asks` is all of them in the order they are answered, this one
// included, and `onPick` brings another up without answering this one: the
// sheet steps through them from its header, the dock lists them as rows.
export type Size = "full" | "line";

// The last conversation whose ask was settled from its open sheet, and when:
// the next ask of that session opens as the sheet too, where the reader is.
let settledFromSheet: { conversationId: string; at: number } | null = null;
const CONTINUE_MS = 5_000;

// A jump to a message in this thread (targetNonce is when it was asked for)
// is a request to read the thread, so the sheet stays out of its way. An old
// target says nothing about an ask that arrives later.
const JUMP_FRESH_MS = 10_000;
const jumpedHere = (targetNonce: number | undefined) => targetNonce !== undefined && Date.now() - targetNonce < JUMP_FRESH_MS;
// The ask whose "asked … ago" line was pressed, and when. The jump opens the
// session in the inbox, which can draw the card anew (from a thread page, or a
// pane remounted on the switch) before the server has located the ask and set
// a target: that card opens folded too, or the press would be undone.
let foldedByAskJump: { key: string; at: number } | null = null;
const askJumpedHere = (key: string) => foldedByAskJump?.key === key && Date.now() - foldedByAskJump.at < JUMP_FRESH_MS;

export function SessionDecisionCard({ item, stepper, asks, onPick, startSize, allRows, onAllRows, targetNonce, scrollToMessage }: {
  item: QueueItem;
  stepper: DecisionStepper | null;
  /** The thread's open asks in order, this one among them. */
  asks?: readonly QueueItem[];
  /** Bring another of the thread's asks up, at the size this one is shown. */
  onPick?: (key: string, size: Size) => void;
  /** The size an ask picked from the card opens at: the one the person was reading. */
  startSize?: Size;
  /** The dock lists every other ask, not the first few, and the press that asks for that. */
  allRows?: boolean;
  onAllRows?: () => void;
  /** When the pane was last asked to open at a message, if it was. */
  targetNonce?: number;
  /** Scrolls this pane's thread to a loaded message. */
  scrollToMessage?: (messageId: string) => void;
}) {
  const {
    messages, needsMessages, poll, recentText, question, options, permissions, isPermissionCard, isInfraDialog,
    answer: answerItem, gated, answerFreeText: answerItemFreeText, dismiss: dismissItem,
  } = useDecisionAnswer(item);
  const answerDecision = useInboxStore((s) => s.answerDecision);
  const openSessionRoute = useOpenSession();
  // A hosted conversation waits on this answer and has no agent to speak of:
  // no dismiss (setting it aside would leave the assistant stuck) and no
  // agent in the wording.
  const hosted = useIsHostedConversation(item.conversationId);
  const modern = useIsModernStyle();
  const dockCollapsed = useInboxStore((s) => s.clientState?.ui?.decision_dock_collapsed === true);

  const [size, setSize] = useState<Size>(() => {
    if (startSize) return startSize;
    const continuing = settledFromSheet?.conversationId === item.conversationId && Date.now() - settledFromSheet.at < CONTINUE_MS;
    if (!stepper && (jumpedHere(targetNonce) || askJumpedHere(item.key))) return "line";
    return item.blocking || stepper || continuing ? "full" : "line";
  });
  useWatchEffect(() => {
    if (!stepper && jumpedHere(targetNonce)) setSize("line");
  }, [targetNonce]);
  const full = size === "full";
  // A typed answer left on this ask (before stepping to another, or on its
  // page) comes back open in the sheet rather than behind the button.
  const [otherOpen, setOtherOpen] = useState(() => item.source === "decide" && !!item.decisionId && (item.kind ?? "single") === "single"
    && !!useInboxStore.getState().drafts[decisionDraftKey(item.decisionId)]?.otherText);
  const [passOpen, setPassOpen] = useState(false);
  // What is typed as an answer. A `cast decide` ask keeps it in the store's
  // draft, as its page does, so stepping to another of the thread's asks,
  // folding the card or leaving the thread never loses it; a terminal ask has
  // no row to keep it under.
  const [draftText, setDraftText] = useDecisionDraftText(item.source === "decide" ? (item.decisionId ?? "") : "", "otherText");
  const [typedText, setTypedText] = useState("");
  const drafted = item.source === "decide" && !!item.decisionId;
  const otherText = drafted ? draftText : typedText;
  const setOtherText = drafted ? setDraftText : setTypedText;
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const optionsRef = useRef<HTMLDivElement>(null);

  // While the card owns the pane, the rest of the conversation (header, feed,
  // composer) is inert: the composer takes focus on mount, and every card key
  // was landing in its textarea. Set imperatively — `inert` only became a real
  // React attribute in 19. Folded, the thread gets itself back.
  useWatchEffect(() => {
    const root = rootRef.current;
    const pane = root?.parentElement;
    if (!root || !pane) return;
    const siblings = Array.from(pane.children).filter((el) => el !== root) as HTMLElement[];
    for (const el of siblings) (el as any).inert = full;
    if (full) {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== root && !root.contains(active)) active.blur();
      root.focus({ preventScroll: true });
    }
    return () => { for (const el of siblings) (el as any).inert = false; };
  }, [full]);


  // How far behind the ask is: wall clock and — the sharper signal — how many
  // messages the session has produced since. A blocking ask with traffic after
  // it means someone answered in the thread; an advisory one tells you whether
  // an override steers the agent or unwinds it.
  //
  // The live count is a direct primitive subscription: the queue's session row
  // rides a wake signature that deliberately drops message_count (heartbeat
  // churn), so item.session's copy goes stale between structural changes.
  const liveMessageCount = useInboxStore((s) => s.sessions[item.conversationId]?.message_count);
  const sinceAsk = useMemo(
    () => messagesSinceAsk(item, liveMessageCount !== undefined ? { message_count: liveMessageCount } : undefined, messages as any[]),
    [item, liveMessageCount, messages]
  );
  // An authored row's created_at is the ask time; a poll's honest timestamp is
  // its tool call's message. A permission prompt has neither (the client-side
  // first-seen stamp resets on reload), so it shows no age.
  const askedAt = item.source === "decide" ? item.createdAt : poll?.createdAt;
  const now = useCoarseNow(30_000);
  const askedRel = askedAt !== undefined ? formatTimeAgo(askedAt, now) : null;
  const askedLabel = askedRel === null ? null : askedRel === "now" ? "asked just now" : /^\d+[mhd]$/.test(askedRel) ? `asked ${askedRel} ago` : `asked ${askedRel}`;

  // Jump to the ask itself — the `cast decide` call rendered in the transcript
  // (useJumpToDecisionAsk, shared with the answer bubble's "the ask" link).
  const canJumpToAsk = item.source === "decide";
  const jumpToDecisionAsk = useJumpToDecisionAsk(item.conversationId, item.decisionId, item.question);
  const jumpToAsk = useCallback(() => {
    if (!canJumpToAsk) return;
    // The card may be covering the thread (full size). Hand the pane back
    // now, in the press's own tick: the scroll may wait on the server's
    // lookup of an ask older than the loaded rows (findAskMessage), and a
    // fold that waited with it left the press doing nothing visible. Do not
    // leave the queue for the list — the jump opens the session at the ask.
    if (!stepper) {
      foldedByAskJump = { key: item.key, at: Date.now() };
      setSize("line");
    }
    void jumpToDecisionAsk();
  }, [canJumpToAsk, jumpToDecisionAsk, stepper, item.key]);

  const defaultLabel = item.defaultOption !== undefined ? options.find((o) => o.index === item.defaultOption)?.label : undefined;


  // The kinds beyond a single choice (the-line.md L10: multi, rank, form)
  // answer through DecisionAnswerControls on the live store row, which
  // carries the form and takes the digit and Enter keys itself; the card's
  // own digits stand down for them.
  const decisionRow = useInboxStore((s) => (item.source === "decide" && item.decisionId ? s.sessionDecisions[item.decisionId] : undefined));
  const kind = item.source === "decide" ? (item.kind ?? "single") : "single";
  // A change card (LE11) answers Ship, Revise or Drop through its own
  // controls, which hold the digits and the Revise note.
  const card = decisionRow?.card;
  const richControls = (kind !== "single" || !!card) && !!decisionRow;
  // A card's Ship / Revise / Drop sit in the decision page's pinned bar, above
  // the card, so the card takes the sheet's width and the call stays in view.
  const cardBar = !!card && richControls;
  const pageSlugs = item.source === "decide" ? optionPageSlugs(item.options) : [];
  const shareHref = item.source === "decide" && item.decisionId ? decisionHref({ _id: item.decisionId, short_id: item.shortId }) : null;
  // The open sheet reads the decision the way its page does: the attached
  // document, the facts and the ladder come from the same detail
  // (DecisionSections), so the sheet never sends the reader elsewhere to
  // see what they are answering. Folded, nothing is drawn, so nothing loads.
  const decideId = item.source === "decide" ? item.decisionId : undefined;
  useSyncDecisionDetail(full ? decideId : undefined);
  const detail = useDecisionDetail(decideId);
  const detailDecision = detail ? (decisionRow ?? detail.decision) : null;

  const stepperDone = stepper?.onDone;
  const onDone = useCallback(() => {
    if (size === "full") settledFromSheet = { conversationId: item.conversationId, at: Date.now() };
    stepperDone?.();
  }, [size, item.conversationId, stepperDone]);
  const held = useHeldOption(decisionRow);
  const answer = useCallback((index: number) => {
    if (held(index)) return;
    const sent = answerItem(index);
    // One that asks for Touch ID moves on once confirmed; cancelled, it stays to be answered.
    if (gated(index)) void Promise.resolve(sent).then((r) => r !== NOT_CONFIRMED && onDone(), () => {});
    else onDone();
  }, [answerItem, onDone, held, gated]);
  const answerFreeText = useCallback((text: string) => {
    if (!text.trim()) return;
    answerItemFreeText(text);
    onDone();
  }, [answerItemFreeText, onDone]);
  const dismiss = useCallback(() => { dismissItem(); onDone(); }, [dismissItem, onDone]);
  // A `cast decide` row can be handed on; a terminal prompt and a hosted
  // assistant's ask (only its owner answers) cannot. A trial's stays put.
  const canPass = item.source === "decide" && !!item.decisionId && !hosted && !item.trial;

  const onExit = stepper?.onExit;
  // Off the inbox (the /questions stepper) "open" must leave for the inbox;
  // exiting the queue afterwards would push /questions back over it.
  const openSession = useCallback(() => openSessionRoute(item.conversationId), [openSessionRoute, item.conversationId]);

  // A fold by scrolling is undone by scrolling: wheel up at the top of the
  // sheet hands the pane to the thread, so wheel down at the bottom of the
  // thread hands it back. A fold by a button or a key stays folded.
  const foldedByScroll = useRef(false);
  const shrink = useCallback(() => { foldedByScroll.current = false; setSize("line"); }, []);
  // Scrolling away from the question is asking what led to it: the thread
  // opens at the ask, not at its tail.
  const shrinkByScroll = useCallback(() => {
    foldedByScroll.current = true;
    setSize("line");
    if (!canJumpToAsk) return;
    const ask = findDecisionAnchorMessage(messages as any[], item.decisionId, item.question);
    if (ask && scrollToMessage) scrollToMessage(ask._id);
    else if (isOnThreadRoute()) void jumpToDecisionAsk();
  }, [canJumpToAsk, messages, item.decisionId, item.question, scrollToMessage, jumpToDecisionAsk]);
  const grow = useCallback(() => setSize("full"), []);
  // The pinned state's `You` line names this ask ("answer the card…"); it opens
  // the sheet through here, so the line is a way in, not a dead end.
  useWatchEffect(() => registerDecisionOpener(item.conversationId, grow), [item.conversationId, grow]);
  // Answering in the person's own words: the text goes to the agent as the answer and the question closes.
  // "Discuss with …" on this card opens the same box, since talking it over with the session is that answer.
  const ownWords = !isInfraDialog && !richControls && !isPermissionCard;
  const openOwnWords = useCallback(() => { setOtherOpen(true); setTimeout(() => otherRef.current?.focus(), 0); }, []);

  // Folding swaps the sheet for the pill in one frame, and the eye loses it.
  // A faint veil the size of the sheet collapses into the pill, which answers
  // with one ring: the motion says where the question went.
  const wasFull = useRef(full);
  useLayoutEffect(() => {
    const folded = wasFull.current && !full;
    wasFull.current = full;
    const root = rootRef.current;
    const pane = root?.parentElement;
    const pill = root?.querySelector<HTMLElement>("[data-decision-fold-pill]");
    if (!folded || !root || !pane || !pill || typeof pill.animate !== "function") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const from = pane.getBoundingClientRect(), to = pill.getBoundingClientRect(), base = root.getBoundingClientRect();
    const tint = `var(${item.blocking ? "--sol-yellow" : "--sol-blue"})`;
    const veil = document.createElement("div");
    veil.style.cssText = `position:absolute;pointer-events:none;left:${from.left - base.left}px;top:${from.top - base.top}px;width:${from.width}px;height:${from.height}px;background:color-mix(in srgb, ${tint} 14%, transparent)`;
    root.appendChild(veil);
    const landed = `inset(${to.top - from.top}px ${from.right - to.right}px ${from.bottom - to.bottom}px ${to.left - from.left}px round 999px)`;
    const collapse = veil.animate(
      [{ clipPath: "inset(0px 0px 0px 0px round 0px)", opacity: 1 }, { clipPath: landed, opacity: 1, offset: 0.8 }, { clipPath: landed, opacity: 0 }],
      { duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    collapse.onfinish = collapse.oncancel = () => veil.remove();
    const ring = pill.animate(
      [{ boxShadow: "0 0 0 0 transparent" }, { boxShadow: `0 0 0 3px color-mix(in srgb, ${tint} 35%, transparent)`, offset: 0.5 }, { boxShadow: "0 0 0 7px transparent" }],
      { duration: 620, easing: "ease-out" },
    );
    return () => { collapse.cancel(); ring.cancel(); };
  }, [full, item.blocking]);

  useWatchEffect(() => {
    if (full || !foldedByScroll.current) return;
    const feed = rootRef.current?.parentElement?.querySelector<HTMLElement>("[data-sv-feed]");
    if (!feed) return;
    let pushed = 0;
    const onWheel = (e: WheelEvent) => {
      const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 2;
      if (e.deltaY <= 0 || !atBottom) { pushed = 0; return; }
      // A little past the end, so the last notch of a scroll down the thread
      // does not raise the sheet by itself.
      pushed += e.deltaY;
      if (pushed > 60) grow();
    };
    feed.addEventListener("wheel", onWheel, { passive: true });
    return () => feed.removeEventListener("wheel", onWheel);
  }, [full, grow]);

  // The thread's own asks, stepped where no queue is being walked.
  const threadIndex = asks ? asks.findIndex((a) => a.key === item.key) : -1;
  const threadAsks = asks && asks.length > 1 && threadIndex >= 0 && onPick ? asks : null;
  const stepThread = useCallback((delta: number) => {
    if (!threadAsks || !onPick) return;
    const next = threadAsks[(threadIndex + delta + threadAsks.length) % threadAsks.length];
    if (next) onPick(next.key, size);
  }, [threadAsks, threadIndex, onPick, size]);
  const onSkip = stepper?.onSkip ?? (threadAsks ? () => stepThread(1) : undefined);
  const onPrev = stepper ? stepper.onPrev : threadAsks ? () => stepThread(-1) : undefined;
  useDecisionCardKeys({ options, answer, answerFreeText, otherText, openSession, onSkip, onPrev, dismiss, onExit, full, stepper, isPermissionCard, isInfraDialog, richControls, shrink, grow, hosted, passOpen, canPass, threadAsks, setOtherOpen, setPassOpen, otherRef, rootRef, blocking: item.blocking });

  const answerRich = useCallback((input: Parameters<typeof answerDecision>[1]) => {
    if (!item.decisionId) return;
    answerDecision(item.decisionId, input);
    onDone();
  }, [item.decisionId, answerDecision, onDone]);

  // Where this ask sits: in the queue being stepped, else among its own
  // session's open asks when there are several.
  const place = stepper ?? (asks && asks.length > 1 && threadIndex >= 0 ? { position: threadIndex + 1, total: asks.length } : null);
  const tier = queueTier(item);
  const session = item.session;
  const project = session?.project_path ? getProjectName(session.project_path) : undefined;
  // A decision posted from a role's own standing thread is the role's ask
  // (org-staffing.md S28): the header reads as that role, its face and
  // handle, the way the inbox card draws it.
  const askingRole = session?.standing_role_id && session.role && String(session.role._id) === String(session.standing_role_id) ? session.role : null;

  // In one column the options come after the reasoning, so a long context
  // pushes them below the fold. A strip at the sheet's foot then names them
  // (the digits answer from anywhere; the strip says what they answer) and
  // scrolls to them on click. Two columns keep the options sticky and in
  // view, so the strip never fires there.
  const [optionsBelow, setOptionsBelow] = useState(false);
  useWatchEffect(() => {
    const root = bodyRef.current;
    const target = optionsRef.current;
    if (!full || !root || !target || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => {
      if (!e) return;
      setOptionsBelow(!e.isIntersecting && e.boundingClientRect.top >= (e.rootBounds?.bottom ?? Infinity));
    }, { root, threshold: 0 });
    io.observe(target);
    return () => io.disconnect();
  }, [full]);

  const dot = (
    <span className={`inline-block align-middle w-1.5 h-1.5 shrink-0 rounded-full ${tier === 1 ? "bg-sol-yellow animate-pulse" : tier === 2 ? "bg-sol-text-dim" : "bg-sol-blue"}`} />
  );

  const badges = (
    <>
      {item.trial && (
        <span className="inline-block whitespace-nowrap text-meta px-1.5 py-0.5 rounded border border-sol-magenta/30 text-sol-magenta shrink-0" data-decision-trial>trial · nothing ships</span>
      )}
      {item.impact !== undefined && (
        <span
          className={`inline-block whitespace-nowrap text-meta px-1.5 py-0.5 rounded border shrink-0 ${item.impact >= 4 ? "border-sol-orange/30 text-sol-orange" : "border-sol-border text-sol-text-dim"}`}
          title={item.impactReason}
          data-decision-impact={item.impact}
        >
          impact {item.impact}/5
        </span>
      )}
      {tier === 3 && (
        <span className="inline-block whitespace-nowrap text-meta px-1.5 py-0.5 rounded border border-sol-blue/30 text-sol-blue shrink-0">advisory</span>
      )}
      {tier === 2 && (
        <span className="inline-block whitespace-nowrap text-meta px-1.5 py-0.5 rounded border border-sol-border text-sol-text-dim shrink-0">session not running</span>
      )}
    </>
  );

  // Age in wall clock and in conversation distance. In the sheet it is also
  // the way back to the ask itself: clicking scrolls the thread to the
  // `cast decide` call. The fold is one button, so there it is plain text.
  const askedText = askedLabel === null ? null : (
    <>
      {askedLabel}
      {sinceAsk > 0 && <> · {sinceAsk} message{sinceAsk === 1 ? "" : "s"} since</>}
    </>
  );
  const askedLine = askedText === null ? null : (
    <button
      onClick={jumpToAsk}
      disabled={!canJumpToAsk}
      className={`text-meta ${canJumpToAsk ? "text-sol-blue underline decoration-dotted underline-offset-2 hover:decoration-solid" : "text-sol-text-dim cursor-default"} transition-colors`}
      title={canJumpToAsk ? "Go to the ask in the conversation" : undefined}
      aria-label={canJumpToAsk ? `Go to the ask in the conversation (${askedLabel})` : undefined}
    >
      {askedText}
    </button>
  );

  // A gate on a workflow run (the-line.md L4): the run this question pauses.
  const runChip = detailDecision?.workflow_run_id ? <GateRunChip runId={detailDecision.workflow_run_id} nodeId={detailDecision.gate_node_id} className="text-meta" /> : null;
  const facts = detail && detailDecision ? <DecisionFacts decision={detailDecision} detail={detail} className={card ? "" : "mt-4 mb-5"} /> : null;

  const whoIsAsking = askingRole ? (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 flex-[1_1_14rem]" data-decision-asker={askingRole.handle}>
      {dot}
      <RoleFace role={askingRole} size={18} className="shrink-0" />
      <button onClick={stepper ? openSession : undefined} className={`text-sm text-sol-text truncate ${stepper ? "hover:text-sol-blue transition-colors" : "cursor-default"}`}>
        <span className="text-sol-violet">@{askingRole.handle}</span> asks
      </button>
      {badges}
    </div>
  ) : (
    // One flow of words, not a row of boxes: a long title wraps and the chips
    // follow it, so nothing is cut short in a narrow pane.
    <div className="min-w-0 flex-[1_1_14rem] leading-relaxed [&>*+*]:ml-2">
      {dot}
      {stepper ? (
        // A button lays out as a box; an inline element lets the chips follow its last line.
        <span
          role="button"
          tabIndex={0}
          onClick={openSession}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSession(); } }}
          className="cursor-pointer text-sm text-sol-text hover:text-sol-blue transition-colors [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-1 focus-visible:outline-sol-blue"
        >
          {session?.title || "Session"}
        </span>
      ) : (
        <span className="text-sm text-sol-text">{item.blocking ? "Waiting on your decision" : "Asked for your steer"}</span>
      )}
      {stepper && project && <span className="decision-head-wide whitespace-nowrap text-meta text-sol-text-dim">{project}</span>}
      {badges}
    </div>
  );

  const escapeHatch = (
    <div className="flex items-center flex-wrap gap-4 text-meta text-sol-text-dim mt-4">
      {stepper && (
        <>
          <button onClick={openSession} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
            <KeyCap size="xs">o</KeyCap><span>open the session</span>
          </button>
          <button onClick={stepper.onSkip} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
            <KeyCap size="xs">s</KeyCap><span>skip for now</span>
          </button>
        </>
      )}
      {canPass && <PassDecision decisionId={item.decisionId!} open={passOpen} onOpenChange={setPassOpen} onPassed={onDone} label="pass to…" />}
      {!hosted && <button
        onClick={dismiss}
        className="flex items-center gap-1.5 hover:text-sol-red transition-colors"
        title={item.source === "decide"
          ? "Dismiss without answering — the agent is not told, and the question leaves your queue"
          : "Set this aside — it leaves your questions until the agent speaks again; the session keeps waiting"}
      >
        <KeyCap size="xs">x</KeyCap><span>dismiss</span>
      </button>}
      {stepper?.onExit && (
        <button onClick={stepper.onExit} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
          <KeyCap size="xs">esc</KeyCap><span>leave the queue</span>
        </button>
      )}
    </div>
  );

  // What the leads said, read beside the options they recommend between; a
  // change card's options sit in its bar, so there the ladder reads in the body.
  const ladderBlock = detail && detailDecision && detail.ladder.length > 0 ? (
    <div data-decision-ladder>
      <div className="decision-kicker">The ladder</div>
      <DecisionLadder decision={detailDecision} detail={detail} now={now} />
    </div>
  ) : null;
  const recommenders = decisionRow ? ladderRecommenders(decisionRow) : new Map<number, number>();
  const recommended = decisionRow ? ladderRecommendation(decisionRow) : undefined;

  // The reasoning, in the page's body type: the authored context of a
  // `cast decide`, or the detail an AskUserQuestion carries.
  const body = detail && detailDecision && hasDecisionBody(detailDecision, detail) ? <DecisionBody decision={detailDecision} detail={detail} /> : null;
  const reasoning = detail
    ? null
    : item.contextMd
    ? <MarkdownRenderer content={item.contextMd} />
    : poll?.question.detail
      ? <span className="whitespace-pre-line">{poll.question.detail}</span>
      : null;

  // A hosted approval's card already carries the call (context_md); the
  // assistant's latest words sit right above it in the conversation.
  const showRecent = !item.contextMd && !!recentText && !hosted;
  const showThreadState = !item.contextMd && !recentText && !!session?.thread_state;
  const showUnreadable = needsMessages && !poll && !isPermissionCard && !isInfraDialog;
  const contextBlock = (card || detail || reasoning || showRecent || showThreadState || item.reportSlug || showUnreadable) ? (
    <div className="decision-sheet-context min-w-0 space-y-4" data-reveal-span>
      {/* The headline above already says the change and its cause. */}
      {card && <ChangeCardView card={card} density="inline" change={false} recommend={!richControls} summarized={cardBar} />}
      {/* A run's gate is owned by the session that started the run or the
          project's lead, not this log: discuss it with them (ct-58330). */}
      {decideId && decisionRow?.workflow_run_id && <DecisionDiscussion decisionId={decideId} compact onDiscuss={ownWords ? openOwnWords : undefined} />}
      {reasoning && (
        <div className="decision-body text-sm text-sol-text-muted border-l-2 border-sol-border pl-4" data-decision-context>
          {reasoning}
        </div>
      )}
      {showRecent && (
        <div>
          <div className="text-mark uppercase tracking-wide text-sol-text-dim mb-1">most recent from the agent</div>
          <div className="text-sm text-sol-text-muted border-l-2 border-sol-border pl-3">
            <MarkdownRenderer content={recentText!} />
          </div>
        </div>
      )}
      {showThreadState && (
        <div className="text-sm text-sol-text-muted border-l-2 border-sol-border pl-3 whitespace-pre-wrap">{session!.thread_state}</div>
      )}
      {body}
      {card && facts}
      {item.reportSlug && !card && !detail && <PublishedPageEmbed slug={item.reportSlug} decision={decideId} />}
      {cardBar && ladderBlock}
      {showUnreadable && (
        <div className="text-sm text-sol-text-dim">
          This session is waiting on you, but its question is only visible in its terminal so far.
          Open the session to read it, or type an answer below.
        </div>
      )}
    </div>
  ) : null;

  // The answer surface: one row per option, its meaning under its label, the
  // row itself the answer; the digits are live whenever the sheet is open
  // (the key handler above). Pages compare above the rows; a permission
  // prompt renders the real Approve/Deny stack with its own y/n keys.
  const answerBlock = (
    <div ref={optionsRef} className="decision-sheet-options min-w-0" data-decision-options data-reveal-span>
      {pageSlugs.length > 0 && (
        <div className="mb-3">
          <div className="text-mark uppercase tracking-wide text-sol-text-dim mb-1">the options, as pages</div>
          <OptionPages decision={decisionRow ?? { options: item.options, status: "pending" }} answerable={kind === "single"} onAnswer={answer} />
        </div>
      )}
      {isPermissionCard && (
        <div className="mb-3">
          <div className="text-mark uppercase tracking-wide text-sol-text-dim mb-1">waiting on your approval</div>
          <PermissionStack permissions={permissions} />
        </div>
      )}
      {isInfraDialog && (
        <div className="text-[12px] text-sol-text-dim mb-2">
          This is a usage prompt from the agent's harness, not a decision — open the session to handle it.
        </div>
      )}
      {richControls && decisionRow && (
        <DecisionAnswerControls decision={decisionRow} onAnswer={answerRich} keys keyScope={rootRef} />
      )}
      {!isInfraDialog && !richControls && (
        <div className="space-y-2">
          {options.length > 0 && <DecisionOptionList
            options={hosted ? options.map((o) => ({ ...o, label: approvalButtonLabel(o.label) })) : options}
            keys
            onPick={(n) => { const opt = options[n]; if (opt) answer(opt.index); }}
            // A hosted conversation marks no option before the person picks one.
            // The ladder's pick, else the first, reads as the primary row.
            tone={(n) => (options[n]?.index === (recommended ?? options[0]?.index) && !hosted && !held(options[n]?.index ?? -1) ? "primary" : "plain")}
            held={(n) => held(options[n]?.index ?? -1)}
            gated={(n) => gated(options[n]?.index ?? -1)}
            tags={(n) => (
              <>
                {recommenders.has(options[n]?.index ?? -1) && <RecommendedMark count={recommenders.get(options[n]!.index)} />}
                {item.defaultOption === options[n]?.index && (
                  <span className="text-meta px-1.5 py-0.5 rounded border border-sol-border text-sol-text-dim">proceeding with this</span>
                )}
              </>
            )}
          />}
          {/* A permission prompt is answered by Approve/Deny only; an infra
              dialog is handled in the session. Neither takes typed answers. */}
          {!isPermissionCard && (
            <TypeAnswerButton keys onOpen={openOwnWords} />
          )}
        </div>
      )}
      <RunFallbackLine run={decisionRow?.status === "pending" ? decisionRow.run : undefined} className="mt-3" />
      {otherOpen && (
        <div className="mt-3">
          <textarea
            ref={otherRef}
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            rows={3}
            placeholder={hosted ? LANE_COPY.approval.typeAnswer : "Answer in your own words; this goes to the agent as a message."}
            className="w-full bg-sol-card border border-sol-border rounded px-2 py-1.5 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-blue/50"
          />
          <div className="flex items-center gap-2 mt-1 text-meta text-sol-text-dim">
            <KeyCap size="xs">return</KeyCap><span>send</span>
            <KeyCap size="xs">esc</KeyCap><span>cancel</span>
          </div>
        </div>
      )}
      {!cardBar && escapeHatch}
      {!cardBar && ladderBlock && <div className="mt-6">{ladderBlock}</div>}
    </div>
  );

  if (full) {
    return (
      <div
        ref={rootRef}
        tabIndex={-1}
        data-session-decision={item.conversationId}
        // The open sheet owns its plain keys (t, o, s, p, x): the global
        // dispatcher runs first and would take t for the branch map.
        data-owns-keys
        // z-40 is load-bearing: the pane carries sticky header, state bar,
        // composer and a z-30 scroll button, each its own stacking context.
        // decision-doc: the document page's type (the serif question, the
        // body's leading), so the sheet reads like the page it stands for.
        // decision-sheet: the container the two-column layout queries.
        className="decision-doc decision-sheet absolute inset-0 z-40 flex flex-col bg-sol-bg outline-none"
        data-card={cardBar ? "true" : undefined}
        onWheel={(e) => {
          // Scrolling up at the top of the question hands the pane to the thread.
          if (e.deltaY < 0 && (bodyRef.current?.scrollTop ?? 0) <= 0) shrinkByScroll();
        }}
      >
        {/* One row of chrome, kept while the rest scrolls: who is asking,
            where this sits in the queue, and the way back to the thread. */}
        <div className="decision-sheet-head-cq shrink-0 border-b border-sol-border/70">
          <div className="decision-sheet-col mx-auto w-full px-6 min-h-10 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
            {whoIsAsking}
            {stepper ? (
              <DecisionPlace position={stepper.position} total={stepper.total} queue
                onPrev={stepper.onPrev && stepper.total > 1 ? stepper.onPrev : undefined} onNext={stepper.total > 1 ? stepper.onSkip : undefined} />
            ) : place && (
              <DecisionPlace position={place.position} total={place.total}
                onPrev={threadAsks ? () => stepThread(-1) : undefined} onNext={threadAsks ? () => stepThread(1) : undefined} />
            )}
            {/* A hosted approval is the person's own: no link to share it, and
                its conversation is one tap away in the escape hatch. */}
            {shareHref && decideId && !hosted && (
              <ShareControl label="decision" path={shareHref} publicShare={{ kind: "decision", id: decideId, token: ((decisionRow ?? detail?.decision) as any)?.share_token, team: policyTeamOf("decisions", decisionRow ?? detail?.decision) }} className="shrink-0" />
            )}
            {!hosted && <button
              onClick={shrink}
              className="shrink-0 flex items-center gap-1 pl-2 pr-3 py-0.5 rounded-full border border-sol-border text-meta text-sol-text-muted hover:text-sol-text hover:bg-sol-card transition-colors"
              title="Fold the question away and read the thread"
            >
              <ChevronDown className="w-3.5 h-3.5" />
              <span className="decision-head-wide">Read the thread</span>
            </button>}
          </div>
        </div>
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto">
          <div className="decision-sheet-col mx-auto w-full px-6 pt-4 pb-6">
            {(askedLine || runChip) && <div className="mb-2 flex items-center gap-3 flex-wrap">{askedLine}{runChip}</div>}
            <DecisionProposalOrigin contextMd={item.contextMd} className="mb-2 text-[12px]" size="md" />
            {/* A card leads with its change, the way its page does. */}
            {card
              ? <ChangeCardHeadline card={card} question={question} className="mb-2" />
              : question && <h1 className={`decision-question text-sol-text ${facts ? "" : "mb-5"}`}>{question}</h1>}
            {!card && facts}
            {cardBar ? (
              <>
                <ChangeCardVerdictBar card={card!}>{answerBlock}</ChangeCardVerdictBar>
                <div className="mt-6">{contextBlock}</div>
                {escapeHatch}
              </>
            ) : (
              <div className="decision-sheet-grid" data-split={contextBlock ? "true" : "false"}>
                {contextBlock}
                {answerBlock}
              </div>
            )}
          </div>
        </div>
        {optionsBelow && options.length > 0 && (
          <button
            onClick={() => optionsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })}
            className="shrink-0 w-full border-t border-sol-border bg-sol-bg hover:bg-sol-card transition-colors"
            title="The options are below the reasoning: jump to them"
            data-decision-options-strip
          >
            {/* Each answer reads whole: a long one wraps in its column, and in a narrow pane they stack. */}
            <div className="decision-sheet-col mx-auto w-full px-6 py-2 flex items-start gap-x-4 gap-y-1.5 min-w-0 text-left text-meta leading-snug text-sol-text-muted">
              <ChevronDown className="w-3.5 h-3.5 mt-px shrink-0 text-sol-text-dim" />
              <span className="flex flex-1 flex-wrap gap-x-4 gap-y-1.5 min-w-0">
                {options.map((o, n) => (
                  <span key={n} className="flex-[1_1_12rem] min-w-0 flex items-start gap-1.5">
                    {n < 9 && <KeyCap size="xs">{String(n + 1)}</KeyCap>}
                    <span className="min-w-0 [overflow-wrap:anywhere]">{o.label.replace(" (Recommended)", "")}</span>
                  </span>
                ))}
              </span>
            </div>
          </button>
        )}
      </div>
    );
  }

  // The fold: a badge, not a bar. One small pill at the right edge above the
  // composer says an ask is waiting (and where it sits in the queue); the
  // question itself is the pill's tooltip and one click away. The thread is
  // the main event, so the fold spends one thin row and nothing more.
  const foldTitle = [askingRole ? [`@${askingRole.handle} asks`, question].filter(Boolean).join(": ") : question || "Waiting on you", defaultLabel ? `proceeding with ${defaultLabel}` : null].filter(Boolean).join(" — ");
  // Modern docks the ask itself (ModernDecisionDock): the question and its options as Buttons, Open for the sheet.
  if (modern) return (
    <div ref={rootRef} tabIndex={-1} data-session-decision={item.conversationId} className="decision-card decision-fold relative z-20 shrink-0 conv-col mx-auto w-full px-2 sm:px-3 md:px-4 outline-none" onWheel={(e) => { if (e.deltaY > 0 && stepper) grow(); }}>
      <ModernDecisionDock question={question} kicker={askingRole ? `@${askingRole.handle} asks` : stepper ? (session?.title || "Session") : undefined} aside={place ? `${place.position} of ${place.total}` : undefined} options={hosted ? options.map((o) => ({ ...o, label: approvalButtonLabel(o.label) })) : options} recommended={item.defaultOption ?? (hosted ? undefined : options[0]?.index)} proceedingWith={item.defaultOption} proceedingLabel={defaultLabel} text={otherText} onText={setOtherText} othersOpen={allRows} onOthersOpen={onAllRows} others={stepper || !threadAsks ? undefined : threadAsks.flatMap((a, i) => (a.key === item.key ? [] : [{ key: a.key, position: i + 1, question: a.question }]))} onPick={onPick ? (key) => onPick(key, "line") : undefined} held={(i) => !!held(i)} onAnswer={answer} onAnswerText={isPermissionCard || isInfraDialog || richControls ? undefined : answerFreeText} onOpen={grow} answerable={!isPermissionCard && !isInfraDialog && !richControls} collapsed={dockCollapsed} onCollapsed={(v) => useInboxStore.getState().updateClientUI({ decision_dock_collapsed: v })} />
    </div>
  );
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-session-decision={item.conversationId}
      // relative z-20: the composer below paints a fade gradient up over its
      // neighbour, which would wash out the pill.
      className="decision-card decision-fold relative z-20 shrink-0 flex justify-end px-4 py-1 outline-none"
      onWheel={(e) => { if (e.deltaY > 0 && stepper) grow(); }}
    >
      <button
        onClick={grow}
        title={foldTitle}
        data-decision-fold-pill
        className={`flex items-center gap-1.5 pl-2 pr-2.5 py-0.5 rounded-full border text-meta transition-colors ${
          item.blocking ? "border-sol-yellow/50 text-sol-text hover:bg-sol-yellow/10" : "border-sol-blue/40 text-sol-blue hover:bg-sol-blue hover:text-sol-bg"
        }`}
      >
        {dot}
        {askingRole && <RoleFace role={askingRole} size={14} className="shrink-0" />}
        <span className="truncate max-w-[16rem]">{askingRole ? `@${askingRole.handle} asks` : stepper ? (session?.title || "Session") : item.blocking ? "Waiting on your decision" : "Asked for your steer"}</span>
        <span className="opacity-70">{place ? `· ${place.position} of ${place.total}` : "· answer"}</span>
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

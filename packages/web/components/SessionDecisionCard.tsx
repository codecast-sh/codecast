"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { usePendingPermissions } from "../hooks/useSyncPendingPermissions";
import { isUsageLimitDialog } from "@codecast/shared/contracts";
import { PermissionStack, PERMISSION_SKIP_TOOLS } from "./PermissionCard";
import { useInboxStore, getProjectName } from "../store/inboxStore";
import { openQuestionFromMessages, lastAssistantText, visibleOptions, type DecisionStepper } from "../hooks/useDecisionQueue";
import { queueTier, routeQueueKey, messagesSinceAsk, needsDocumentPage, optionPageSlugs, type QueueItem } from "../lib/decisionQueue";
import { decisionHref } from "../lib/decisionLinks";
import { DecisionAnswerControls } from "./decisions/DecisionAnswerControls";
import { DecisionOptionList, TypeAnswerButton } from "./decisions/DecisionOptionList";
import { OptionPages } from "./decisions/OptionPages";
import { useJumpToDecisionAsk } from "../hooks/useJumpToDecisionAsk";
import { formatTimeAgo } from "../lib/messageNavigator";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { buildSingleAnswerPayload, buildFreeTextPayload } from "../lib/pollPayload";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { hasOpenModal } from "../shortcuts";
import { PublishedPageEmbed } from "./PublishedPageEmbed";
import { ChevronUp, ChevronDown, ArrowUpRight } from "lucide-react";
import "./decisions/decisions.css";

import { useWatchEffect } from "../hooks/useWatchEffect";
import { DecisionProposalOrigin } from "./org/ProposalAuthorPill";
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

type Size = "full" | "line";

export function SessionDecisionCard({ item, stepper }: { item: QueueItem; stepper: DecisionStepper | null }) {
  const answerDecision = useInboxStore((s) => s.answerDecision);
  const addOptimisticMessage = useInboxStore((s) => s.addOptimisticMessage);
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const resolveSessionQuestion = useInboxStore((s) => s.resolveSessionQuestion);
  const navigateToSession = useInboxStore((s) => s.navigateToSession);

  const [size, setSize] = useState<Size>(() => (item.blocking || stepper ? "full" : "line"));
  const full = size === "full";
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
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

  // A poll card has no authored payload, so its question and options come from
  // the conversation itself — already in the store (useConversationMessages).
  const needsMessages = item.source !== "decide";
  const messages = useInboxStore((s) => s.messages[item.conversationId]);

  // A permission-blocked session carries a tool name and an argument preview,
  // not a question with options: render the real Approve/Deny card, which owns
  // its own mutation and y/n keys — approving a command must never be reachable
  // from the digit that answered the card before it in the queue.
  const permissionsRaw = usePendingPermissions(item.source === "permission" ? item.conversationId : null);
  const permissions = useMemo(
    () => (permissionsRaw ?? []).filter((p: any) => !PERMISSION_SKIP_TOOLS.has(p.tool_name)),
    [permissionsRaw]
  );
  const isPermissionCard = item.source === "permission" && permissions.length > 0;

  const poll = useMemo(() => (needsMessages ? openQuestionFromMessages(messages as any[]) : null), [needsMessages, messages]);
  const recentText = useMemo(() => (needsMessages ? lastAssistantText(messages as any[]) : undefined), [needsMessages, messages]);

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
  const jumpToAsk = useCallback(async () => {
    if (!canJumpToAsk) return;
    if (!(await jumpToDecisionAsk())) return;
    // The card may be covering the thread (full size). Hand the pane back
    // so the jump is visible. Do not leave the queue for the list — the
    // jump already opened the session at the ask.
    if (!stepper) setSize("line");
  }, [canJumpToAsk, jumpToDecisionAsk, stepper]);

  // The session title is WHO is asking, never WHAT. A poll-sourced card
  // renders no question text until the poll payload is readable from the
  // transcript — showing the title as the question and swapping it out a beat
  // later is exactly the "question changed under me" report.
  const question = poll?.question.question ?? (item.source === "decide" ? item.question : "");
  const options = useMemo(() => {
    if (item.source === "decide") return item.options.map((o, index) => ({ label: o.label, description: o.description, index }));
    return poll ? visibleOptions(poll.question) : [];
  }, [item, poll]);
  const defaultLabel = item.defaultOption !== undefined ? options.find((o) => o.index === item.defaultOption)?.label : undefined;

  // A usage/billing interstitial is not a decision about the work, and its
  // options commit real money — exactly what a queue that advances on a digit
  // must never put under your finger. Rendered un-answerable (no digits, no
  // option buttons); skip or dismiss it, or open the session to handle it.
  const isInfraDialog = item.source !== "decide" && isUsageLimitDialog(options.map((o) => o.label));

  // The kinds beyond a single choice (the-line.md L10: multi, rank, form)
  // answer through DecisionAnswerControls on the live store row, which
  // carries the form and takes the digit and Enter keys itself; the card's
  // own digits stand down for them. Anything with a document or option pages
  // links to the decision page, where there is room to read.
  const decisionRow = useInboxStore((s) => (item.source === "decide" && item.decisionId ? s.sessionDecisions[item.decisionId] : undefined));
  const kind = item.source === "decide" ? (item.kind ?? "single") : "single";
  const richControls = kind !== "single" && !!decisionRow;
  const pageSlugs = item.source === "decide" ? optionPageSlugs(item.options) : [];
  const documentHref = item.source === "decide" && item.decisionId && needsDocumentPage(item) ? decisionHref({ _id: item.decisionId, short_id: item.shortId }) : null;

  const onDone = stepper?.onDone;
  const answer = useCallback((index: number) => {
    if (item.source === "decide" && item.decisionId) {
      answerDecision(item.decisionId, { index });
    } else if (poll) {
      const content = buildSingleAnswerPayload(poll.question, index);
      const clientId = addOptimisticMessage(item.conversationId, content);
      sendMessage(item.conversationId, content, undefined, clientId);
    }
    onDone?.();
  }, [item, poll, answerDecision, addOptimisticMessage, sendMessage, onDone]);

  const answerFreeText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (item.source === "decide" && item.decisionId) {
      answerDecision(item.decisionId, { text: trimmed });
    } else {
      // No parsed poll needed: the free-text payload is the decline-then-type
      // form, which the daemon can drive at any AskUserQuestion menu — this is
      // how a buffered question (present in no transcript yet) gets answered.
      const content = buildFreeTextPayload(trimmed);
      const clientId = addOptimisticMessage(item.conversationId, content);
      sendMessage(item.conversationId, content, undefined, clientId);
    }
    onDone?.();
  }, [item, answerDecision, addOptimisticMessage, sendMessage, onDone]);

  // "I am not going to answer this." A `cast decide` row resolves as dismissed
  // (the agent is not told); a poll/permission card is marked resolved in the
  // store — it leaves the queue AND the rail's QUESTIONS section together, and
  // returns only if the agent speaks again (the session itself keeps waiting).
  const dismiss = useCallback(() => {
    if (item.source === "decide" && item.decisionId) answerDecision(item.decisionId, { dismiss: true });
    else resolveSessionQuestion(item.conversationId);
    onDone?.();
  }, [item, answerDecision, resolveSessionQuestion, onDone]);

  const onExit = stepper?.onExit;
  const openSession = useCallback(() => {
    navigateToSession(item.conversationId);
    onExit?.();
  }, [navigateToSession, item.conversationId, onExit]);

  const shrink = useCallback(() => setSize("line"), []);
  const grow = useCallback(() => setSize("full"), []);

  const onSkip = stepper?.onSkip;
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const action = routeQueueKey(e, {
        modalOpen: hasOpenModal(),
        editing: !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
        inOwnFreeTextBox: !!target && target === otherRef.current,
        isPermissionCard,
        // An infra dialog's options commit money — no digit may reach them;
        // a multi, rank or form takes its own digits in its controls.
        optionCount: isInfraDialog || richControls ? 0 : options.length,
        sheet: full ? "full" : "peek",
      });
      if (!action) return;
      // Outside the queue, a folded card must not claim the thread's keys:
      // j/k/digits belong to the conversation until the card owns the pane.
      if (!stepper && !full && action.kind !== "commit-free-text" && action.kind !== "close-free-text") {
        if (action.kind !== "full") return;
      }
      e.preventDefault();
      e.stopPropagation();
      switch (action.kind) {
        case "commit-free-text": answerFreeText(otherText); break;
        case "close-free-text": setOtherOpen(false); break;
        case "answer": { const opt = options[action.option]; if (opt) answer(opt.index); break; }
        case "open-session": if (stepper) openSession(); break;
        case "skip": onSkip?.(); break;
        case "dismiss": dismiss(); break;
        case "open-free-text": if (!isPermissionCard && !isInfraDialog && !richControls) { setOtherOpen(true); setTimeout(() => otherRef.current?.focus(), 0); } break;
        case "peek": shrink(); break;
        case "full": grow(); break;
        case "restore-question": grow(); break;
        // Escape from the full card: leave the queue, or — in a plain session
        // view — hand the pane back to the thread.
        case "exit-queue": if (onExit) onExit(); else shrink(); break;
      }
    };
    // CAPTURE phase: the global shortcut layer claims arrows and digits for
    // list navigation and would eat them first.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [options, answer, answerFreeText, otherText, openSession, onSkip, dismiss, onExit, full, stepper, isPermissionCard, isInfraDialog, richControls, shrink, grow]);

  const answerRich = useCallback((input: Parameters<typeof answerDecision>[1]) => {
    if (!item.decisionId) return;
    answerDecision(item.decisionId, input);
    onDone?.();
  }, [item.decisionId, answerDecision, onDone]);

  const tier = queueTier(item);
  const session = item.session;
  const project = session?.project_path ? getProjectName(session.project_path) : undefined;

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
    <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${tier === 1 ? "bg-sol-yellow animate-pulse" : tier === 2 ? "bg-sol-text-dim" : "bg-sol-blue"}`} />
  );

  const badges = (
    <>
      {tier === 3 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-blue/30 text-sol-blue shrink-0">advisory</span>
      )}
      {tier === 2 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-border text-sol-text-dim shrink-0">session not running</span>
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
      className={`text-[11px] text-sol-text-dim ${canJumpToAsk ? "hover:text-sol-text hover:underline" : "cursor-default"} transition-colors`}
      title={canJumpToAsk ? "Go to the ask in the conversation" : undefined}
    >
      {askedText}
    </button>
  );

  const documentLink = documentHref && (
    <a href={documentHref} data-decision-document className="inline-flex items-center gap-1 text-[11px] text-sol-blue hover:underline" title="The decision page: the document, the pages, the ladder">
      read the full decision<ArrowUpRight className="w-3 h-3" />
    </a>
  );

  const whoIsAsking = (
    <div className="flex items-center gap-2 min-w-0 flex-1">
      {dot}
      {stepper ? (
        <button onClick={openSession} className="text-sm text-sol-text hover:text-sol-blue transition-colors truncate">
          {session?.title || "Session"}
        </button>
      ) : (
        <span className="text-sm text-sol-text truncate">{item.blocking ? "Waiting on your decision" : "Asked for your steer"}</span>
      )}
      {stepper && project && <span className="text-[11px] text-sol-text-dim truncate">{project}</span>}
      {badges}
    </div>
  );

  const escapeHatch = (
    <div className="flex items-center flex-wrap gap-4 text-[11px] text-sol-text-dim mt-4">
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
      <button
        onClick={dismiss}
        className="flex items-center gap-1.5 hover:text-sol-red transition-colors"
        title={item.source === "decide"
          ? "Dismiss without answering — the agent is not told, and the question leaves your queue"
          : "Set this aside — it leaves your questions until the agent speaks again; the session keeps waiting"}
      >
        <KeyCap size="xs">x</KeyCap><span>dismiss</span>
      </button>
      {stepper?.onExit && (
        <button onClick={stepper.onExit} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
          <KeyCap size="xs">esc</KeyCap><span>leave the queue</span>
        </button>
      )}
    </div>
  );

  // The reasoning, in the page's body type: the authored context of a
  // `cast decide`, or the detail an AskUserQuestion carries.
  const reasoning = item.contextMd
    ? <MarkdownRenderer content={item.contextMd} />
    : poll?.question.detail
      ? <span className="whitespace-pre-line">{poll.question.detail}</span>
      : null;

  const showRecent = !item.contextMd && !!recentText;
  const showThreadState = !item.contextMd && !recentText && !!session?.thread_state;
  const showUnreadable = needsMessages && !poll && !isPermissionCard && !isInfraDialog;
  const contextBlock = (reasoning || showRecent || showThreadState || item.reportSlug || showUnreadable) ? (
    <div className="decision-sheet-context min-w-0 space-y-4">
      {reasoning && (
        <div className="decision-body text-sm text-sol-text-muted border-l-2 border-sol-border pl-4" data-decision-context>
          {reasoning}
        </div>
      )}
      {showRecent && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-sol-text-dim mb-1">most recent from the agent</div>
          <div className="text-sm text-sol-text-muted border-l-2 border-sol-border pl-3">
            <MarkdownRenderer content={recentText!} />
          </div>
        </div>
      )}
      {showThreadState && (
        <div className="text-sm text-sol-text-muted border-l-2 border-sol-border pl-3 whitespace-pre-wrap">{session!.thread_state}</div>
      )}
      {item.reportSlug && <PublishedPageEmbed slug={item.reportSlug} />}
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
    <div ref={optionsRef} className="decision-sheet-options min-w-0" data-decision-options>
      {pageSlugs.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wide text-sol-text-dim mb-1">the options, as pages</div>
          <OptionPages decision={decisionRow ?? { options: item.options, status: "pending" }} answerable={kind === "single"} onAnswer={answer} />
        </div>
      )}
      {isPermissionCard && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wide text-sol-text-dim mb-1">waiting on your approval</div>
          <PermissionStack permissions={permissions} />
        </div>
      )}
      {isInfraDialog && (
        <div className="text-[12px] text-sol-text-dim mb-2">
          This is a usage prompt from the agent's harness, not a decision — open the session to handle it.
        </div>
      )}
      {richControls && decisionRow && (
        <DecisionAnswerControls decision={decisionRow} onAnswer={answerRich} keys />
      )}
      {!isInfraDialog && !richControls && (
        <div className="space-y-2">
          {options.length > 0 && <DecisionOptionList
            options={options}
            keys
            onPick={(n) => { const opt = options[n]; if (opt) answer(opt.index); }}
            tone={(n) => (n === 0 ? "primary" : "plain")}
            tags={(n) => item.defaultOption === options[n]?.index && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-border text-sol-text-dim">proceeding with this</span>
            )}
          />}
          {/* A permission prompt is answered by Approve/Deny only; an infra
              dialog is handled in the session. Neither takes typed answers. */}
          {!isPermissionCard && (
            <TypeAnswerButton keys onOpen={() => { setOtherOpen(true); setTimeout(() => otherRef.current?.focus(), 0); }} />
          )}
        </div>
      )}
      {otherOpen && (
        <div className="mt-3">
          <textarea
            ref={otherRef}
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            rows={3}
            placeholder="Answer in your own words — this goes to the agent as a message."
            className="w-full bg-sol-card border border-sol-border rounded px-2 py-1.5 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-blue/50"
          />
          <div className="flex items-center gap-2 mt-1 text-[11px] text-sol-text-dim">
            <KeyCap size="xs">return</KeyCap><span>send</span>
            <KeyCap size="xs">esc</KeyCap><span>cancel</span>
          </div>
        </div>
      )}
      {escapeHatch}
    </div>
  );

  if (full) {
    return (
      <div
        ref={rootRef}
        tabIndex={-1}
        // z-40 is load-bearing: the pane carries sticky header, state bar,
        // composer and a z-30 scroll button, each its own stacking context.
        // decision-doc: the document page's type (the serif question, the
        // body's leading), so the sheet reads like the page it stands for.
        // decision-sheet: the container the two-column layout queries.
        className="decision-doc decision-sheet absolute inset-0 z-40 flex flex-col bg-sol-bg outline-none"
        onWheel={(e) => {
          // Scrolling up at the top of the question hands the pane to the thread.
          if (e.deltaY < 0 && (bodyRef.current?.scrollTop ?? 0) <= 0) shrink();
        }}
      >
        {/* One row of chrome, kept while the rest scrolls: who is asking,
            where this sits in the queue, and the way back to the thread. */}
        <div className="shrink-0 border-b border-sol-border/70">
          <div className="decision-sheet-col mx-auto w-full px-6 h-10 flex items-center gap-3 min-w-0">
            {whoIsAsking}
            {stepper && <span className="shrink-0 text-[11px] text-sol-text-dim">decision {stepper.position} of {stepper.total}</span>}
            <button
              onClick={shrink}
              className="shrink-0 flex items-center gap-1 pl-2 pr-3 py-0.5 rounded-full border border-sol-border text-[11px] text-sol-text-muted hover:text-sol-text hover:bg-sol-card transition-colors"
              title="Fold the question away and read the thread"
            >
              <ChevronDown className="w-3.5 h-3.5" />
              <span>Read the thread</span>
            </button>
          </div>
        </div>
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto">
          <div className="decision-sheet-col mx-auto w-full px-6 pt-4 pb-6">
            {(askedLine || documentLink) && <div className="mb-2 flex items-center gap-3 flex-wrap">{askedLine}{documentLink}</div>}
            <DecisionProposalOrigin contextMd={item.contextMd} className="mb-2 text-[12px]" size="md" />
            {question && <h1 className="decision-question text-sol-text mb-5">{question}</h1>}
            <div className="decision-sheet-grid" data-split={contextBlock ? "true" : "false"}>
              {contextBlock}
              {answerBlock}
            </div>
          </div>
        </div>
        {optionsBelow && options.length > 0 && (
          <button
            onClick={() => optionsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })}
            className="shrink-0 w-full border-t border-sol-border bg-sol-bg hover:bg-sol-card transition-colors"
            title="The options are below the reasoning: jump to them"
            data-decision-options-strip
          >
            <div className="decision-sheet-col mx-auto w-full px-6 h-9 flex items-center gap-4 min-w-0 text-[11px] text-sol-text-muted">
              <ChevronDown className="w-3.5 h-3.5 shrink-0 text-sol-text-dim" />
              {options.map((o, n) => (
                <span key={n} className="flex-1 min-w-0 flex items-center gap-1.5">
                  {n < 9 && <KeyCap size="xs">{String(n + 1)}</KeyCap>}
                  <span className="truncate">{o.label.replace(" (Recommended)", "")}</span>
                </span>
              ))}
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
  const foldTitle = [question || "Waiting on you", defaultLabel ? `proceeding with ${defaultLabel}` : null].filter(Boolean).join(" — ");
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      // relative z-20: the composer below paints a fade gradient up over its
      // neighbour, which would wash out the pill.
      className="decision-card decision-fold relative z-20 shrink-0 flex justify-end px-4 py-1 outline-none"
      onWheel={(e) => { if (e.deltaY > 0 && stepper) grow(); }}
    >
      <button
        onClick={grow}
        title={foldTitle}
        className={`flex items-center gap-1.5 pl-2 pr-2.5 py-0.5 rounded-full border text-[11px] transition-colors ${
          item.blocking ? "border-sol-yellow/50 text-sol-text hover:bg-sol-yellow/10" : "border-sol-blue/40 text-sol-blue hover:bg-sol-blue hover:text-sol-bg"
        }`}
      >
        {dot}
        <span className="truncate max-w-[16rem]">{stepper ? (session?.title || "Session") : item.blocking ? "Waiting on your decision" : "Asked for your steer"}</span>
        <span className="opacity-70">{stepper ? `· ${stepper.position} of ${stepper.total}` : "· answer"}</span>
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

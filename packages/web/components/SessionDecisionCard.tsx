"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePendingPermissions } from "../hooks/useSyncPendingPermissions";
import { isUsageLimitDialog } from "@codecast/shared/contracts";
import { PermissionStack, PERMISSION_SKIP_TOOLS } from "./PermissionCard";
import { useInboxStore, useTrackedStore, getProjectName } from "../store/inboxStore";
import { openQuestionFromMessages, lastAssistantText, visibleOptions } from "../hooks/useDecisionQueue";
import { decisionQueueItems, queueTier, routeQueueKey, type QueueItem } from "../lib/decisionQueue";
import { buildSingleAnswerPayload, buildFreeTextPayload } from "../lib/pollPayload";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { hasOpenModal } from "../shortcuts";
import { PublishedPageEmbed } from "./PublishedPageEmbed";

// The decision card lives INSIDE the conversation — it is how a session asks
// its human something, so it renders wherever the session renders (inbox,
// queue, a deep link). Its size follows what the ask means for the thread:
//
//   blocking  The session is parked; nothing below the ask is live. The card
//             owns the pane ("full") and the thread is one ArrowUp away.
//   advisory  The agent declared a default and kept working, so the thread is
//             the main event. The card docks above the composer ("dock"), at
//             most half the pane, and folds to one line ("line") out of the way.
//
// The queue (/questions) renders the same conversation pane and only adds a
// stepper through this context: position, advance, skip, leave.
export type DecisionStepper = {
  position: number;
  total: number;
  onDone: () => void;
  onSkip: () => void;
  onExit?: () => void;
  onNotADecision: () => void;
  // A Claude Code poll / permission prompt has no authored row in the store;
  // the queue hands the card its model this way.
  item?: QueueItem;
};

export const DecisionStepperContext = createContext<DecisionStepper | null>(null);

type Size = "full" | "dock" | "line";

// The oldest pending `cast decide` row for a conversation, as a queue item.
// Signature-gated: rows change only on ask/answer.
export function usePendingDecisionItem(conversationId: string | null | undefined): QueueItem | null {
  const s = useTrackedStore([
    (st: any) => {
      if (!conversationId) return "";
      let sig = "";
      for (const d of Object.values(st.sessionDecisions) as any[]) {
        if (d.conversation_id === conversationId && d.status === "pending") sig += `${d._id}:${d.created_at}|`;
      }
      return sig;
    },
    (st: any) => {
      const row = conversationId ? st.sessions[conversationId] : undefined;
      return row ? `${row.title}|${row.project_path}|${row.is_idle}|${row.agent_status}|${row.is_unresponsive}|${row.inbox_killed_at}` : "";
    },
  ]);
  return useMemo(() => {
    if (!conversationId) return null;
    const mine: Record<string, any> = {};
    for (const d of Object.values(s.sessionDecisions) as any[]) {
      if (d.conversation_id === conversationId) mine[d._id] = d;
    }
    // A blocking ask parks the session, so it outranks an advisory one that
    // happened to be posted earlier; otherwise oldest first, as in the queue.
    const items = decisionQueueItems(mine, s.sessions).sort(
      (a, b) => Number(b.blocking) - Number(a.blocking) || a.createdAt - b.createdAt
    );
    return items[0] ?? null;
  }, [conversationId, s.sessionDecisions, s.sessions]);
}

export function SessionDecisionCard({ item, stepper }: { item: QueueItem; stepper: DecisionStepper | null }) {
  const answerDecision = useInboxStore((s) => s.answerDecision);
  const addOptimisticMessage = useInboxStore((s) => s.addOptimisticMessage);
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const navigateToSession = useInboxStore((s) => s.navigateToSession);

  const [size, setSize] = useState<Size>(() => (item.blocking ? "full" : "dock"));
  const full = size === "full";
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The dock is as tall as its content, capped at half the pane so nine
  // options or a long free-text box never turn it back into the sheet.
  const [maxDock, setMaxDock] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const pane = root?.parentElement;
    if (!pane) return;
    const measure = () => setMaxDock(Math.floor(pane.clientHeight * 0.5));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  // While the card owns the pane, the rest of the conversation (header, feed,
  // composer) is inert: the composer takes focus on mount, and every card key
  // was landing in its textarea. Set imperatively — `inert` only became a real
  // React attribute in 19. Docked, the thread gets itself back.
  useEffect(() => {
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
  const onNotADecision = stepper?.onNotADecision;
  // Answered elsewhere (the conversation footer, another device) — it no longer
  // holds a slot in the queue.
  useEffect(() => {
    if (item.source === "permission" && permissionsRaw !== undefined && permissions.length === 0) onNotADecision?.();
  }, [item.source, permissionsRaw, permissions.length, onNotADecision]);

  const poll = useMemo(() => (needsMessages ? openQuestionFromMessages(messages as any[]) : null), [needsMessages, messages]);
  const recentText = useMemo(() => (needsMessages ? lastAssistantText(messages as any[]) : undefined), [needsMessages, messages]);

  // How far the session has run since an advisory ask: tells you whether an
  // override steers the agent or unwinds it.
  const sinceAsk = useMemo(() => {
    if (item.blocking || !messages) return 0;
    let n = 0;
    for (const m of messages as any[]) if ((m.timestamp ?? 0) > item.createdAt) n++;
    return n;
  }, [item.blocking, item.createdAt, messages]);

  const question = poll?.question.question ?? item.question;
  const options = useMemo(() => {
    if (item.source === "decide") return item.options.map((o, index) => ({ label: o.label, description: o.description, index }));
    return poll ? visibleOptions(poll.question) : [];
  }, [item, poll]);
  const defaultLabel = item.defaultOption !== undefined ? options.find((o) => o.index === item.defaultOption)?.label : undefined;

  // A usage/billing interstitial is not a decision about the work, and its
  // options commit real money — exactly what a queue that advances on a digit
  // must never put under your finger.
  const isInfraDialog = item.source !== "decide" && isUsageLimitDialog(options.map((o) => o.label));
  useEffect(() => { if (isInfraDialog) onNotADecision?.(); }, [isInfraDialog, onNotADecision]);

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
    } else if (poll) {
      const content = buildFreeTextPayload(trimmed);
      const clientId = addOptimisticMessage(item.conversationId, content);
      sendMessage(item.conversationId, content, undefined, clientId);
    }
    onDone?.();
  }, [item, poll, answerDecision, addOptimisticMessage, sendMessage, onDone]);

  // "I am not going to answer this." A `cast decide` row resolves as dismissed
  // (the agent is not told); a poll/permission card only leaves this pass of
  // the queue.
  const dismiss = useCallback(() => {
    if (item.source === "decide" && item.decisionId) answerDecision(item.decisionId, { dismiss: true });
    onDone?.();
  }, [item, answerDecision, onDone]);

  const onExit = stepper?.onExit;
  const openSession = useCallback(() => {
    navigateToSession(item.conversationId);
    onExit?.();
  }, [navigateToSession, item.conversationId, onExit]);

  const shrink = useCallback(() => setSize((s) => (s === "full" ? "dock" : "line")), []);
  const grow = useCallback(() => setSize((s) => (s === "line" ? "dock" : "full")), []);

  const onSkip = stepper?.onSkip;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const action = routeQueueKey(e, {
        modalOpen: hasOpenModal(),
        editing: !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
        inOwnFreeTextBox: !!target && target === otherRef.current,
        isPermissionCard,
        optionCount: options.length,
        sheet: full ? "full" : "peek",
      });
      if (!action) return;
      // Outside the queue, a docked card must not claim the thread's keys:
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
        case "open-free-text": setOtherOpen(true); setTimeout(() => otherRef.current?.focus(), 0); break;
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
  }, [options, answer, answerFreeText, otherText, openSession, onSkip, dismiss, onExit, full, stepper, isPermissionCard, shrink, grow]);

  const tier = queueTier(item);
  const session = item.session;
  const project = session?.project_path ? getProjectName(session.project_path) : undefined;

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

  const whoIsAsking = (
    <div className={`flex items-center gap-2 min-w-0 ${full ? "mb-3" : ""}`}>
      <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${tier === 1 ? "bg-sol-yellow animate-pulse" : tier === 2 ? "bg-sol-text-dim" : "bg-sol-blue"}`} />
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

  const stepperRail = stepper && (
    <div className={`flex items-center gap-3 text-[11px] text-sol-text-dim ${full ? "mb-4" : "mb-2"}`}>
      <span className="shrink-0">decision {stepper.position} of {stepper.total}</span>
      {full ? (
        <div className="flex-1 h-px bg-sol-border relative">
          <div className="absolute inset-y-0 left-0 bg-sol-yellow/60" style={{ width: `${((stepper.position - 1) / Math.max(1, stepper.total)) * 100}%` }} />
        </div>
      ) : (
        <div className="flex-1 min-w-0 flex justify-center">{whoIsAsking}</div>
      )}
      <span className="shrink-0">{stepper.total - stepper.position + 1} left</span>
    </div>
  );

  const escapeHatch = (
    <div className={`flex items-center flex-wrap gap-4 text-[11px] text-sol-text-dim ${full ? "mt-3" : "mt-2"}`}>
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
          : "Drop this from the queue for now — the session keeps waiting on you"}
      >
        <KeyCap size="xs">x</KeyCap><span>dismiss</span>
      </button>
      <button onClick={full ? shrink : grow} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
        <KeyCap size="xs">{full ? "↑" : "↓"}</KeyCap>
        <span>{full ? "read the thread" : "back to the question"}</span>
      </button>
      {!full && (
        <button onClick={() => setSize("line")} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
          <span>fold away</span>
        </button>
      )}
      {stepper?.onExit && (
        <button onClick={stepper.onExit} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
          <KeyCap size="xs">esc</KeyCap><span>leave the queue</span>
        </button>
      )}
    </div>
  );

  const optionRow = (
    <div className={`px-6 shrink-0 ${full ? "pt-4 pb-4 border-t border-sol-border" : "pt-2 pb-3"}`}>
      <div className="flex flex-wrap gap-2">
        {options.map((o, n) => (
          <button
            key={o.index}
            onClick={() => answer(o.index)}
            className={`group flex items-center gap-2 px-3 py-2 rounded border text-sm transition-colors ${
              n === 0
                ? "border-sol-yellow/40 text-sol-text hover:bg-sol-yellow hover:text-sol-bg"
                : "border-sol-border text-sol-text-muted hover:border-sol-text-dim hover:text-sol-text"
            }`}
            title={o.description}
          >
            {n < 9 && <KeyCap size="xs">{String(n + 1)}</KeyCap>}
            <span>{o.label.replace(" (Recommended)", "")}</span>
            {item.defaultOption === o.index && <span className="text-[10px] text-sol-text-dim">proceeding with this</span>}
          </button>
        ))}
        <button
          onClick={() => { setOtherOpen(true); setTimeout(() => otherRef.current?.focus(), 0); }}
          className="flex items-center gap-2 px-3 py-2 rounded border border-sol-border text-sm text-sol-text-muted hover:text-sol-text transition-colors"
        >
          <KeyCap size="xs">t</KeyCap>
          <span>type an answer</span>
        </button>
      </div>

      {full && options.some((o) => o.description) && (
        <div className="mt-3 space-y-1">
          {options.filter((o) => o.description).map((o) => (
            <div key={o.index} className="text-[12px] text-sol-text-dim">
              <span className="text-sol-text-muted">{o.label.replace(" (Recommended)", "")}</span>
              <span className="mx-1.5">→</span>
              <span>{o.description}</span>
            </div>
          ))}
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

  // One line, out of the way: an advisory ask folded while you read the thread.
  if (size === "line") {
    return (
      <div ref={rootRef} tabIndex={-1} className="relative z-20 shrink-0 border-t border-sol-border bg-sol-bg outline-none">
        <button
          onClick={() => setSize("dock")}
          className="w-full flex items-center gap-2 px-4 py-1.5 text-[12px] text-left hover:bg-sol-card transition-colors min-w-0"
          title={question}
        >
          <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${tier === 1 ? "bg-sol-yellow animate-pulse" : tier === 2 ? "bg-sol-text-dim" : "bg-sol-blue"}`} />
          {badges}
          <span className="text-sol-text truncate">{question}</span>
          {defaultLabel && <span className="text-sol-text-dim shrink-0">proceeding with {defaultLabel}</span>}
          <span className="ml-auto text-sol-text-dim shrink-0">answer</span>
        </button>
      </div>
    );
  }

  if (full) {
    return (
      <div
        ref={rootRef}
        tabIndex={-1}
        // z-40 is load-bearing: the pane carries sticky header, state bar,
        // composer and a z-30 scroll button, each its own stacking context.
        className="absolute inset-0 z-40 flex flex-col bg-sol-bg outline-none"
        onWheel={(e) => {
          // Scrolling up at the top of the question hands the pane to the thread.
          if (e.deltaY < 0 && (bodyRef.current?.scrollTop ?? 0) <= 0) shrink();
        }}
      >
        <div className="px-6 shrink-0 pt-3">
          <button onClick={shrink} className="mx-auto block h-1 w-10 rounded-full bg-sol-border hover:bg-sol-text-dim transition-colors mb-2" title="Show the conversation" />
          {stepperRail}
        </div>
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto px-6">
          {whoIsAsking}
          <h1 className="text-xl text-sol-text leading-snug mb-4">{question}</h1>
          {item.contextMd && (
            <div className="text-sm text-sol-text-muted mb-4 border-l-2 border-sol-border pl-3">
              <MarkdownRenderer content={item.contextMd} />
            </div>
          )}
          {!item.contextMd && recentText && (
            <div className="mb-4">
              <div className="text-[10px] uppercase tracking-wide text-sol-text-dim mb-1">most recent from the agent</div>
              <div className="text-sm text-sol-text-muted border-l-2 border-sol-border pl-3 max-h-64 overflow-y-auto">
                <MarkdownRenderer content={recentText} />
              </div>
            </div>
          )}
          {!item.contextMd && !recentText && session?.thread_state && (
            <div className="text-sm text-sol-text-muted mb-4 border-l-2 border-sol-border pl-3 whitespace-pre-wrap">{session.thread_state}</div>
          )}
          {item.reportSlug && (
            <div className="mb-4"><PublishedPageEmbed slug={item.reportSlug} /></div>
          )}
          {isPermissionCard && (
            <div className="mb-4">
              <div className="text-[10px] uppercase tracking-wide text-sol-text-dim mb-1">waiting on your approval</div>
              <PermissionStack permissions={permissions} />
            </div>
          )}
          {needsMessages && !poll && !isPermissionCard && (
            <div className="text-sm text-sol-text-dim mb-4">
              This session is waiting on you, but its question has not reached the transcript yet.
            </div>
          )}
        </div>
        {optionRow}
      </div>
    );
  }

  // Docked: in flow above the composer, the question clamped, context a hover
  // away; the thread above stays readable and scrollable.
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      // relative z-20: the composer below paints a fade gradient up over its
      // neighbour, which would wash out the card's bottom row.
      className="relative z-20 shrink-0 flex flex-col overflow-y-auto border-t border-sol-border bg-sol-bg shadow-[0_-8px_24px_rgba(0,0,0,0.18)] outline-none"
      style={{ maxHeight: maxDock }}
      onWheel={(e) => { if (e.deltaY > 0 && stepper) grow(); }}
    >
      <div className="px-6 shrink-0 pt-2">
        <button onClick={grow} className="mx-auto block h-1 w-10 rounded-full bg-sol-border hover:bg-sol-text-dim transition-colors mb-1.5" title="Back to the question" />
        {stepperRail ?? <div className="mb-1.5">{whoIsAsking}</div>}
      </div>
      <div className="px-6 shrink-0">
        <div className="text-sm text-sol-text leading-snug line-clamp-2" title={question}>{question}</div>
        {!item.blocking && (
          <div className="text-[11px] text-sol-text-dim mt-1">
            {defaultLabel ? <>proceeding with <span className="text-sol-text-muted">{defaultLabel}</span></> : "proceeding"}
            {sinceAsk > 0 && <> · {sinceAsk} message{sinceAsk === 1 ? "" : "s"} since the ask</>}
          </div>
        )}
      </div>
      {optionRow}
    </div>
  );
}

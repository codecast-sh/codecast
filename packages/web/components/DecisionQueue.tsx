"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePendingPermissions } from "../hooks/useSyncPendingPermissions";
import { isUsageLimitDialog } from "@codecast/shared/contracts";
import { PermissionStack, PERMISSION_SKIP_TOOLS } from "./PermissionCard";
import { useInboxStore } from "../store/inboxStore";
// The real conversation pane the inbox uses — same component, same data hooks,
// so "scroll up into the thread" is literally the view you get when you open
// the session, not a second rendering of it.
import { InboxConversation } from "../app/inbox/QueuePageClient";
import { useDecisionQueue, openQuestionFromMessages, lastAssistantText, visibleOptions } from "../hooks/useDecisionQueue";
import { queueTier, routeQueueKey, type QueueItem } from "../lib/decisionQueue";
import { buildSingleAnswerPayload, buildFreeTextPayload } from "../lib/pollPayload";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { hasOpenModal } from "../shortcuts";
import { PublishedPageEmbed } from "./PublishedPageEmbed";
import { getProjectName } from "../store/inboxStore";


// One decision at a time, full width, keyboard driven. The spec's demo:
// answer and it advances; when the queue empties, say so and get out of the
// way. Ranking (which decision is "current") lives in lib/decisionQueue.
export function DecisionQueue({ onExit }: { onExit?: () => void }) {
  const items = useDecisionQueue();
  const [cursor, setCursor] = useState(0);
  // Keys of items answered in THIS pass. The store row flips instantly
  // (local-first), but keeping an explicit skip set means "skip" also works
  // without mutating anything, and a re-sorted queue can't resurface a card
  // you just cleared.
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());

  const queue = useMemo(() => items.filter((i) => !cleared.has(i.key)), [items, cleared]);
  const current = queue[Math.min(cursor, Math.max(0, queue.length - 1))];

  const advance = useCallback((key: string) => {
    setCleared((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    setCursor((c) => (c > 0 && c >= queue.length - 1 ? c - 1 : c));
  }, [queue.length]);

  // Evicting a card the queue should never have offered (a usage/billing
  // interstitial) uses the same `cleared` set as answering — it leaves the
  // queue and the count together, so the total never claims work that isn't
  // there. Distinct from `advance` only in intent, which the name carries.
  const evict = useCallback((key: string) => advance(key), [advance]);

  if (!current) return <QueueEmpty total={items.length} onExit={onExit} />;

  return (
    <DecisionCard
      key={current.key}
      item={current}
      position={Math.min(cursor, queue.length - 1) + 1}
      total={queue.length}
      onDone={() => advance(current.key)}
      onSkip={() => setCursor((c) => (c + 1) % Math.max(1, queue.length))}
      onExit={onExit}
      onNotADecision={() => evict(current.key)}
    />
  );
}

function QueueEmpty({ total, onExit }: { total: number; onExit?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
      <div className="text-2xl text-sol-text">Nothing needs you.</div>
      <div className="text-sm text-sol-text-muted max-w-md">
        {total > 0
          ? "You cleared the queue. New decisions appear here the moment an agent asks."
          : "Your agents are working. You will be interrupted when that changes."}
      </div>
      {onExit && (
        <button
          onClick={onExit}
          className="mt-2 text-xs text-sol-text-dim hover:text-sol-text transition-colors"
        >
          <KeyCap size="xs">esc</KeyCap> <span className="ml-1">back to the inbox</span>
        </button>
      )}
    </div>
  );
}

function DecisionCard({
  item,
  position,
  total,
  onDone,
  onSkip,
  onExit,
  onNotADecision,
}: {
  item: QueueItem;
  position: number;
  total: number;
  onDone: () => void;
  onSkip: () => void;
  onExit?: () => void;
  onNotADecision: () => void;
}) {
  const answerDecision = useInboxStore((s) => s.answerDecision);
  const addOptimisticMessage = useInboxStore((s) => s.addOptimisticMessage);
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const navigateToSession = useInboxStore((s) => s.navigateToSession);
  // The question owns the screen at rest; scrolling up hands the screen to the
  // thread behind it. Two states rather than a free drag: the point of the
  // queue is that you never manage a layout.
  const [sheet, setSheet] = useState<"full" | "peek">("full");
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  // Set imperatively rather than as a JSX prop: `inert` only became a real
  // React attribute in 19, and a silently-dropped prop here would look exactly
  // like the bug it fixes. Blur on the way in, because the composer may
  // already hold focus by the time we mark the pane inert.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const shouldBlock = sheet === "full";
    (pane as any).inert = shouldBlock;
    if (shouldBlock) {
      const active = document.activeElement as HTMLElement | null;
      if (active && pane.contains(active)) active.blur();
    }
  }, [sheet]);

  // A poll card has no authored payload, so its question and options come from
  // the conversation itself. The pane below already loads and syncs those
  // messages into the store (useConversationMessages), so read them from there
  // rather than opening a second subscription to the same conversation.
  const needsMessages = item.source !== "decide";
  const messages = useInboxStore((s) => s.messages[item.conversationId]);

  // A permission-blocked session is in the queue by choice, but its payload is
  // a tool name and an argument preview — not a question with options. Render
  // the real Approve/Deny card rather than an empty one: PermissionStack owns
  // its own mutation and y/n keys, which is also the safety property here —
  // approving a command must never be reachable from the digit that answers
  // the card before it in the stack.
  // Store-fed (hooks/useSyncPendingPermissions): the card paints from cached
  // rows at boot instead of an empty slot waiting on a round-trip.
  const permissionsRaw = usePendingPermissions(
    item.source === "permission" ? item.conversationId : null,
  );
  const permissions = useMemo(
    () => (permissionsRaw ?? []).filter((p: any) => !PERMISSION_SKIP_TOOLS.has(p.tool_name)),
    [permissionsRaw]
  );
  const isPermissionCard = item.source === "permission" && permissions.length > 0;
  // Answered elsewhere (the conversation footer, another device) — it is no
  // longer waiting on you, so it should not hold a slot in the queue.
  useEffect(() => {
    if (item.source === "permission" && permissionsRaw !== undefined && permissions.length === 0) {
      onNotADecision();
    }
  }, [item.source, permissionsRaw, permissions.length, onNotADecision]);

  const poll = useMemo(
    () => (needsMessages ? openQuestionFromMessages(messages as any[]) : null),
    [needsMessages, messages]
  );
  const recentText = useMemo(
    () => (needsMessages ? lastAssistantText(messages as any[]) : undefined),
    [needsMessages, messages]
  );

  const question = poll?.question.question ?? item.question;
  const options = useMemo(() => {
    if (item.source === "decide") {
      return item.options.map((o, index) => ({ label: o.label, description: o.description, index }));
    }
    return poll ? visibleOptions(poll.question) : [];
  }, [item, poll]);

  // A usage/billing interstitial is not a decision about the work, and its
  // options commit real money or a plan change — exactly what a queue that
  // advances on a digit press must never put under your finger. The option
  // text only arrives with the messages, so the check lands here and evicts
  // the card from the queue (and from its count) as soon as it is knowable.
  const isInfraDialog = item.source !== "decide" && isUsageLimitDialog(options.map((o) => o.label));
  useEffect(() => {
    if (isInfraDialog) onNotADecision();
  }, [isInfraDialog, onNotADecision]);

  const answer = useCallback(
    (index: number) => {
      if (item.source === "decide" && item.decisionId) {
        answerDecision(item.decisionId, { index });
      } else if (poll) {
        const content = buildSingleAnswerPayload(poll.question, index);
        const clientId = addOptimisticMessage(item.conversationId, content);
        sendMessage(item.conversationId, content, undefined, clientId);
      }
      onDone();
    },
    [item, poll, answerDecision, addOptimisticMessage, sendMessage, onDone]
  );

  const answerFreeText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (item.source === "decide" && item.decisionId) {
        answerDecision(item.decisionId, { text: trimmed });
      } else if (poll) {
        // Free text declines the menu and types prose — the payload builder
        // encodes that (a custom answer can't ride the option keys).
        const content = buildFreeTextPayload(trimmed);
        const clientId = addOptimisticMessage(item.conversationId, content);
        sendMessage(item.conversationId, content, undefined, clientId);
      }
      onDone();
    },
    [item, poll, answerDecision, addOptimisticMessage, sendMessage, onDone]
  );

  const openSession = useCallback(() => {
    navigateToSession(item.conversationId);
    onExit?.();
  }, [navigateToSession, item.conversationId, onExit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // The claim/stand-down rules live in routeQueueKey (lib/decisionQueue) so
      // they are pinned by tests: a modal above the queue owns the keyboard,
      // and Enter typed in any input that is not the card's own box is that
      // surface's key — this listener eating the compose dialog's Enter is
      // exactly how "enter stopped working" presented.
      const action = routeQueueKey(e, {
        modalOpen: hasOpenModal(),
        editing: !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
        inOwnFreeTextBox: !!target && target === otherRef.current,
        isPermissionCard,
        optionCount: options.length,
        sheet,
      });
      if (!action) return;
      // Claim the key for the queue: stop the default AND stop the global
      // shortcut layer below from acting on it a second time.
      e.preventDefault();
      e.stopPropagation();
      switch (action.kind) {
        case "commit-free-text": answerFreeText(otherText); break;
        case "close-free-text": setOtherOpen(false); break;
        case "answer": { const opt = options[action.option]; if (opt) answer(opt.index); break; }
        case "open-session": openSession(); break;
        case "skip": onSkip(); break;
        case "open-free-text":
          setOtherOpen(true);
          setTimeout(() => otherRef.current?.focus(), 0);
          break;
        case "peek": setSheet("peek"); break;
        case "full": setSheet("full"); break;
        case "restore-question": setSheet("full"); break;
        case "exit-queue": onExit?.(); break;
      }
    };
    // CAPTURE phase, deliberately. The app's global shortcut layer claims the
    // arrows and digits for list navigation, and in bubble phase it consumed
    // ArrowUp before the queue ever saw it — the sheet would only dock by
    // click, which defeats a surface whose whole premise is the keyboard.
    // Running first also means the keys the queue owns must not fall through
    // and drive the inbox behind it, hence stopPropagation at each branch.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [options, answer, answerFreeText, otherText, openSession, onSkip, onExit, sheet, isPermissionCard]);

  const tier = queueTier(item);
  const session = item.session;
  const project = session?.project_path ? getProjectName(session.project_path) : undefined;

  return (
    <div className="relative h-full overflow-hidden">
      {/* The session itself, behind the question — the same pane the inbox
          renders when you open the session, so "not enough context" is one
          scroll away instead of a navigation.

          Held INERT while the question owns the screen. That pane ships a
          message composer, and it takes focus on mount: every queue keystroke
          was landing in a textarea, so the card's own keys did nothing and an
          answer digit would have been typed at the session instead. Inert
          removes it from focus and pointer entirely; docking the sheet hands
          it back, which is exactly when you mean to interact with it. */}
      <div ref={paneRef} className="absolute inset-0">
        <InboxConversation
          sessionId={item.conversationId}
          isIdle={!!session?.is_idle}
          onSendAndAdvance={onSkip}
        />
      </div>

      {/* The question. Full height at rest; scroll up (or ArrowUp) docks it so
          the thread above becomes reachable. */}
      <div
        // z-30 is load-bearing: the conversation pane behind carries a sticky
        // header, a sticky state bar and a sticky composer, and sticky elements
        // make their own stacking context — without an explicit layer they
        // paint straight through the sheet and the question reads as broken.
        className={`absolute left-0 right-0 bottom-0 z-30 flex flex-col bg-sol-bg border-t border-sol-border shadow-[0_-8px_24px_rgba(0,0,0,0.18)] transition-[height] duration-200 ease-out motion-reduce:transition-none ${
          sheet === "full" ? "h-full" : "h-[44%]"
        }`}
        onWheel={(e) => {
          // Scrolling up at the top of the question hands the gesture to the
          // thread; scrolling down at the bottom brings the question back.
          if (e.deltaY < 0 && sheet === "full" && (bodyRef.current?.scrollTop ?? 0) <= 0) setSheet("peek");
          else if (e.deltaY > 0 && sheet === "peek") setSheet("full");
        }}
      >
      {/* grab handle + progress rail */}
      <div className="px-6 pt-3 shrink-0">
        <button
          onClick={() => setSheet(sheet === "full" ? "peek" : "full")}
          className="mx-auto mb-2 block h-1 w-10 rounded-full bg-sol-border hover:bg-sol-text-dim transition-colors"
          title={sheet === "full" ? "Show the conversation above" : "Back to the question"}
        />
        <div className="flex items-center gap-3 text-[11px] text-sol-text-dim mb-4">
          <span>decision {position} of {total}</span>
          <div className="flex-1 h-px bg-sol-border relative">
            <div
              className="absolute inset-y-0 left-0 bg-sol-yellow/60"
              style={{ width: `${((position - 1) / Math.max(1, total)) * 100}%` }}
            />
          </div>
          <span>{total - position + 1} left</span>
        </div>
      </div>

      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto px-6">
        {/* who is asking */}
        <div className="flex items-center gap-2 mb-3">
          <span
            className={`w-1.5 h-1.5 rounded-full ${tier === 1 ? "bg-sol-yellow animate-pulse" : tier === 2 ? "bg-sol-text-dim" : "bg-sol-blue"}`}
          />
          <button
            onClick={openSession}
            className="text-sm text-sol-text hover:text-sol-blue transition-colors truncate"
          >
            {session?.title || "Session"}
          </button>
          {project && <span className="text-[11px] text-sol-text-dim">{project}</span>}
          {tier === 3 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-blue/30 text-sol-blue">
              advisory
            </span>
          )}
          {tier === 2 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-border text-sol-text-dim">
              session not running
            </span>
          )}
        </div>

        {/* the question */}
        <h1 className="text-xl text-sol-text leading-snug mb-4">{question}</h1>

        {/* context: authored markdown, or what we can recover */}
        {item.contextMd && (
          <div className="text-sm text-sol-text-muted mb-4 border-l-2 border-sol-border pl-3">
            <MarkdownRenderer content={item.contextMd} />
          </div>
        )}
        {!item.contextMd && recentText && (
          <div className="mb-4">
            <div className="text-[10px] uppercase tracking-wide text-sol-text-dim mb-1">
              most recent from the agent
            </div>
            <div className="text-sm text-sol-text-muted border-l-2 border-sol-border pl-3 max-h-64 overflow-y-auto">
              <MarkdownRenderer content={recentText} />
            </div>
          </div>
        )}
        {!item.contextMd && !recentText && session?.thread_state && (
          <div className="text-sm text-sol-text-muted mb-4 border-l-2 border-sol-border pl-3 whitespace-pre-wrap">
            {session.thread_state}
          </div>
        )}

        {/* the full report, when the agent published one — same embed card
            conversations use for a publish URL on its own line */}
        {item.reportSlug && (
          <div className="mb-4">
            <PublishedPageEmbed slug={item.reportSlug} />
          </div>
        )}

        {isPermissionCard && (
          <div className="mb-4">
            <div className="text-[10px] uppercase tracking-wide text-sol-text-dim mb-1">
              waiting on your approval
            </div>
            <PermissionStack permissions={permissions} />
          </div>
        )}

        {needsMessages && !poll && !isPermissionCard && (
          <div className="text-sm text-sol-text-dim mb-4">
            This session is waiting on you, but its question has not reached the
            transcript yet. Open it to see what it is asking.
          </div>
        )}
      </div>

      {/* the options */}
      <div className="pt-4 pb-4 px-6 border-t border-sol-border shrink-0">
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
              {item.defaultOption === o.index && (
                <span className="text-[10px] text-sol-text-dim">proceeding with this</span>
              )}
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

        {/* per-option consequences, when the agent wrote them */}
        {options.some((o) => o.description) && (
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

        {/* the escape hatch: always offer the whole session */}
        <div className="flex items-center gap-4 mt-3 text-[11px] text-sol-text-dim">
          <button onClick={openSession} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
            <KeyCap size="xs">o</KeyCap><span>open the session</span>
          </button>
          <button onClick={onSkip} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
            <KeyCap size="xs">s</KeyCap><span>skip for now</span>
          </button>
          <button
            onClick={() => setSheet(sheet === "full" ? "peek" : "full")}
            className="flex items-center gap-1.5 hover:text-sol-text transition-colors"
          >
            <KeyCap size="xs">{sheet === "full" ? "↑" : "↓"}</KeyCap>
            <span>{sheet === "full" ? "read the thread" : "back to the question"}</span>
          </button>
          {onExit && (
            <button onClick={onExit} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
              <KeyCap size="xs">esc</KeyCap><span>leave the queue</span>
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

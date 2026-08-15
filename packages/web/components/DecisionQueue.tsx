"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useDecisionQueue, openQuestionFromMessages, lastAssistantText, visibleOptions } from "../hooks/useDecisionQueue";
import { queueTier, type QueueItem } from "../lib/decisionQueue";
import { buildSingleAnswerPayload, buildFreeTextPayload } from "../lib/pollPayload";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { CONVEX_URL } from "../lib/localAuth";
import { getProjectName } from "../store/inboxStore";

const api = _api as any;

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
}: {
  item: QueueItem;
  position: number;
  total: number;
  onDone: () => void;
  onSkip: () => void;
  onExit?: () => void;
}) {
  const answerDecision = useInboxStore((s) => s.answerDecision);
  const addOptimisticMessage = useInboxStore((s) => s.addOptimisticMessage);
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const navigateToSession = useInboxStore((s) => s.navigateToSession);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const otherRef = useRef<HTMLTextAreaElement>(null);

  // A poll card has no authored payload: load the conversation's tail so the
  // card can show the actual question, its options, and the assistant's last
  // message as context. Only the visible card subscribes.
  const needsMessages = item.source !== "decide";
  const { results: messages } = usePaginatedQuery(
    api.conversations.listMessages,
    needsMessages ? { conversation_id: item.conversationId } : "skip",
    { initialNumItems: 12 }
  );

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
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const editing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (editing) {
        // Enter commits the free-text answer; Escape closes the box.
        if (e.key === "Escape") { e.preventDefault(); setOtherOpen(false); }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); answerFreeText(otherText); }
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const n = Number(e.key) - 1;
        const opt = options[n];
        if (opt) { e.preventDefault(); answer(opt.index); }
        return;
      }
      if (e.key === "o" || e.key === "O") { e.preventDefault(); openSession(); return; }
      if (e.key === "s" || e.key === "S") { e.preventDefault(); onSkip(); return; }
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        setOtherOpen(true);
        setTimeout(() => otherRef.current?.focus(), 0);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); onExit?.(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [options, answer, answerFreeText, otherText, openSession, onSkip, onExit]);

  const tier = queueTier(item);
  const session = item.session;
  const project = session?.project_path ? getProjectName(session.project_path) : undefined;

  return (
    <div className="h-full flex flex-col max-w-4xl mx-auto w-full px-6 py-5">
      {/* progress rail */}
      <div className="flex items-center gap-3 text-[11px] text-sol-text-dim mb-5">
        <span>decision {position} of {total}</span>
        <div className="flex-1 h-px bg-sol-border relative">
          <div
            className="absolute inset-y-0 left-0 bg-sol-yellow/60"
            style={{ width: `${((position - 1) / Math.max(1, total)) * 100}%` }}
          />
        </div>
        <span>{total - position + 1} left</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
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

        {/* the full report, when the agent published one */}
        {item.reportSlug && (
          <div className="mb-4 border border-sol-border rounded overflow-hidden">
            <div className="flex items-center justify-between px-2 py-1 bg-sol-bg-alt text-[11px] text-sol-text-dim">
              <span>report</span>
              <a
                href={`${CONVEX_URL}/cli/a/${item.reportSlug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-sol-blue transition-colors"
              >
                open full page
              </a>
            </div>
            {/* The artifact origin serves its own sandbox CSP, so the frame is
                already isolated — no second sanitizer needed here. */}
            <iframe
              src={`${CONVEX_URL}/cli/a/${item.reportSlug}`}
              className="w-full h-[420px] bg-sol-card"
              sandbox="allow-scripts allow-popups"
              title="decision report"
            />
          </div>
        )}

        {needsMessages && !poll && (
          <div className="text-sm text-sol-text-dim mb-4">
            This session is waiting on you, but its question has not reached the
            transcript yet. Open it to see what it is asking.
          </div>
        )}
      </div>

      {/* the options */}
      <div className="pt-4 mt-2 border-t border-sol-border">
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
          {onExit && (
            <button onClick={onExit} className="flex items-center gap-1.5 hover:text-sol-text transition-colors">
              <KeyCap size="xs">esc</KeyCap><span>leave the queue</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

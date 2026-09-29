"use client";

// "Ask this session": a question about the open conversation, answered by the
// same server action as `cast read <id> --ask`, with every `msg N` citation a
// chip that jumps to that message in the transcript.
//
// The questions and answers are ephemeral UI state, not synced server data:
// they live in a module map keyed by conversation, so switching sessions and
// back keeps them while the app is open, and an answer that lands after the
// panel closed is waiting when it reopens.

import { createContext, memo, useContext, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import ReactMarkdownBase from "react-markdown";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { AskResult } from "@codecast/convex/convex/sessionAsk";
import { Loader2, MessageCircleQuestion, X } from "lucide-react";
import { entityRemarkPlugins } from "../../lib/remarkEntityIds";
import { MESSAGE_MD_COMPONENTS } from "../messageMarkdown";
import { askCiteTarget, askErrorMessage, linkAskCitations } from "../../lib/askSession";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { MenuKeyCaps, KeyCap } from "../KeyboardShortcutsHelp";

type AskEntry = {
  id: number;
  question: string;
  started_at: number;
  result?: AskResult;
  error?: string;
};

// ── Ephemeral per-conversation thread ─────────────────────────────────────
const threads = new Map<string, AskEntry[]>();
const listeners = new Set<() => void>();
const EMPTY: AskEntry[] = [];
let nextId = 1;

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function writeThread(conversationId: string, update: (entries: AskEntry[]) => AskEntry[]) {
  threads.set(conversationId, update(threads.get(conversationId) ?? EMPTY));
  listeners.forEach((l) => l());
}
function useThread(conversationId: string): AskEntry[] {
  return useSyncExternalStore(subscribe, () => threads.get(conversationId) ?? EMPTY, () => EMPTY);
}

/** Ask a question about a conversation; the answer lands in its thread. */
export function useAskSession(conversationId: string) {
  const ask = useAction(api.sessionAsk.askFromWeb);
  return (question: string) => {
    const q = question.trim();
    if (!q) return;
    const id = nextId++;
    const patch = (p: Partial<AskEntry>) => writeThread(conversationId, (es) => es.map((e) => (e.id === id ? { ...e, ...p } : e)));
    writeThread(conversationId, (es) => [...es, { id, question: q, started_at: Date.now() }]);
    ask({ conversation_id: conversationId, question: q })
      .then((result) => patch({ result }))
      .catch((error) => patch({ error: askErrorMessage(error) }));
  };
}

// ── Answer body ────────────────────────────────────────────────────────────
const CiteContext = createContext<(messageId: string) => void>(() => {});

function CiteAwareLink(props: { href?: string; children?: ReactNode }) {
  const onCite = useContext(CiteContext);
  const target = askCiteTarget(props.href);
  if (!target) return (MESSAGE_MD_COMPONENTS.a as (p: typeof props) => ReactNode)(props);
  return (
    <button
      type="button"
      onClick={() => onCite(target)}
      className="inline-flex items-baseline mx-[1px] px-1 rounded border border-sol-cyan/30 bg-sol-cyan/10 text-sol-cyan font-mono text-[0.85em] leading-snug hover:bg-sol-cyan/20 hover:border-sol-cyan/60 transition-colors cursor-pointer whitespace-nowrap"
      title="Jump to this message"
    >
      {props.children}
    </button>
  );
}

const ANSWER_COMPONENTS = { ...MESSAGE_MD_COMPONENTS, a: CiteAwareLink };

const AnswerBody = memo(function AnswerBody({ result }: { result: AskResult }) {
  const markdown = linkAskCitations(result.answer, result.citations ?? []);
  return (
    <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-sol-text [&_p]:my-1.5 [&_ul]:my-1.5 [&_li]:my-0.5 [&_code]:text-[12px]">
      <ReactMarkdownBase remarkPlugins={entityRemarkPlugins} components={ANSWER_COMPONENTS}>{markdown}</ReactMarkdownBase>
    </div>
  );
});

function Elapsed({ since }: { since: number }) {
  const now = useCoarseNow(1000);
  return <span className="tabular-nums">{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}

function PartialNote({ unread }: { unread: NonNullable<AskResult["unread"]> }) {
  return (
    <div className="mt-2 text-[11px] leading-snug text-sol-text-dim border-l-2 border-sol-yellow/50 pl-2">
      This session is too long to read whole. Messages between msg {unread.after} and msg {unread.before} (counted from the end) were not read.
    </div>
  );
}

function Entry({ entry }: { entry: AskEntry }) {
  return (
    <div className="py-3 first:pt-1">
      <div className="text-[12px] font-medium text-sol-text-secondary mb-1.5 break-words">{entry.question}</div>
      {entry.result ? (
        <>
          <AnswerBody result={entry.result} />
          {entry.result.unread && <PartialNote unread={entry.result.unread} />}
        </>
      ) : entry.error ? (
        <div className="text-[12px] text-sol-red">{entry.error}</div>
      ) : (
        <div className="flex items-center gap-2 text-[12px] text-sol-text-dim">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-sol-cyan" />
          <span>Reading the session</span>
          <span className="opacity-70"><Elapsed since={entry.started_at} /></span>
        </div>
      )}
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────
export function AskSessionPanel({
  conversationId,
  top,
  inputRef,
  onCite,
  onClose,
}: {
  conversationId: string;
  top: number;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onCite: (messageId: string) => void;
  onClose: () => void;
}) {
  const entries = useThread(conversationId);
  const ask = useAskSession(conversationId);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const submit = () => {
    if (!draft.trim()) return;
    ask(draft);
    setDraft("");
    // The new entry renders on the next paint; keep it in view.
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  return (
    <div
      data-ask-panel
      className="absolute right-2 sm:right-3 z-[25] w-[min(440px,calc(100%-16px))] flex flex-col max-h-[min(70vh,640px)] rounded-lg border border-sol-border bg-sol-bg shadow-xl animate-in fade-in slide-in-from-top-1 duration-150"
      style={{ top: top + 6 }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-sol-border/60">
        <MessageCircleQuestion className="w-3.5 h-3.5 text-sol-cyan" />
        <span className="text-[12px] font-medium text-sol-text">Ask this session</span>
        <MenuKeyCaps action="conv.ask" className="flex items-center gap-[2px] opacity-70" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto p-0.5 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <CiteContext.Provider value={onCite}>
        {entries.length > 0 ? (
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 divide-y divide-sol-border/40">
            {entries.map((e) => <Entry key={e.id} entry={e} />)}
          </div>
        ) : (
          <div className="px-3 py-3 text-[12px] leading-relaxed text-sol-text-dim">
            Ask what was decided, what changed, or where something stands. The answer cites the messages it rests on; click one to jump there.
          </div>
        )}
      </CiteContext.Provider>

      <div className="flex items-end gap-2 px-2.5 py-2 border-t border-sol-border/60">
        <textarea
          ref={inputRef}
          autoFocus
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={entries.length > 0 ? "Ask a follow-up" : "What did this session decide about…"}
          className="flex-1 resize-none bg-transparent outline-none text-[13px] leading-5 text-sol-text placeholder:text-sol-text-dim max-h-28 [field-sizing:content] [font-variant-ligatures:none]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim()}
          aria-label="Ask"
          className="flex items-center gap-1 h-6 pl-1 pr-1.5 rounded text-[11px] text-sol-text-dim enabled:hover:text-sol-cyan enabled:hover:bg-sol-cyan/10 disabled:opacity-40 transition-colors"
        >
          <KeyCap size="xs">↵</KeyCap>
          Ask
        </button>
      </div>
    </div>
  );
}

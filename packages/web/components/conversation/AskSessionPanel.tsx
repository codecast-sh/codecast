"use client";

// "Ask this session": side answers about the open conversation (`/btw` in the
// composer, or this panel's own box), answered by the same read as
// `cast read <id> --ask` and never sent to the agent. Every `msg N` citation is
// a chip that jumps to that message in the transcript.
//
// The rows live in the store's sideAnswers collection (hooks/useSideAnswers),
// kept per conversation on the server, so earlier answers can be reread.

import { createContext, memo, useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import ReactMarkdownBase from "react-markdown";
import type { SideAnswerRow } from "@codecast/shared/contracts";
import { formatDateFull, relTimeShort } from "@codecast/shared/time";
import { Loader2, MessageCircleQuestion, X } from "lucide-react";
import { entityRemarkPlugins } from "../../lib/remarkEntityIds";
import { MESSAGE_MD_COMPONENTS } from "../messageMarkdown";
import { askCiteTarget, linkAskCitations } from "../../lib/askSession";
import { askSideQuestion, sideAnswerView, visibleSideAnswers } from "../../lib/sideAnswers";
import { useSideAnswers } from "../../hooks/useSideAnswers";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { MenuKeyCaps, KeyCap } from "../KeyboardShortcutsHelp";

// ── Answer body ────────────────────────────────────────────────────────────
const CiteContext = createContext<(messageId: string) => void>(() => {});

function CiteAwareLink(props: { href?: string; children?: ReactNode }) {
  const onCite = useContext(CiteContext);
  const target = askCiteTarget(props.href);
  if (!target) return (MESSAGE_MD_COMPONENTS.a as (p: typeof props) => ReactNode)(props);
  return (
    <button
      type="button"
      data-cite-id={target}
      onClick={() => onCite(target)}
      className="inline-flex items-baseline mx-[1px] px-1 rounded border border-sol-cyan/30 bg-sol-cyan/10 text-sol-cyan font-mono text-[length:max(0.85em,11px)] leading-snug hover:bg-sol-cyan/20 hover:border-sol-cyan/60 transition-colors cursor-pointer whitespace-nowrap"
      title="Jump to this message"
    >
      {props.children}
    </button>
  );
}

const ANSWER_COMPONENTS = { ...MESSAGE_MD_COMPONENTS, a: CiteAwareLink };

const AnswerBody = memo(function AnswerBody({ answer, citations }: { answer: string; citations: ReadonlyArray<{ line: number; message_id: string }> }) {
  const markdown = linkAskCitations(answer, citations);
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

function PartialNote() {
  return (
    <div className="mt-2 inline-flex px-1.5 py-0.5 rounded border border-sol-yellow/40 bg-sol-yellow/10 text-meta text-sol-text-dim">
      Long session: its middle was not read
    </div>
  );
}

function Entry({ row, now, onAskAgain }: { row: SideAnswerRow; now: number; onAskAgain: (question: string) => void }) {
  const view = sideAnswerView(row, now);
  return (
    <div className="py-3 first:pt-1" data-side-answer={row.status}>
      <div className="flex items-baseline gap-2 mb-1.5">
        <div className="flex-1 min-w-0 text-[12px] font-medium text-sol-text-secondary break-words line-clamp-3" title={row.question}>{row.question}</div>
        <span className="shrink-0 text-meta tabular-nums text-sol-text-dim" title={formatDateFull(row.created_at)}>{relTimeShort(row.created_at, now)}</span>
      </div>
      {view.kind === "answered" ? (
        <>
          <AnswerBody answer={view.answer} citations={view.citations} />
          {view.unread && <PartialNote />}
        </>
      ) : view.kind === "failed" ? (
        <div className="flex items-baseline gap-2 text-[12px]">
          <span className="flex-1 min-w-0 text-sol-red">{view.message}</span>
          <button
            type="button"
            onClick={() => onAskAgain(row.question)}
            className="shrink-0 px-1.5 rounded text-meta text-sol-text-dim hover:text-sol-cyan hover:bg-sol-cyan/10 transition-colors"
          >
            Ask again
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[12px] text-sol-text-dim">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-sol-cyan" />
          <span>Reading the session</span>
          <span className="opacity-70"><Elapsed since={row.created_at} /></span>
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
  const now = useCoarseNow(30_000);
  const rows = visibleSideAnswers(useSideAnswers(conversationId), now);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Opened, a question added (here or by `/btw` in the composer), or the newest answered: show the newest.
  const newest = rows[rows.length - 1];
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newest?.client_id, newest?.status]);

  const askAgain = (question: string) => { void askSideQuestion(conversationId, question); };

  const submit = () => {
    if (!draft.trim()) return;
    const asked = draft;
    setDraft("");
    // A refused question comes back to the box, unless something new was typed meanwhile.
    void askSideQuestion(conversationId, asked).then((refusal) => { if (refusal) setDraft((d) => d || asked); });
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
        {rows.length > 0 && (
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 divide-y divide-sol-border/40">
            {rows.map((r) => <Entry key={r.client_id} row={r} now={now} onAskAgain={askAgain} />)}
          </div>
        )}
      </CiteContext.Provider>

      <div className={`flex items-end gap-2 px-2.5 py-2 ${rows.length > 0 ? "border-t border-sol-border/60" : ""}`}>
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={rows.length > 0 ? "Ask another" : "What did this session change in…"}
          className="flex-1 resize-none bg-transparent outline-none text-[13px] leading-5 text-sol-text placeholder:text-sol-text-dim max-h-28 [field-sizing:content] [font-variant-ligatures:none]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim()}
          aria-label="Ask"
          className="flex items-center gap-1 h-6 pl-1 pr-1.5 rounded text-meta text-sol-text-dim enabled:hover:text-sol-cyan enabled:hover:bg-sol-cyan/10 disabled:opacity-40 transition-colors"
        >
          <KeyCap size="xs">↵</KeyCap>
          Ask
        </button>
      </div>
    </div>
  );
}

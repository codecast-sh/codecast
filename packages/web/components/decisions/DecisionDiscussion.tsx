"use client";
// Discuss a decision with the session that owns it (ct-58330): the session
// that presents it, which can read the whole record and answer, or send the
// work back through the decision. The person's words reach it as a turn
// (decisionDiscussion.ts) and its reply lands here, under the question, so
// nobody has to find the session to have the conversation. The same block
// sits on the decision page, the queue card and the change card.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useDecisionDiscussion } from "../../hooks/useDecisionDiscussion";
import { ownerReason, waitingWords } from "../../lib/decisionDiscussion";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { cn } from "../../lib/utils";

const newClientId = () => `decision-discussion:${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function DecisionDiscussion({ decisionId, compact = false, className }: { decisionId: string; compact?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  // A card that was never discussed subscribes nothing until it is opened;
  // a discussed one (its row or an echo cached) keeps its thread live.
  const cached = useInboxStore((s) => !!s.decisionDiscussions[decisionId]?.turns?.length || !!s.discussionSends[decisionId]?.length);
  const { ready, owner, thread } = useDecisionDiscussion(decisionId, open || cached || !compact);
  const discussDecision = useInboxStore((s) => s.discussDecision);

  useEffect(() => { if (open) box.current?.focus(); }, [open]);

  const ownerName = owner?.name ?? "the session that owns it";
  const send = () => {
    const words = text.trim();
    if (!words || !owner) return;
    discussDecision(decisionId, words, newClientId());
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The queue's answer keys (return, x, digits) must not fire while typing.
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };

  // Loaded and nobody owns it: say so once, instead of a button that goes nowhere.
  if (ready && !owner && thread.length === 0) {
    return compact ? null : <p className={cn("text-[12px] text-sol-text-dim", className)} data-decision-discussion="none">No session can discuss this decision.</p>;
  }

  return (
    <section className={cn("decision-discussion", className)} data-decision-discussion onClick={(e) => e.stopPropagation()}>
      {thread.length > 0 && (
        <ol className="flex flex-col gap-3 border-l-2 border-sol-border/50 pl-3" data-discussion-thread>
          {thread.map((t) => (
            <li key={t.client_id} className="flex flex-col gap-1.5">
              <div className="text-[13px] leading-snug text-sol-text">
                <span className="mr-1.5 text-[11.5px] text-sol-text-dim">{t.by ?? "You"}</span>
                <span className="whitespace-pre-wrap">{t.text}</span>
              </div>
              {t.reply ? (
                <div className="rounded-md bg-sol-bg-alt/70 px-2.5 py-2 text-[13px] leading-relaxed" data-discussion-reply>
                  <div className="mb-1 text-[11.5px] font-medium text-sol-cyan">{ownerName}</div>
                  <div className="text-sol-text-muted [&_p]:my-1"><MarkdownRenderer content={t.reply.text} /></div>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[11.5px] text-sol-text-dim" data-discussion-waiting>
                  <span className={cn("h-1.5 w-1.5 rounded-full", t.state === "waiting" ? "bg-sol-cyan animate-pulse motion-reduce:animate-none" : "bg-sol-border")} />
                  {waitingWords(t.state, ownerName)}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {open && owner ? (
        <div className={cn("rounded-lg border border-sol-border/60 bg-sol-bg focus-within:border-sol-cyan/50 transition-colors", thread.length > 0 && "mt-3")}>
          <textarea
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={compact ? 2 : 3}
            placeholder={`Ask ${ownerName} about this decision`}
            className="block w-full resize-none bg-transparent px-3 py-2 text-[13px] text-sol-text placeholder:text-sol-text-dim focus:outline-none"
            data-discussion-input
          />
          <div className="flex items-center gap-2 border-t border-sol-border/40 px-3 py-1.5 text-[11.5px] text-sol-text-dim">
            <span className="min-w-0 flex-1 truncate" title={ownerReason(owner.via)}>Goes to <span className="text-sol-text-muted">{ownerName}</span>. {ownerReason(owner.via)}</span>
            <span className="hidden sm:inline-flex items-center gap-1"><KeyCap size="xs">esc</KeyCap>close</span>
            <button type="button" onClick={send} disabled={!text.trim()} className="inline-flex items-center gap-1 rounded-md bg-sol-cyan/15 px-2 py-0.5 text-sol-cyan hover:bg-sol-cyan/25 disabled:opacity-40 transition-colors">
              Send<KeyCap size="xs">return</KeyCap>
            </button>
          </div>
        </div>
      ) : (
        <div className={cn("flex items-center gap-3", thread.length > 0 && "mt-2")}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={ready && !owner}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -ml-1.5 text-[12.5px] text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt disabled:opacity-50 transition-colors"
            title={owner ? ownerReason(owner.via) : undefined}
            data-discuss-button
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {thread.length > 0 ? "Reply" : owner ? `Discuss with ${ownerName}` : "Discuss"}
          </button>
          {owner && thread.length > 0 && (
            <Link href={`/conversation/${owner.conversation_id}`} className="inline-flex items-center gap-0.5 text-[11.5px] text-sol-text-dim hover:text-sol-blue" title="The owning session's whole conversation">
              Open {ownerName}'s session<ArrowUpRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

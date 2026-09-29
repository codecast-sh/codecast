"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Undo2 } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import type { QueueItem } from "../../lib/decisionQueue";
import { splitEscalationLine } from "../../lib/escalationText";
import { useReplyToEscalation } from "../../hooks/useReplyToEscalation";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { CollapsibleBody } from "../CollapsibleBody";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { stripMarkdown } from "../../lib/notificationText";
import { RoleFace } from "../org/RoleFace";
import { EntityIdPill } from "../EntityIdPill";
import { KeyCap } from "../KeyboardShortcutsHelp";
import "./decisions.css";

// A role's escalation as a card in a list: the queue's row, the role page's
// "Needs you" row. The same anatomy as DecisionCompactCard (who asks, when,
// what about, the line clipped with the way to open it) with the one answer
// an escalation takes: a reply in words, which hands the session back. The
// whole ask reads in the sheet (`/questions?s=`), the session itself is one
// click, and Hand back needs no words.
export function EscalationCard({ item, canHandBack = true }: { item: QueueItem; canHandBack?: boolean }) {
  const esc = item.escalation!;
  const now = useCoarseNow(30_000);
  const text = splitEscalationLine(esc.line);
  const childTitle = useInboxStore((s) => s.sessions[esc.childId]?.title);
  const handBack = useInboxStore((s) => s.handSessionBackToRole);
  const reply = useReplyToEscalation();
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const openReply = useCallback(() => { setReplying(true); setTimeout(() => boxRef.current?.focus(), 0); }, []);
  const send = useCallback(() => { if (reply(item, draft)) { setDraft(""); setReplying(false); } }, [reply, item, draft]);
  const sheetHref = `/questions?s=${item.conversationId}`;
  const aboutRole = esc.childId !== item.conversationId;

  return (
    <div data-escalation-card={esc.childId} className="decision-card rounded-lg border bg-sol-card/40 border-sol-border/70 hover:border-sol-border transition-colors">
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim min-w-0">
          <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-sol-yellow animate-pulse" />
          {esc.role && <RoleFace role={esc.role} size={16} className="shrink-0" />}
          <span className="text-sol-text">{esc.role ? <span className="text-sol-violet">@{esc.role.handle}</span> : "A lead"} asks you</span>
          <span>· {formatTimeAgo(esc.at, now)} ago</span>
          {aboutRole && <span className="min-w-0 truncate"><EntityIdPill id={esc.childId} type="session" compact /></span>}
          <Link href={sheetHref} className="ml-auto flex items-center gap-1 text-sol-text-dim hover:text-sol-text" title="Read it whole, with the role's thread">
            open<ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
        {text.head && (
          <Link href={sheetHref} className="decision-question block mt-2 text-sol-text hover:text-sol-blue transition-colors">{text.head}</Link>
        )}
        <CollapsibleBody className="mt-2" collapsedHeight={96} toggleClassName="mt-1" expandLabel="Read the whole thing" collapseLabel="Show less">
          {(expanded) => (
            <div className="decision-card-body" data-escalation-body>
              {expanded ? <MarkdownRenderer content={text.body} /> : <p className="whitespace-pre-wrap">{stripMarkdown(text.body, { keepNewlines: true })}</p>}
            </div>
          )}
        </CollapsibleBody>
      </div>
      <div className="px-4 pb-3">
        {replying ? (
          <div data-escalation-reply={esc.childId}>
            <textarea
              ref={boxRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                if (e.key === "Escape") { e.preventDefault(); setReplying(false); }
              }}
              rows={3}
              placeholder={`Reply to ${esc.role ? `@${esc.role.handle}` : "the lead"}. It goes as a message, and the session is theirs again.`}
              className="w-full bg-sol-card border border-sol-border rounded px-2 py-1.5 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-blue/50"
            />
            <div className="flex items-center gap-3 mt-1 text-[11px] text-sol-text-dim">
              <button onClick={send} disabled={!draft.trim()} className="flex items-center gap-1.5 hover:text-sol-text disabled:opacity-40"><KeyCap size="xs">return</KeyCap><span>reply and hand back</span></button>
              <button onClick={() => setReplying(false)} className="flex items-center gap-1.5 hover:text-sol-text"><KeyCap size="xs">esc</KeyCap><span>cancel</span></button>
            </div>
          </div>
        ) : (
          <div className="flex items-center flex-wrap gap-2 text-[12px]">
            <button onClick={openReply} data-escalation-gesture="reply" className="px-2.5 py-1 rounded border border-sol-yellow/40 text-sol-text hover:bg-sol-yellow hover:text-sol-bg transition-colors">
              Reply
            </button>
            <button
              onClick={() => useInboxStore.getState().navigateToSession(esc.childId)}
              data-escalation-gesture="open"
              className="px-2.5 py-1 rounded border border-sol-border text-sol-text-muted hover:text-sol-text transition-colors truncate max-w-[18rem]"
              title="Open the session the ask is about"
            >
              Open {childTitle || "the session"}
            </button>
            {canHandBack && (
              <button
                onClick={() => handBack(esc.childId)}
                data-role-gesture="hand-back"
                className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-sol-text-dim hover:text-sol-text transition-colors"
                title={`Hand it back${esc.role ? ` to @${esc.role.handle}` : ""} without answering. The role looks after it again and decides if it comes back.`}
              >
                <Undo2 className="w-3 h-3" />hand back
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

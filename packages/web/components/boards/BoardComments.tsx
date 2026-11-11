// Comment pins on the canvas and the thread a pin opens. Pins live in the
// world layer (they move with what they point at); the thread opens in
// screen space beside its pin.
import { memo, useMemo, useState } from "react";
import { Bot, Check } from "lucide-react";
import { elementBox } from "@codecast/shared/artifacts/board";
import type { ArtifactElement } from "@codecast/shared/artifacts";
import { relativeTime } from "../../lib/entityDisplay";
import type { BoardEl } from "./boardTypes";

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Where a comment pin sits in world space: its point, else its anchor's top-right. */
export function pinPoint(c: ArtifactElement, byKey: Map<string, BoardEl>): { x: number; y: number } | null {
  const p = c.point as any;
  if (p && typeof p.x === "number" && typeof p.y === "number") return p;
  const a = typeof c.anchor === "string" ? byKey.get(c.anchor) : undefined;
  if (!a) return null;
  const b = elementBox(a);
  return { x: b.x + b.w - 8, y: b.y - 8 };
}

export type Thread = { root: ArtifactElement; replies: ArtifactElement[] };

export function useThreads(comments: ArtifactElement[]): Thread[] {
  return useMemo(() => {
    const replies = new Map<string, ArtifactElement[]>();
    for (const c of comments) if (typeof c.parent === "string") replies.set(c.parent, [...(replies.get(c.parent) ?? []), c]);
    return comments
      .filter((c) => !c.parent && !c.resolved)
      .map((root) => ({ root, replies: (replies.get(root.key) ?? []).sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0)) }));
  }, [comments]);
}

export const CommentPins = memo(function CommentPins({ threads, byKey, open, onOpen }: {
  threads: Thread[];
  byKey: Map<string, BoardEl>;
  open: string | null;
  onOpen(key: string): void;
}) {
  return (
    <>
      {threads.map(({ root, replies }) => {
        const at = pinPoint(root, byKey);
        if (!at) return null;
        return (
          <button
            key={root.key}
            type="button"
            data-board-ui
            className={`board-pin${open === root.key ? " is-open" : ""}${root.sent_to ? " is-agent" : ""}`}
            style={{ left: at.x, top: at.y }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onOpen(root.key)}
            aria-label={`Comment by ${root.author_name ?? "someone"}`}
          >
            <span>{initialsOf(String(root.author_name ?? "?"))}</span>
            {replies.length > 0 && <em>{replies.length + 1}</em>}
          </button>
        );
      })}
    </>
  );
});

export function CommentThreadPopover({ thread, at, onReply, onResolve, onClose }: {
  thread: Thread;
  at: { x: number; y: number };
  onReply(text: string): void;
  onResolve(): void;
  onClose(): void;
}) {
  const [text, setText] = useState("");
  const all = [thread.root, ...thread.replies];
  return (
    <div className="board-thread" data-board-ui style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="board-thread-head">
        {thread.root.sent_to ? <span className="board-thread-agent"><Bot size={12} strokeWidth={1.75} /> Sent to agent</span> : <span />}
        <button type="button" className="board-bar-btn" aria-label="Resolve" onClick={onResolve}><Check size={14} strokeWidth={2} /></button>
      </div>
      <div className="board-thread-list" data-board-scroll>
        {all.map((c) => (
          <div key={c.key} className="board-thread-item">
            <span className="board-prompt-avatar is-small">{initialsOf(String(c.author_name ?? "?"))}</span>
            <div>
              <div className="board-thread-meta"><b>{String(c.author_name ?? "Someone")}</b> {typeof c.created_at === "number" ? relativeTime(c.created_at) : ""}</div>
              <div className="board-thread-text">{String(c.text ?? "")}</div>
            </div>
          </div>
        ))}
      </div>
      <textarea
        className="board-prompt-input board-thread-reply"
        rows={1}
        value={text}
        placeholder="Reply"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && !e.shiftKey && text.trim()) { e.preventDefault(); onReply(text.trim()); setText(""); }
        }}
      />
    </div>
  );
}

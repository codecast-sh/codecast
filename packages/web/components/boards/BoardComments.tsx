// Comment pins on the canvas and the thread a pin opens. Pins live in the
// world layer (they move with what they point at); the thread opens in
// screen space beside its pin.
import { memo, useState } from "react";
import { Bot, Check } from "lucide-react";
import type { ArtifactElement } from "@codecast/shared/artifacts";
import { relativeTime } from "../../lib/entityDisplay";
import type { BoardEl } from "./boardTypes";
import { initialsOf, pinOnFace, pinPoints, type Thread } from "./commentThreads";

export const CommentPins = memo(function CommentPins({ threads, byKey, open, onOpen }: {
  threads: Thread[];
  byKey: Map<string, BoardEl>;
  open: string | null;
  onOpen(key: string): void;
}) {
  const at_ = pinPoints(threads, byKey);
  return (
    <>
      {threads.map(({ root, replies }) => {
        const at = at_.get(root.key);
        if (!at) return null;
        return (
          <button
            key={root.key}
            type="button"
            data-board-ui
            className={`board-pin${open === root.key ? " is-open" : ""}${root.sent_to ? " is-agent" : ""}${pinOnFace(root, byKey) ? " is-on-face" : ""}`}
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

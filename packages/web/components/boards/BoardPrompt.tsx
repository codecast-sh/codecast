// One floating composer for the three ways a person talks to the board:
// a comment pin (optionally sent to an agent), Ask agent from the toolbar,
// and Describe a change on a selection. Routing is the foundation's sendAsk:
// Enter starts a new agent in the board's project, Cmd+Enter picks a
// running session.
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Bot } from "lucide-react";
import type { ArtifactElement } from "@codecast/shared/artifacts";
import { pickAskTarget, sendAsk, useAskDraft, type AskDoc } from "../live/askAgent";
import { BOARD_ASK_SLOT } from "./boardModel";
import { KeyCap } from "../KeyCap";
import { isMac } from "../../shortcuts/registry";

export type PromptMode = "comment" | "ask" | "describe";

export function BoardPrompt({ mode, at, doc, selected, initials, onComment, onClose, onSent }: {
  mode: PromptMode;
  /** Screen point the bubble hangs from (its top-left for comments, bottom-center otherwise). */
  at: { x: number; y: number };
  doc: AskDoc;
  selected: ArtifactElement[];
  initials: string;
  /** Post the comment; returns its key. */
  onComment(text: string): string;
  onClose(): void;
  onSent(sessionId: string | null, commentKey?: string): void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // An ask's words live in the shared Ask draft, so a cancelled start brings them back; a comment's are its own.
  const askDraft = useAskDraft(doc._id, BOARD_ASK_SLOT);
  const [commentText, setCommentText] = useState("");
  const text = mode === "comment" ? commentText : askDraft.text;
  const setText = mode === "comment" ? setCommentText : askDraft.setText;
  // A comment goes to an agent when the box is ticked. Typing @agent ticks it
  // once; after the person touches the box, their choice stands.
  const [toAgent, setToAgent] = useState(mode !== "comment");
  const touched = useRef(false);
  const onText = (v: string) => {
    setText(v);
    if (!touched.current && mode === "comment" && /(^|\s)@agent\b/i.test(v)) setToAgent(true);
  };
  const sending = mode !== "comment" || toAgent;

  useLayoutEffect(() => { ref.current?.focus(); }, []);

  // The comment posts once, even when the person backs out of the session picker and sends again.
  const postedKey = useRef<string | undefined>(undefined);
  const submit = (pick: boolean) => {
    const body = text.trim();
    if (!body) return;
    const prompt = body.replace(/(^|\s)@agent\b/gi, "$1").trim() || body;
    if (mode === "comment" && !postedKey.current) postedKey.current = onComment(body);
    const commentKey = postedKey.current;
    if (!sending) { onClose(); return; }
    const go = async (target: Parameters<typeof sendAsk>[2]) => {
      onClose();
      // A new agent opens the shared start confirm; a cancel there resolves to null.
      onSent(await sendAsk(doc, { slot: mode === "comment" ? undefined : BOARD_ASK_SLOT, prompt, selected, comment_key: commentKey }, target), commentKey);
    };
    if (pick) pickAskTarget(mode === "comment" ? "Send this comment to…" : "Ask which agent?", (t) => void go(t), () => ref.current?.focus());
    else void go({ kind: "new" });
  };

  const placeholder = mode === "comment" ? "Comment, or @agent to ask" : mode === "describe" ? `Describe a change to ${selected.length === 1 ? "this" : `these ${selected.length}`}` : "What should the agent lay out?";
  return (
    <div
      className={`board-prompt board-prompt-${mode}`}
      data-board-ui
      style={{ left: at.x, top: at.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {mode === "comment" && <span className="board-prompt-avatar">{initials}</span>}
      <div className="board-prompt-card">
        <textarea
          ref={ref}
          rows={mode === "comment" ? 2 : 1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(e.metaKey || e.ctrlKey); }
          }}
          className="board-prompt-input"
        />
        <div className="board-prompt-foot">
          {mode === "comment" ? (
            <label className="board-prompt-check">
              <input type="checkbox" checked={sending} onChange={(e) => { touched.current = true; setToAgent(e.target.checked); }} />
              Send to agent
            </label>
          ) : (
            selected.length > 0 && <span className="board-prompt-hint"><Bot size={13} strokeWidth={1.75} />{selected.length} selected</span>
          )}
          <span className="flex-1" />
          {sending ? (
            <>
              <button type="button" className="board-prompt-alt" disabled={!text.trim()} onClick={() => submit(true)}>
                Session… <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">↵</KeyCap>
              </button>
              <button type="button" className="board-prompt-go" disabled={!text.trim()} onClick={() => submit(false)}>
                New agent <KeyCap size="xs" tone="onAccent">↵</KeyCap>
              </button>
            </>
          ) : (
            <button type="button" className="board-prompt-send" disabled={!text.trim()} aria-label="Comment" onClick={() => submit(false)}>
              <ArrowUp size={14} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";
/**
 * A project's update posts: the composer and the card each post wears on the
 * project's Timeline (components/ProjectTimeline.tsx), where the composer sits
 * on top and the posts stand among everything else that happened.
 *
 * Tasks say what is true right now; updates say what happened and why it
 * matters, in a human voice: a status post before a review, an agent's weekly
 * digest of what changed. Each post carries a flat comment thread underneath,
 * the same shape task comments have.
 *
 * Posts render from the store's projectUpdates collection, fed by
 * projectUpdates.webList for the project on screen, and every gesture is a
 * store action (store/projectUpdatesSlice.ts) that paints at once and rides
 * the outbox to the web mutation. Editing a post's body is undoable.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Megaphone, MessageSquare, Pencil, Sparkles, Trash2 } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { newProjectUpdateKey, type ProjectUpdateComment, type ProjectUpdateRow } from "../store/projectUpdatesSlice";
import { relTimeShort } from "../lib/utils";
import { CommentAvatar } from "./comments/CommentAvatar";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";
import { KeyCap } from "./KeyboardShortcutsHelp";


type UpdateComment = ProjectUpdateComment;
type ProjectUpdate = ProjectUpdateRow;

/** Auto-growing textarea with the app's ⌘↵-to-send convention. Sizes itself
 *  to its content on mount too, so editing a long update opens at full
 *  height instead of clipping to minRows until the first keystroke. */
function GrowingTextarea({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  autoFocus,
  minRows = 1,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  placeholder: string;
  autoFocus?: boolean;
  minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
    if (autoFocus) el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);
  return (
    <textarea
      ref={ref}
      value={value}
      rows={minRows}
      autoFocus={autoFocus}
      placeholder={placeholder}
      className="w-full bg-transparent text-xs text-sol-text placeholder:text-sol-text-dim/60 outline-none resize-none leading-relaxed"
      onChange={(e) => {
        onChange(e.target.value);
        e.target.style.height = "auto";
        e.target.style.height = e.target.scrollHeight + "px";
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSubmit();
        } else if (e.key === "Escape" && onCancel) {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

export function UpdateComposer({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const submit = useCallback(() => {
    const trimmed = body.trim();
    if (!trimmed) return;
    useInboxStore.getState().postProjectUpdate(projectId, {
      client_key: newProjectUpdateKey(),
      body: trimmed,
      title: title.trim() || undefined,
    });
    setTitle("");
    setBody("");
    setOpen(false);
  }, [body, title, projectId]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-sol-border/30 bg-sol-bg-alt/40 text-xs text-sol-text-dim hover:border-sol-border/60 hover:text-sol-text-muted transition-colors text-left"
        data-project-update-open
      >
        <Megaphone className="w-3.5 h-3.5 flex-shrink-0" />
        Post an update…
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-sol-border/40 bg-sol-bg p-3" data-project-update-form>
      <input
        type="text"
        value={title}
        autoFocus
        placeholder="Title (optional)"
        className="w-full bg-transparent text-sm font-medium text-sol-text placeholder:text-sol-text-dim/60 outline-none mb-2"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <GrowingTextarea
        value={body}
        onChange={setBody}
        onSubmit={submit}
        onCancel={() => setOpen(false)}
        placeholder="What happened? Markdown works."
        minRows={3}
      />
      <div className="flex items-center justify-end gap-2 mt-2 pt-2 border-t border-sol-border/20">
        <button
          onClick={() => setOpen(false)}
          className="px-2 py-1 rounded-md text-[11px] text-sol-text-dim hover:text-sol-text transition-colors"
        >
          Cancel <KeyCap size="xs">Esc</KeyCap>
        </button>
        <button
          onClick={submit}
          disabled={!body.trim()}
          className="px-2.5 py-1 rounded-md text-[11px] bg-sol-bg-highlight text-sol-text border border-sol-border/40 hover:border-sol-border/70 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Post <span className="cc-bar-keys"><KeyCap size="xs">⌘</KeyCap><KeyCap size="xs">↵</KeyCap></span>
        </button>
      </div>
    </div>
  );
}

function CommentRow({ comment }: { comment: UpdateComment }) {
  return (
    <div className="flex gap-2">
      <CommentAvatar name={comment.author} isAgent={comment.author_kind === "agent"} size={18} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium text-sol-text">{comment.author}</span>
          <span className="text-[10px] text-sol-text-dim tabular-nums">{relTimeShort(comment.created_at)}</span>
        </div>
        <div className="text-xs text-sol-text-muted">
          <MarkdownRenderer content={comment.text} className="cc-cmt-md" />
        </div>
      </div>
    </div>
  );
}

export function UpdateCard({ update, currentUserId }: { update: ProjectUpdate; currentUserId?: string }) {
  const [commenting, setCommenting] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(update.body);

  const mine = !!currentUserId && String(update.author_user_id) === String(currentUserId);
  const digest = update.kind === "digest";

  const submitComment = useCallback(() => {
    const text = commentDraft.trim();
    if (!text) return;
    useInboxStore.getState().commentProjectUpdate(update._id, text);
    setCommentDraft("");
    setCommenting(false);
  }, [commentDraft, update._id]);

  const saveEdit = useCallback(() => {
    const next = bodyDraft.trim();
    setEditing(false);
    if (!next || next === update.body) {
      setBodyDraft(update.body);
      return;
    }
    useInboxStore.getState().editProjectUpdate(update._id, next);
  }, [bodyDraft, update._id, update.body]);

  // Two-step inline confirm instead of window.confirm: the first click arms
  // the button, the second (within 3s) deletes. No blocking dialog.
  const [armed, setArmed] = useState(false);
  const confirmDelete = useCallback(() => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    setArmed(false);
    useInboxStore.getState().deleteProjectUpdate(update._id);
  }, [armed, update._id]);

  return (
    <div className="flex-1 min-w-0 rounded-lg border border-sol-border/30 bg-sol-bg group" id={`update-${update._id}`} data-project-update={update._id}>
      <div className="p-3">
        <div className="flex items-center gap-2">
          <CommentAvatar name={update.author} isAgent={update.author_kind === "agent"} size={22} />
          <div className="flex items-baseline gap-2 flex-1 min-w-0">
            <span className="text-xs font-medium text-sol-text truncate">{update.author}</span>
            {digest && (
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-px rounded-full bg-sol-violet/10 text-sol-violet border border-sol-violet/20 flex-shrink-0">
                <Sparkles className="w-2.5 h-2.5" /> digest
              </span>
            )}
            <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">
              {relTimeShort(update.created_at)}
              {update.edited_at && <span className="text-sol-text-dim/60"> · edited</span>}
            </span>
          </div>
          {mine && !editing && (
            <div className={`flex items-center gap-1 transition-opacity ${armed ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
              <button
                onClick={() => { setBodyDraft(update.body); setEditing(true); }}
                className="p-1 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60 transition-colors"
                title="Edit"
              >
                <Pencil className="w-3 h-3" />
              </button>
              <button
                onClick={confirmDelete}
                className={`p-1 rounded transition-colors flex items-center gap-1 ${
                  armed
                    ? "text-sol-red bg-sol-red/10"
                    : "text-sol-text-dim hover:text-sol-red hover:bg-sol-bg-alt/60"
                }`}
                title={armed ? "Click again to remove" : "Remove"}
              >
                <Trash2 className="w-3 h-3" />
                {armed && <span className="text-[10px]">sure?</span>}
              </button>
            </div>
          )}
        </div>

        {update.title && <h3 className="text-sm font-medium text-sol-text mt-2">{update.title}</h3>}

        {editing ? (
          <div className="mt-2">
            <GrowingTextarea
              value={bodyDraft}
              onChange={setBodyDraft}
              onSubmit={saveEdit}
              onCancel={() => { setEditing(false); setBodyDraft(update.body); }}
              placeholder="Update body"
              autoFocus
              minRows={3}
            />
            <div className="flex items-center justify-end gap-2 mt-1">
              <button
                onClick={() => { setEditing(false); setBodyDraft(update.body); }}
                className="px-2 py-1 rounded-md text-[11px] text-sol-text-dim hover:text-sol-text transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                className="px-2.5 py-1 rounded-md text-[11px] bg-sol-bg-highlight text-sol-text border border-sol-border/40 transition-colors"
              >
                Save <span className="cc-bar-keys"><KeyCap size="xs">⌘</KeyCap><KeyCap size="xs">↵</KeyCap></span>
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-1.5 text-xs text-sol-text-muted">
            <MarkdownRenderer content={update.body} className="cc-cmt-md" />
          </div>
        )}
      </div>

      {/* Discussion. Border only when there is something under it. */}
      {(update.comments.length > 0 || commenting) && (
        <div className="border-t border-sol-border/20 px-3 py-2.5 space-y-2.5">
          {update.comments.map((c) => (
            <CommentRow key={c._id} comment={c} />
          ))}
          {commenting && (
            <div className="flex gap-2 items-start">
              <div className="flex-1 rounded-md border border-sol-border/40 px-2 py-1.5">
                <GrowingTextarea
                  value={commentDraft}
                  onChange={setCommentDraft}
                  onSubmit={submitComment}
                  onCancel={() => { setCommenting(false); setCommentDraft(""); }}
                  placeholder="Comment… ⌘↵ to send"
                  autoFocus
                />
              </div>
            </div>
          )}
        </div>
      )}
      {!commenting && (
        <button
          onClick={() => setCommenting(true)}
          className="flex items-center gap-1.5 px-3 pb-2.5 pt-0 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors"
        >
          <MessageSquare className="w-3 h-3" />
          {update.comments.length > 0 ? "Reply" : "Comment"}
        </button>
      )}
    </div>
  );
}

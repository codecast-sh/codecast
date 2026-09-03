"use client";
/**
 * The Updates tab: a project's own feed of posts.
 *
 * Tasks say what is true right now; updates say what happened and why it
 * matters, in a human voice — a status post before a review, an agent's weekly
 * digest of what changed. Each post carries a flat comment thread underneath,
 * the same shape task comments have.
 *
 * Data comes straight from reactive queries (api.projectUpdates.*), not the
 * synced store: these tables are untracked children of the project, the same
 * trade task_comments makes, so Convex keeps this view live on its own.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Megaphone, MessageSquare, Pencil, Sparkles, Trash2 } from "lucide-react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useInboxStore } from "../store/inboxStore";
import { relTimeShort } from "../lib/utils";
import { CommentAvatar } from "./comments/CommentAvatar";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";
import { KeyCap } from "./KeyboardShortcutsHelp";

const api = _api as any;

type UpdateComment = {
  _id: string;
  author: string;
  author_user_id?: string;
  author_kind: "user" | "agent";
  text: string;
  created_at: number;
};

type ProjectUpdate = {
  _id: string;
  short_id?: string;
  author: string;
  author_user_id?: string;
  author_kind: "user" | "agent";
  kind: "update" | "digest";
  title?: string;
  body: string;
  created_at: number;
  edited_at?: number;
  comments: UpdateComment[];
};

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

function UpdateComposer({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const post = useMutation(api.projectUpdates.webPost);

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed || posting) return;
    setPosting(true);
    try {
      await post({
        project_id: projectId,
        body: trimmed,
        title: title.trim() || undefined,
      });
      setTitle("");
      setBody("");
      setOpen(false);
    } catch {
      toast.error("Could not post the update");
    } finally {
      setPosting(false);
    }
  }, [body, title, posting, post, projectId]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-sol-border/30 text-xs text-sol-text-dim hover:border-sol-border/60 hover:text-sol-text-muted transition-colors text-left"
      >
        <Megaphone className="w-3.5 h-3.5 flex-shrink-0" />
        Post an update…
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-sol-border/40 bg-sol-bg p-3">
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
          disabled={!body.trim() || posting}
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

function UpdateCard({ update, currentUserId }: { update: ProjectUpdate; currentUserId?: string }) {
  const [commenting, setCommenting] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(update.body);
  const sending = useRef(false);
  const comment = useMutation(api.projectUpdates.webComment);
  const edit = useMutation(api.projectUpdates.webEdit);
  const remove = useMutation(api.projectUpdates.webDelete);

  const mine = !!currentUserId && String(update.author_user_id) === String(currentUserId);
  const digest = update.kind === "digest";

  const submitComment = useCallback(async () => {
    const text = commentDraft.trim();
    if (!text || sending.current) return;
    sending.current = true;
    try {
      await comment({ update_id: update._id, text });
      setCommentDraft("");
      setCommenting(false);
    } catch {
      toast.error("Could not post the comment");
    } finally {
      sending.current = false;
    }
  }, [commentDraft, comment, update._id]);

  const saveEdit = useCallback(async () => {
    const next = bodyDraft.trim();
    setEditing(false);
    if (!next || next === update.body) {
      setBodyDraft(update.body);
      return;
    }
    try {
      await edit({ id: update._id, body: next });
    } catch {
      // The draft is the only copy of what they typed — reopen with it intact.
      toast.error("Could not save the edit");
      setEditing(true);
    }
  }, [bodyDraft, edit, update._id, update.body]);

  // Two-step inline confirm instead of window.confirm: the first click arms
  // the button, the second (within 3s) deletes. No blocking dialog.
  const [armed, setArmed] = useState(false);
  const confirmDelete = useCallback(async () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 3000);
      return;
    }
    setArmed(false);
    try {
      await remove({ id: update._id });
    } catch {
      toast.error("Could not remove the update");
    }
  }, [armed, remove, update._id]);

  return (
    <div className="rounded-lg border border-sol-border/30 bg-sol-bg group">
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

export function ProjectUpdates({ projectId }: { projectId: string }) {
  const { data: updates, error, retry } = useQueryNoThrow(
    api.projectUpdates.webList,
    projectId ? { project_id: projectId } : "skip",
  );
  const currentUserId = useInboxStore((s: any) => s.currentUser?._id && String(s.currentUser._id));
  const list = useMemo(() => (updates ?? []) as ProjectUpdate[], [updates]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto py-12 text-center">
        <p className="text-xs text-sol-text-dim">Updates could not load.</p>
        <button onClick={retry} className="mt-2 text-[11px] text-sol-cyan hover:underline">
          Try again
        </button>
      </div>
    );
  }
  if (updates === undefined) {
    return (
      <div className="max-w-3xl mx-auto py-12 text-center text-xs text-sol-text-dim">Loading updates…</div>
    );
  }
  // null = the server refused (signed out, or no access to this project).
  // Showing a live composer here would just set the poster up to fail.
  if (updates === null) {
    return (
      <div className="max-w-3xl mx-auto py-12 text-center text-xs text-sol-text-dim">
        You don't have access to this project's updates.
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-4 px-2 space-y-3">
      <UpdateComposer projectId={projectId} />
      {list.map((u) => (
        <UpdateCard key={u._id} update={u} currentUserId={currentUserId} />
      ))}
      {list.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Megaphone className="w-8 h-8 text-sol-text-dim/20 mb-2" />
          <p className="text-xs text-sol-text-dim">No updates yet</p>
          <p className="text-[11px] text-sol-text-dim/60 mt-1">
            Post the first one above, or let an agent post with{" "}
            <code className="px-1 py-px rounded bg-sol-bg-alt text-sol-text-muted">cast project post</code>
          </p>
        </div>
      )}
    </div>
  );
}

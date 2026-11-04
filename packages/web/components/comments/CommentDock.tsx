import { memo, useMemo, useState } from "react";
import { Quote, FileCode2, CheckCircle2, RotateCcw } from "lucide-react";
import { SlotActions } from "../workspace/Slot";
import { useInboxStore, selectCommentRailOpen } from "../../store/inboxStore";
import { useDiffViewerStore } from "../../store/diffViewerStore";
import { getRelativePath } from "@codecast/shared/render";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { isConvexId } from "../../lib/entityLinks";
import { cleanContent } from "../../lib/conversationProcessor";
import { useConversationComments } from "../../hooks/useConversationComments";
import { messageExcerpt, type CommentThread as CommentThreadModel } from "../../lib/commentThread";
import { useConversationAgentType } from "../../hooks/useConversationAgentType";
import { CommentThread } from "./CommentThread";

import { useWatchEffect } from "../../hooks/useWatchEffect";
import { EdgeResizeHandle, useEdgeResize } from "../../hooks/useEdgeResize";
// The conversation's GLOBAL comment thread as a right-docked, full-height rail —
// like the sidebar, on the other side. It slides away to nothing when closed (no
// minimized stub) and is reopened from the header's comments toggle, mirroring
// the left sidebar exactly. Open it fills the height and is width-resizable by
// dragging its left edge. Anchored threads live inline at their messages; the
// rail also lists them as jump targets. Publishes its width via commentRailWidth
// so the conversation makes room for it.

const MIN_W = 300;
const MAX_W = 760;
const DEFAULT_W = 384;
const WIDTH_KEY = "cc-comment-rail-width";

const commitWidth = (w: number) => useInboxStore.getState().wsSetSize("context", w);

// The context slot's size serves whichever pane holds the right edge — pixels
// for this rail, a percent for the session list — so only a plausibly-pixel
// value counts as ours.
function slotPixelWidth(v: number | undefined): number | undefined {
  return v !== undefined && v >= MIN_W && v <= MAX_W ? v : undefined;
}

// Jump to a code thread: open the diff panel focused on the thread's file.
// The anchor stores the workspace-relative path; the panel's change list holds
// raw tool paths, so match through the same normalization the anchor used.
function jumpToFileThread(t: CommentThreadModel) {
  const st = useDiffViewerStore.getState();
  st.setDiffPanelOpen(true);
  const change = st.changes.find((c) => getRelativePath(c.filePath) === t.filePath);
  if (change) st.selectFile(change.filePath);
}

/** One row per anchored thread: where it hangs, its opening words, its size.
 *  Opening it scrolls the transcript to the message (or opens the diff at the
 *  line); the check resolves or reopens it in place. */
function ThreadRow({ t, conversationId, label, onJump }: { t: CommentThreadModel; conversationId: string; label: string; onJump: () => void }) {
  // What the thread says; what it hangs on is the row's tooltip.
  const text = messageExcerpt(t.comments[0]?.content, 90, cleanContent) ?? label;
  const Icon = t.filePath ? FileCode2 : Quote;
  return (
    <div className={"cc-railx-row" + (t.resolved ? " is-resolved" : "")} data-comment-rail-row>
      <button type="button" className="cc-railx-row-main" onClick={onJump} title={label}>
        <Icon className="cc-railx-row-icon" />
        <span className="cc-railx-row-text">
          {t.filePath && <span className="cc-railx-row-where">{t.filePath.split("/").pop()}{t.lineNumber ? `:${t.lineNumber}` : ""}</span>}
          {text}
        </span>
        <span className="cc-railx-row-count">{t.comments.length}</span>
      </button>
      <button
        type="button"
        className="cc-railx-row-resolve"
        title={t.resolved ? "Reopen" : "Resolve"}
        aria-label={t.resolved ? "Reopen" : "Resolve"}
        onClick={() => useInboxStore.getState().resolveCommentThread(conversationId, { messageId: t.messageId, filePath: t.filePath, lineNumber: t.lineNumber }, !t.resolved)}
      >
        {t.resolved ? <RotateCcw className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
      </button>
    </div>
  );
}

function CommentRailImpl({ conversationId, onJumpToMessage }: { conversationId: string; onJumpToMessage?: (messageId: string) => void }) {
  const { user, isAuthenticated } = useCurrentUser();
  const currentUserId = user?._id as string | undefined;
  const comments = useConversationComments(conversationId);

  const open = useInboxStore(selectCommentRailOpen);
  const setOpen = useInboxStore((s) => s.setCommentRailOpen);
  const setWidth = useInboxStore((s) => s.setCommentRailWidth);
  const commentsEnabled = useInboxStore((s) => s.clientState.ui?.comments_enabled ?? false);
  // The rail is opt-in, but a conversation that already has comments keeps it
  // available so you can read + reply to what teammates left.
  const railEnabled = commentsEnabled || comments.totalCount > 0;
  const agentType = useConversationAgentType(conversationId);
  const messages = useInboxStore((s) => s.messages[conversationId]) as Array<{ _id: string; content?: string }> | undefined;

  // The context slot owns the rail's width (a workbench restores it with the
  // rest of the chrome); localStorage is the seed for widths that predate that.
  const slotWidth = useInboxStore((s) =>
    s.workspace.context.pane?.kind === "comments" ? slotPixelWidth(s.workspace.context.size) : undefined,
  );
  const { width, setWidth: setW, dragging, onResizeDown } = useEdgeResize({
    storageKey: WIDTH_KEY,
    min: MIN_W,
    max: MAX_W,
    fallback: DEFAULT_W,
    initial: slotWidth,
    onCommit: commitWidth,
  });
  useWatchEffect(() => {
    if (slotWidth !== undefined && !dragging.current) setW(slotWidth);
  }, [slotWidth]);

  // The rail stays positioned and slides off the right edge when closed (mirror
  // of the left sidebar). Keep the heavy thread in the DOM through the slide-out,
  // then unmount it a beat later so a closed rail renders nothing off-screen.
  const [mounted, setMounted] = useState(open);
  useWatchEffect(() => {
    if (open) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(t);
  }, [open]);

  // Publish the rail width while open: the conversation pads its right edge by
  // it so the rail never covers the header or the transcript, and the floating
  // scroll arrows slide clear of it.
  useWatchEffect(() => {
    setWidth(conversationId, open && railEnabled ? width : 0);
    return () => setWidth(conversationId, 0);
  }, [conversationId, open, width, railEnabled, setWidth]);

  // Open threads first, newest activity first; resolved ones sink below.
  const threads = useMemo(
    () => [...comments.files, ...comments.anchored].sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.lastActivity - a.lastActivity),
    [comments.files, comments.anchored],
  );

  // Comment tools off and nothing to read → the rail doesn't exist at all (this
  // also catches the keyboard shortcut, not just the now-hidden header toggle).
  if (!railEnabled) return null;

  const messageText = (id?: string) => messageExcerpt((messages ?? []).find((m) => m._id === id)?.content, 140, cleanContent);

  return (
    <aside className={`cc-railx${open ? "" : " cc-railx--closed"}`} style={{ width }} aria-hidden={!open} data-comment-rail>
      {mounted && (
      <>
      <EdgeResizeHandle onResizeDown={onResizeDown} />
      <header className="cc-railx-head">
        <span className="cc-railx-title">Comments</span>
        {comments.totalCount > 0 && <span className="cc-railx-count">{comments.totalCount}</span>}
        {/* Shared controls: this rail dismisses exactly like the session list
            it shares this edge with. */}
        <SlotActions slot="context" onClose={() => setOpen(false)} />
      </header>

      {threads.length > 0 && (
        <div className="cc-railx-threads" data-comment-rail-threads>
          {threads.map((t) => (
            <ThreadRow
              key={t.key}
              t={t}
              conversationId={conversationId}
              label={t.filePath ? `${t.filePath}${t.lineNumber ? `:${t.lineNumber}` : ""}` : messageText(t.messageId) ?? "Comment on a message"}
              onJump={() => (t.filePath ? jumpToFileThread(t) : t.messageId && onJumpToMessage?.(t.messageId))}
            />
          ))}
        </div>
      )}

      <div className="cc-railx-global">
        <CommentThread
          thread={comments.global}
          conversationId={conversationId}
          variant="global"
          authed={isAuthenticated}
          canWrite={isAuthenticated}
          currentUserId={currentUserId}
          composerAutoFocus
          placeholder="Comment on this conversation…"
          onAdd={comments.addComment}
          onEdit={comments.editComment}
          onDelete={comments.deleteComment}
          onAskAgent={comments.askAgent}
          agentType={agentType}
        />
      </div>
      </>
      )}
    </aside>
  );
}

export const CommentDock = memo(function CommentDock({
  conversationId,
  onJumpToMessage,
}: {
  conversationId: string;
  /** The transcript's own jump: pages the message in, opens a folded turn, flashes it. */
  onJumpToMessage?: (messageId: string) => void;
}) {
  if (!isConvexId(conversationId)) return null;
  return <CommentRailImpl conversationId={conversationId} onJumpToMessage={onJumpToMessage} />;
});

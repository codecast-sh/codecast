import { memo, useCallback, useRef, useState } from "react";
import { MessageSquare, CornerUpRight, Quote, FileCode2, CheckCircle2, RotateCcw } from "lucide-react";
import { SlotActions } from "../workspace/Slot";
import { useInboxStore, selectCommentRailOpen } from "../../store/inboxStore";
import { useDiffViewerStore } from "../../store/diffViewerStore";
import { getRelativePath } from "@codecast/shared/render";
import type { CommentThread as CommentThreadModel } from "../../lib/commentThread";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { isConvexId } from "../../lib/entityLinks";
import { cleanContent } from "../../lib/conversationProcessor";
import { useConversationComments } from "../../hooks/useConversationComments";
import { isAgentComment } from "../../lib/commentThread";
import { CommentThread } from "./CommentThread";

import { useWatchEffect } from "../../hooks/useWatchEffect";
// The conversation's GLOBAL comment thread as a right-docked, full-height rail —
// like the sidebar, on the other side. It slides away to nothing when closed (no
// minimized stub) and is reopened from the header's comments toggle, mirroring
// the left sidebar exactly. Open it fills the height and is width-resizable by
// dragging its left edge. Anchored threads live inline at their messages; the
// rail also lists them as jump targets. Publishes its width via commentRailWidth
// so the floating scroll arrows slide clear of it.

const MIN_W = 300;
const MAX_W = 760;
const DEFAULT_W = 384;
const WIDTH_KEY = "cc-comment-rail-width";

function loadWidth(): number {
  if (typeof window === "undefined") return DEFAULT_W;
  const v = Number(window.localStorage.getItem(WIDTH_KEY));
  return v >= MIN_W && v <= MAX_W ? v : DEFAULT_W;
}

// The context slot's size serves whichever pane holds the right edge — pixels
// for this rail, a percent for the session list — so only a plausibly-pixel
// value counts as ours.
function slotPixelWidth(v: number | undefined): number | undefined {
  return v !== undefined && v >= MIN_W && v <= MAX_W ? v : undefined;
}

function snippetFor(content: string | undefined): string {
  if (!content) return "a message";
  return cleanContent(content).replace(/```[\s\S]*?```/g, " code ").replace(/\s+/g, " ").trim().slice(0, 64) || "a message";
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

function jumpToMessage(conversationId: string, messageId: string) {
  const st = useInboxStore.getState();
  // Navigate + load the message even if it isn't in the current window (the
  // conversation view honors scrollToMessageId and pages it in); then anchor the
  // per-message rail there. If it's already on screen, flash it right away.
  st.requestNavigate(conversationId, { scrollToMessageId: messageId, source: "gesture" });
  st.openCommentThread(messageId);
  const el = document.getElementById("msg-" + messageId);
  if (el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("cc-msg-flash");
    setTimeout(() => el.classList.remove("cc-msg-flash"), 1300);
  }
}

function CommentRailImpl({ conversationId }: { conversationId: string }) {
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
  const agentType = useInboxStore((s) => ((s.conversations[conversationId] ?? s.sessions[conversationId]) as { agent_type?: string } | undefined)?.agent_type ?? "claude_code");
  const messages = useInboxStore((s) => s.messages[conversationId]) as Array<{ _id: string; content?: string }> | undefined;

  // The context slot owns the rail's width (a workbench restores it with the
  // rest of the chrome); localStorage is the seed for widths that predate that.
  const slotWidth = useInboxStore((s) =>
    s.workspace.context.pane?.kind === "comments" ? slotPixelWidth(s.workspace.context.size) : undefined,
  );
  const [width, setW] = useState(() => slotWidth ?? loadWidth());
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  useWatchEffect(() => {
    if (slotWidth !== undefined && !dragRef.current) setW(slotWidth);
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

  const globalBusy = comments.global.comments.some((c) => isAgentComment(c) && (c.agent_status === "thinking" || c.agent_status === "streaming"));

  // Publish the rail width while open — the transcript does NOT pad for it (the
  // rail hangs over the right edge as an overlay), but the floating scroll arrows
  // read it to slide clear of the rail instead of hiding under it.
  useWatchEffect(() => {
    setWidth(conversationId, open && railEnabled ? width : 0);
    return () => setWidth(conversationId, 0);
  }, [conversationId, open, width, railEnabled, setWidth]);

  const onResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { x: e.clientX, w: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setW(Math.min(MAX_W, Math.max(MIN_W, d.w + (d.x - ev.clientX))));
    };
    const up = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setW((w) => {
        window.localStorage.setItem(WIDTH_KEY, String(w));
        useInboxStore.getState().wsSetSize("context", w);
        return w;
      });
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [width]);

  // Comment tools off and nothing to read → the rail doesn't exist at all (this
  // also catches the keyboard shortcut, not just the now-hidden header toggle).
  if (!railEnabled) return null;

  return (
    <aside className={`cc-railx${open ? "" : " cc-railx--closed"}`} style={{ width }} aria-hidden={!open}>
      {mounted && (
      <>
      <div className="cc-railx-resize" onMouseDown={onResizeDown} title="Drag to resize" />
      <header className="cc-railx-head">
        <MessageSquare className="w-3.5 h-3.5 text-sol-cyan" />
        <span className="cc-railx-title">Comments</span>
        {comments.totalCount > 0 && <span className="cc-railx-count">{comments.totalCount}</span>}
        {/* Shared controls: this rail dismisses exactly like the session list
            it shares this edge with. */}
        <SlotActions slot="context" onClose={() => setOpen(false)} />
      </header>

      {comments.files.length > 0 && (
        <div className="cc-railx-anchored">
          <div className="cc-railx-anchored-label">On code</div>
          {[...comments.files].sort((a, b) => Number(a.resolved) - Number(b.resolved)).map((t) => (
            <div key={t.key} className={`group/fthread flex items-center${t.resolved ? " opacity-50" : ""}`}>
              <button
                type="button"
                className="cc-railx-anchored-row flex-1 min-w-0"
                title="Open the diff panel at this file"
                onClick={() => t.filePath && jumpToFileThread(t)}
              >
                <FileCode2 className="w-3 h-3 shrink-0 text-sol-cyan/70" />
                <span className="cc-railx-anchored-snip font-mono">
                  {t.filePath}{t.lineNumber ? `:${t.lineNumber}` : ""}
                </span>
                <span className="cc-railx-anchored-count">{t.comments.length}</span>
                <CornerUpRight className="w-3 h-3 shrink-0 opacity-50" />
              </button>
              <button
                type="button"
                className="cc-comment-btn shrink-0 opacity-0 group-hover/fthread:opacity-100 transition-opacity"
                title={t.resolved ? "Reopen this thread" : "Resolve this thread"}
                onClick={() =>
                  useInboxStore.getState().resolveCommentThread(
                    conversationId,
                    { filePath: t.filePath, lineNumber: t.lineNumber },
                    !t.resolved,
                  )}
              >
                {t.resolved ? <RotateCcw className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
              </button>
            </div>
          ))}
        </div>
      )}

      {comments.anchored.length > 0 && (
        <div className="cc-railx-anchored">
          <div className="cc-railx-anchored-label">On specific messages</div>
          {comments.anchored.map((t) => (
            <button
              key={t.key}
              type="button"
              className="cc-railx-anchored-row"
              title="Jump to this message"
              onClick={() => t.messageId && jumpToMessage(conversationId, t.messageId)}
            >
              <Quote className="w-3 h-3 shrink-0 text-sol-cyan/70" />
              <span className="cc-railx-anchored-snip">{t.messageId ? snippetFor((messages ?? []).find((m) => m._id === t.messageId)?.content) : "a message"}</span>
              <span className="cc-railx-anchored-count">{t.comments.length}</span>
              <CornerUpRight className="w-3 h-3 shrink-0 opacity-50" />
            </button>
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
          emptyHint={
            comments.totalCount === 0
              ? "Start a thread for your team. Comments are visible to everyone who can see this conversation."
              : undefined
          }
          onAdd={comments.addComment}
          onEdit={comments.editComment}
          onDelete={comments.deleteComment}
          onAskAgent={comments.askAgent}
          agentBusy={globalBusy}
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
}: {
  conversationId: string;
}) {
  if (!isConvexId(conversationId)) return null;
  return <CommentRailImpl conversationId={conversationId} />;
});

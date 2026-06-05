import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { nanoid } from "nanoid";
import { useMountEffect } from "../hooks/useMountEffect";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { NewSessionView, MessageInput, ConversationData } from "./ConversationView";
import { soundNewSession } from "../lib/sounds";
import { isElectron } from "../lib/desktop";

/**
 * The floating new-session popup, shown in the palette window when summoned by
 * the global "New Session" shortcut. It reuses NewSessionView — the exact same
 * null-state surface (project picker + agent picker + message input) the in-app
 * empty conversation shows — so there is one component, not a parallel form.
 * Sending routes through onSubmitWithIntent:
 *   - Enter      → fire-and-forget: start the session, hide the popup, never
 *                  bring Codecast to the front.
 *   - Cmd+Enter  → send & open: start the session and switch into Codecast on
 *                  the new conversation.
 */
export function ComposeView({ initialQuery }: { initialQuery?: string }) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);

  // One fresh blank session per popup instance (PaletteRoot remounts via key).
  useMountEffect(() => {
    const store = useInboxStore.getState();
    const ctx = store.currentConversation;
    const path = ctx.projectPath || ctx.gitRoot || store.recentProjects?.[0]?.path;
    const agentType = (ctx.agentType || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";
    const sid = nanoid(10);
    const now = Date.now();

    soundNewSession();
    store.syncRecord("conversations", sid, {
      _id: sid, _creationTime: now, user_id: "", agent_type: agentType,
      session_id: sid, project_path: path, git_root: path || undefined,
      started_at: now, updated_at: now, message_count: 0, status: "active",
      title: "New session", messages: [],
    });
    const createPromise = store.createSession({
      agent_type: agentType,
      project_path: path,
      git_root: path || undefined,
      session_id: sid,
    }).then((convexId: string) => {
      if (convexId) store.resolveSessionId(sid, convexId);
      return convexId;
    });
    store.trackSessionCreate(sid, createPromise);
    createPromise.catch((e) => console.error("[ComposeView] createSession failed", e));

    if (initialQuery) store.setDraft(sid, { draft_message: initialQuery });
    setSessionId(sid);
  });

  // Resolve the real conversation id (create may still be in flight) and hand
  // off to Electron for focus management, or just navigate on the web.
  const handleSubmit = useCallback(async (navigate: boolean) => {
    if (!sessionId) return;
    const store = useInboxStore.getState();
    let convexId = isConvexId(sessionId) ? sessionId : store.getConvexId(sessionId);
    if (!convexId) {
      const pending = store.awaitSessionCreate(sessionId);
      if (pending) convexId = await pending.catch(() => undefined);
    }
    if (isElectron()) {
      window.__CODECAST_ELECTRON__?.composeSubmit?.({ conversationId: convexId, navigate });
      return;
    }
    if (convexId) router.push(`/conversation/${convexId}`);
  }, [sessionId, router]);

  const conversation = sessionId
    ? ({ _id: sessionId, status: "active" } as unknown as ConversationData)
    : null;

  return (
    <div className="w-[600px] h-[460px] max-h-[88vh] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
      <div className="flex-1 min-h-0 flex flex-col px-4 pt-6">
        {conversation && <NewSessionView conversation={conversation} />}
      </div>
      {conversation && (
        <MessageInput
          conversationId={conversation._id}
          status="active"
          embedded
          autoFocusInput
          onSubmitWithIntent={handleSubmit}
        />
      )}
      <div className="px-3 py-2 border-t border-sol-border/60 flex items-center justify-between text-[10px] text-sol-text-dim bg-sol-bg-alt/40 shrink-0">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">&#9166;</kbd>
            send
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">&#8984;&#9166;</kbd>
            send &amp; open
          </span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className="px-1.5 py-0.5 bg-sol-bg rounded border border-sol-border/80 text-sol-text-secondary">ESC</kbd>
          close
        </span>
      </div>
    </div>
  );
}

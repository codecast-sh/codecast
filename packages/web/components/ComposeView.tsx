import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMountEffect } from "../hooks/useMountEffect";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { NewSessionView, MessageInput, ConversationData } from "./ConversationView";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { formatShortcutParts } from "../shortcuts";
import { soundNewSession } from "../lib/sounds";
import { isElectron, bridge } from "../lib/desktop";
import { broadcastComposeOptimistic } from "../lib/composeBridge";

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
  // The last submit's intent. For "send & open" (true) we broadcast the send so
  // the MAIN window paints the first message optimistically; fire-and-forget
  // (false) needs no cross-window bubble (the app isn't showing the conversation).
  const navIntentRef = useRef(false);

  // One fresh blank session per popup instance (PaletteRoot remounts via key).
  useMountEffect(() => {
    const store = useInboxStore.getState();
    const ctx = store.currentConversation;
    const path = ctx.projectPath || ctx.gitRoot || store.recentProjects?.[0]?.path;
    const agentType = (ctx.agentType || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";

    soundNewSession();
    // Shared optimistic-create path — see store.beginOptimisticSession. One fresh
    // blank session per popup instance; the user types into it after it mounts.
    const { stubId: sid } = store.beginOptimisticSession({
      agentType,
      projectPath: path,
      gitRoot: path || undefined,
      create: (stubId) => store.createSession({
        agent_type: agentType,
        project_path: path,
        git_root: path || undefined,
        session_id: stubId,
      }),
    });

    if (initialQuery) store.setDraft(sid, { draft_message: initialQuery });
    setSessionId(sid);
  });

  // Robust autofocus for the popup. The message box's own mount-focus can lose
  // the race against the window becoming the OS "key window" when the popup is
  // summoned over another app (e.g. Chrome) — focus then lands on nothing and
  // keystrokes go nowhere. Re-grab it the instant the window actually gains
  // focus, plus a short delayed retry; mirrors how the search palette re-focuses
  // its input on show. Skips when the user already focused something inside the
  // popup (e.g. the project picker), so it never fights a deliberate focus.
  const rootRef = useRef<HTMLDivElement>(null);
  useMountEffect(() => {
    const focusInput = () => {
      const root = rootRef.current;
      if (!root || root.contains(document.activeElement)) return;
      root.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    };
    const t = setTimeout(focusInput, 60);
    window.addEventListener("focus", focusInput);
    return () => {
      clearTimeout(t);
      window.removeEventListener("focus", focusInput);
    };
  });

  // Escape closes the popup. MessageInput's keydown handler preventDefaults +
  // stopPropagations Escape (it's a 250ms double-tap-to-clear gesture in a real
  // conversation), so a normal bubble-phase listener never sees it. Listen in the
  // CAPTURE phase to close before MessageInput can swallow the key.
  useMountEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      const hide = bridge("paletteHide");
      if (hide) hide();
      else router.back();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  });

  // Dismiss the popup the instant the user submits — NEVER gate the hide on the
  // session create or the first-message send (both finish durably in the
  // background via the store's outbox). Resolving the real conversation id (the
  // create may still be in flight) only matters for navigation, so it runs after
  // the popup is already gone.
  const handleSubmit = useCallback((navigate: boolean) => {
    if (!sessionId) return;
    navIntentRef.current = navigate;
    const store = useInboxStore.getState();
    const resolveConvexId = async () => {
      if (isConvexId(sessionId)) return sessionId;
      return store.getConvexId(sessionId) ?? (await store.awaitConvexId(sessionId).catch(() => undefined));
    };
    if (isElectron()) {
      const submit = bridge("composeSubmit");
      // Enter → fire-and-forget: hide the popup + step out of the app now.
      if (!navigate) {
        // composeSubmit (hide popup + app.hide) only exists in builds that
        // shipped the compose bridge. On older desktop builds it's absent, so
        // fall back to paletteHide — otherwise the popup would just linger.
        if (submit) submit({ navigate: false });
        else bridge("paletteHide")?.();
        return;
      }
      // Cmd+Enter → send & open: hide the popup now, then switch Codecast onto
      // the new conversation once its real id resolves.
      bridge("paletteHide")?.();
      void resolveConvexId().then((convexId) => {
        if (submit) submit({ conversationId: convexId, navigate: true });
        else if (convexId) bridge("paletteNavigate")?.(`/conversation/${convexId}`);
      });
      return;
    }
    void resolveConvexId().then((convexId) => {
      if (convexId) router.push(`/conversation/${convexId}`);
    });
  }, [sessionId, router]);

  const conversation = sessionId
    ? ({ _id: sessionId, status: "active" } as unknown as ConversationData)
    : null;

  return (
    <div ref={rootRef} className="w-[600px] h-[460px] max-h-[88vh] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
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
          onDidSend={(info) => { if (navIntentRef.current) broadcastComposeOptimistic(info); }}
        />
      )}
      <div className="px-3 py-2 border-t border-sol-border/60 flex items-center justify-between text-[10px] text-sol-text-dim bg-sol-bg-alt/40 shrink-0">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5"><FooterKeys combo="enter" /> send</span>
          <span className="flex items-center gap-1.5"><FooterKeys combo="meta+enter" /> send &amp; open</span>
        </span>
        <span className="flex items-center gap-1.5"><FooterKeys combo="escape" /> close</span>
      </div>
    </div>
  );
}

// Render a key combo using the SAME boxed keycaps as the global keyboard
// shortcuts panel (KeyCap + formatShortcutParts), never ad-hoc font glyphs, so
// the footer hints match the rest of the app and pick up the keycap font.
function FooterKeys({ combo }: { combo: string }) {
  const parts = formatShortcutParts({ key: combo, action: "" as never, description: "" });
  return (
    <span className="inline-flex items-center gap-[3px]">
      {parts.map((part, i) => (
        <KeyCap key={i} size="xs">{part}</KeyCap>
      ))}
    </span>
  );
}

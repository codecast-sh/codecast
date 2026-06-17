import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMountEffect } from "../hooks/useMountEffect";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { NewSessionView, MessageInput, ConversationData } from "./ConversationView";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { formatShortcutParts } from "../shortcuts";
import { isElectron, bridge } from "../lib/desktop";
import { resolveSessionSkills } from "../lib/sessionSkills";
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
 *
 * Lifecycle (one contract, two hosts): opening seeds a DEFERRED local stub — no
 * server session yet. The first send COMMITS it (materialize); every other
 * dismissal ABANDONS it (abandonStub prunes the un-sent stub). The two hosts —
 * the in-app overlay (onClose set) and the standalone palette window (Electron) —
 * differ only in how they dismiss, never in this commit/abandon contract.
 */
export function ComposeView({ initialQuery, context, onClose }: { initialQuery?: string; context?: { projectPath?: string; gitRoot?: string }; onClose?: () => void }) {
  const router = useRouter();
  const { user: currentUser } = useCurrentUser();
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Project + agent captured when the blank session is created, so the popup's
  // slash menu resolves the SAME skills the in-app input would for this project.
  const [skillCtx, setSkillCtx] = useState<{ projectPath?: string; agentType?: string }>({});
  // The last submit's intent. For "send & open" (true) we broadcast the send so
  // the MAIN window paints the first message optimistically; fire-and-forget
  // (false) needs no cross-window bubble (the app isn't showing the conversation).
  const navIntentRef = useRef(false);
  // The session create is DEFERRED: opening the popup seeds only a local stub
  // (beginOptimisticSession deferCreate) so the popup can render and hold a draft
  // with no server conversation yet. materializeRef fires the real create on the
  // first send; sentRef records that it happened; stubIdRef is the stub itself.
  const materializeRef = useRef<(() => Promise<string>) | null>(null);
  const stubIdRef = useRef<string | null>(null);
  const sentRef = useRef(false);

  // A ComposeView instance owns ONE deferred stub and ends one of two ways:
  //   • committed — the first send fires materialize() and sets sentRef.
  //   • abandoned — abandonStub() prunes the un-sent, server-less stub (and plants
  //     an IDB exclude so it can't resurrect as a ghost "New session").
  // abandonStub is the SINGLE un-commit path, run from the only two moments the
  // popup disappears: unmount, and the palette window hiding while staying
  // mounted. Idempotent — pruneGhostSessions no-ops once the stub has been sent.
  const abandonStub = useCallback(() => {
    if (sentRef.current || !stubIdRef.current) return;
    useInboxStore.getState().pruneGhostSessions([stubIdRef.current]);
  }, []);

  // One fresh blank session per popup instance (PaletteRoot remounts via key).
  useMountEffect(() => {
    const store = useInboxStore.getState();
    const ctx = store.currentConversation;
    // A caller-supplied project (doc review passes the doc's own project) wins —
    // it's the explicit target. Otherwise inherit the current conversation, then
    // the most recent project. All can be empty, in which case the daemon starts
    // in $HOME and the null-state ProjectSwitcher lets the user pick before send.
    const path = context?.projectPath || context?.gitRoot || ctx.projectPath || ctx.gitRoot || store.recentProjects?.[0]?.path;
    const agentType = (ctx.agentType || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";

    // Shared optimistic-create path — see store.beginOptimisticSession.
    // deferCreate: opening the popup seeds ONLY a local stub (so the null-state
    // and message box can render + hold a draft); the server conversation isn't
    // created until materialize() fires on the first send. Escaping out therefore
    // strands nothing — no empty "New session" row, no pre-warmed agent, no sound.
    const { stubId: sid, materialize } = store.beginOptimisticSession({
      agentType,
      projectPath: path,
      gitRoot: path || undefined,
      deferCreate: true,
      create: (stubId) => store.createSession({
        agent_type: agentType,
        project_path: path,
        git_root: path || undefined,
        session_id: stubId,
      }),
    });
    materializeRef.current = materialize;
    stubIdRef.current = sid;

    if (initialQuery) store.setDraft(sid, { draft_message: initialQuery });
    setSessionId(sid);
    setSkillCtx({ projectPath: path || undefined, agentType });

    // Unmount (overlay close, or the palette window switching face / navigating
    // away) abandons the stub when it was never sent.
    return abandonStub;
  });

  // Same resolver the in-conversation input uses. available_skills rides on
  // currentUser, which the palette window now hydrates from IDB (see META_KEYS),
  // so project skills like mac-remote surface here too — not just built-ins.
  const skills = useMemo(() => resolveSessionSkills({
    availableSkills: (currentUser as any)?.available_skills,
    projectPath: skillCtx.projectPath,
    agentType: skillCtx.agentType,
  }), [currentUser, skillCtx.projectPath, skillCtx.agentType]);

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

  // Escape only DISMISSES the popup — abandoning the un-sent stub is NOT done here;
  // it falls out of the dismissal (the overlay unmounts → cleanup abandons; the
  // palette window hides → the visibilitychange effect below abandons). Listen in
  // the CAPTURE phase because MessageInput preventDefaults + stops Escape (its
  // 250ms double-tap-to-clear gesture), so a bubble-phase listener never sees it.
  useMountEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      // In-app overlay: the host owns dismissal. Standalone palette window: hide
      // the window (Electron) or step back in history (browser).
      if (onClose) { onClose(); return; }
      const hide = bridge("paletteHide");
      if (hide) hide();
      else router.back();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  });

  // The standalone palette WINDOW hides (Escape → paletteHide, or click-away →
  // main's win.on("blur") → hidePalette) WITHOUT unmounting, so the unmount
  // cleanup never runs. Abandon the un-sent stub the moment the window hides.
  // Keyed off the Page Visibility API (Electron maps win.hide() → document
  // hidden), not window blur: the reveal's app.focus({steal}) + window.focus() can
  // churn focus but never HIDES the window, so this can't abandon a fresh stub
  // mid-reveal. Electron + standalone only (no onClose): the overlay's host owns
  // dismissal, and a browser tab switch hides the tab without dismissing the popup.
  useMountEffect(() => {
    if (!isElectron() || onClose) return;
    const onHidden = () => { if (document.hidden) abandonStub(); };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  });

  // Dismiss the popup the instant the user submits — NEVER gate the hide on the
  // session create or the first-message send (both finish durably in the
  // background via the store's outbox). Resolving the real conversation id (the
  // create may still be in flight) only matters for navigation, so it runs after
  // the popup is already gone.
  const handleSubmit = useCallback((navigate: boolean) => {
    if (!sessionId) return;
    // First send → mark sent (so close-cleanup never prunes this row) and fire the
    // deferred server create. This runs a tick before MessageInput's own send
    // awaits awaitConvexId(sessionId), so the in-flight create is already tracked
    // when the send resolves the stub→real id. Idempotent (once-guarded in store).
    sentRef.current = true;
    materializeRef.current?.();
    navIntentRef.current = navigate;
    const store = useInboxStore.getState();
    const resolveConvexId = async () => {
      if (isConvexId(sessionId)) return sessionId;
      return store.getConvexId(sessionId) ?? (await store.awaitConvexId(sessionId).catch(() => undefined));
    };
    // In-app overlay: dismiss now (the session create + first send finish durably
    // in the background). "Send & open" then routes onto the new conversation once
    // its real id resolves; plain Enter leaves the user where they were.
    if (onClose) {
      onClose();
      if (navigate) void resolveConvexId().then((convexId) => { if (convexId) router.push(`/conversation/${convexId}`); });
      return;
    }
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
  }, [sessionId, router, onClose]);

  const conversation = sessionId
    ? ({ _id: sessionId, status: "active" } as unknown as ConversationData)
    : null;

  return (
    <div ref={rootRef} className="w-[94vw] h-[88vh] max-w-[960px] max-h-[680px] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
      <div className="flex-1 min-h-0 flex flex-col px-4 pt-6">
        {conversation && <NewSessionView conversation={conversation} />}
      </div>
      {conversation && (
        <MessageInput
          conversationId={conversation._id}
          status="active"
          embedded
          autoFocusInput
          skills={skills}
          agentType={skillCtx.agentType}
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

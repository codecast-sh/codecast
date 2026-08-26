import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useMountEffect } from "../hooks/useMountEffect";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useInboxStore, isConvexId, resolveComposeProjectPath, bucketProjectPath } from "../store/inboxStore";
import { NewSessionView, MessageInput, ConversationData } from "./ConversationView";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { formatShortcutParts } from "../shortcuts";
import { isElectron, bridge } from "../lib/desktop";
import { resolveSessionSkills } from "../lib/sessionSkills";
import { broadcastComposeOptimistic } from "../lib/composeBridge";
import { AGENT_LAUNCH_OPTIONS } from "@codecast/shared/contracts";
import type { DraftImageRow } from "../lib/draftImages";

// The draft content held for a compose stub, or null when there is none worth
// keeping. Read straight from the store — MessageInput persists text and pasted
// images (blob previews included) into drafts[id] synchronously as they change.
function draftContentFor(id: string | null): { text: string; images: DraftImageRow[] } | null {
  if (!id) return null;
  const d = useInboxStore.getState().drafts[id];
  const text = typeof d?.draft_message === "string" ? d.draft_message.trim() : "";
  const images = Array.isArray(d?.draft_image_storage_ids) ? (d.draft_image_storage_ids as DraftImageRow[]) : [];
  return text || images.length > 0 ? { text, images } : null;
}

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
export function ComposeView({ initialQuery, context, onClose, closeGuardRef }: { initialQuery?: string; context?: { projectPath?: string; gitRoot?: string }; onClose?: () => void; closeGuardRef?: React.MutableRefObject<(() => void) | null> }) {
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

  // A ComposeView instance owns ONE deferred stub and ends one of three ways:
  //   • committed — the first send fires materialize() and sets sentRef.
  //   • kept — the user chose "Keep draft" (or a dismissal we couldn't intercept
  //     happened over typed content): the stub stays, flagged _hasDraft, and
  //     renders as a draft new-session card in the inbox.
  //   • abandoned — abandonStub() prunes the un-sent, server-less stub (and plants
  //     an IDB exclude so it can't resurrect as a ghost "New session").
  // abandonStub is the SINGLE un-commit path, run from the only two moments the
  // popup disappears: unmount, and the palette window hiding while staying
  // mounted. Idempotent — pruneGhostSessions no-ops once the stub has been sent.
  const abandonStub = useCallback(() => {
    if (sentRef.current || !stubIdRef.current) return;
    // Typed content must survive dismissals that never passed through the
    // confirm dialog (host unmounted us, the palette window hid on blur):
    // auto-keep the draft instead of destroying it.
    if (draftContentFor(stubIdRef.current)) {
      useInboxStore.getState().setSessionHasDraft(stubIdRef.current, true);
      return;
    }
    useInboxStore.getState().pruneGhostSessions([stubIdRef.current]);
  }, []);

  // One fresh blank session per popup instance (PaletteRoot remounts via key).
  useMountEffect(() => {
    const store = useInboxStore.getState();
    const ctx = store.currentConversation;
    // Caller context > current conversation (unless a project-filter chip is
    // active and the conversation lives elsewhere) > filter chip > recent — see
    // resolveComposeProjectPath for the full rationale.
    const path = resolveComposeProjectPath({
      context,
      conversation: ctx,
      activeProjectFilter: store.activeProjectFilter,
      // A label chip nulls activeProjectPath; derive its directory instead.
      activeProjectPath: store.activeProjectPath ?? bucketProjectPath(store),
      chipFilterExclude: store.chipFilterExclude,
      recentProjects: store.recentProjects,
      machineRoster: store.machineRoster,
    });
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
      // Source project + agent from the LIVE stub at create time, NOT this
      // closure's mount-time `path`/`agentType`: the user may have switched
      // either in the null-state pickers before sending, and that switch (written
      // to the stub row) must be what we create with.
      create: (stubId) => store.createSessionFromStub(stubId, { agentType, projectPath: path, gitRoot: path || undefined }),
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

  // Dropped-image support, mirroring ConversationView's <main> drop zone. The
  // old "New Session" surface was a full-page blank conversation which had that
  // zone; without this the browser's default drop handling navigates to the
  // image file — nuking the popup and the draft. onDropFiles hands the files to
  // MessageInput's uploadImage, same as the in-conversation path.
  const dropFilesRef = useRef<((files: File[]) => void) | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    if (files.length > 0 && dropFilesRef.current) {
      dropFilesRef.current(files);
    } else if (files.length === 0 && e.dataTransfer.files.length > 0) {
      toast.error("Only image files are supported");
    }
  }, []);

  // --- guarded dismissal ----------------------------------------------------
  // Raw dismissal. In-app overlay: the host owns it. Standalone palette window:
  // hide the window (Electron) or step back in history (browser).
  const dismiss = useCallback(() => {
    if (onClose) { onClose(); return; }
    const hide = bridge("paletteHide");
    if (hide) hide();
    else router.back();
  }, [onClose, router]);

  // Draft guard: an explicit dismissal (Escape, backdrop click) over typed
  // content routes through a confirm dialog instead of silently dropping it.
  const [confirmClose, setConfirmClose] = useState(false);
  const confirmCloseRef = useRef(false);
  useEffect(() => { confirmCloseRef.current = confirmClose; }, [confirmClose]);
  // MessageInput reports when Escape belongs to UI inside it (lightbox, image /
  // queued-message selection, slash menu) — see escapeOwnedRef prop.
  const escapeOwnedRef = useRef(false);

  const refocusComposer = useCallback(() => {
    rootRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, []);

  const requestClose = useCallback(() => {
    if (!sentRef.current && draftContentFor(stubIdRef.current)) {
      setConfirmClose(true);
      return;
    }
    dismiss();
  }, [dismiss]);

  // Keep: the stub graduates from pre-warm infrastructure to deliberate state —
  // a draft new-session card in the inbox. sentRef blocks every abandon path.
  const keepDraftAndClose = useCallback(() => {
    const id = stubIdRef.current;
    if (id) {
      sentRef.current = true;
      useInboxStore.getState().setSessionHasDraft(id, true);
      toast.success("Draft saved to your inbox");
    }
    setConfirmClose(false);
    dismiss();
  }, [dismiss]);

  // Discard: clear the draft FIRST so the unmount abandon sees no content and
  // prunes the stub as usual.
  const discardDraftAndClose = useCallback(() => {
    const id = stubIdRef.current;
    if (id) useInboxStore.getState().clearDraft(id);
    setConfirmClose(false);
    dismiss();
  }, [dismiss]);

  // Hand the guarded close to the host so its backdrop click gets the same
  // draft confirm as Escape (the backdrop lives outside this component).
  useEffect(() => {
    if (!closeGuardRef) return;
    closeGuardRef.current = requestClose;
    return () => { closeGuardRef.current = null; };
  }, [closeGuardRef, requestClose]);

  // Escape DISMISSES the popup (via the draft guard) — abandoning the un-sent
  // stub is NOT done here; it falls out of the dismissal (the overlay unmounts →
  // cleanup abandons; the palette window hides → the visibilitychange effect
  // below abandons). Listen in the CAPTURE phase because MessageInput
  // preventDefaults + stops Escape (its 250ms double-tap-to-clear gesture), so a
  // bubble-phase listener never sees it. Capture also means we fire BEFORE the
  // inner UI's own Escape handling — so stand down whenever an inner layer owns
  // the key: the confirm dialog, the image lightbox/selection, the slash menu,
  // or a focused picker input (folder/label) that unwinds itself on Escape.
  useMountEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmCloseRef.current) {
        e.preventDefault();
        e.stopPropagation();
        setConfirmClose(false);
        refocusComposer();
        return;
      }
      if (escapeOwnedRef.current) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae.tagName === "INPUT" && rootRef.current?.contains(ae)) return;
      e.preventDefault();
      e.stopPropagation();
      requestClose();
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
    <div
      ref={rootRef}
      // aria-modal is what makes the global shortcut dispatcher stand down
      // (hasOpenModal) — without it, any keystroke after focus slips out of the
      // composer acts on the app BEHIND this dialog.
      role="dialog"
      aria-modal="true"
      // Clicking dead space inside the dialog must not blur the composer (a
      // blurred dialog leaks keyboard focus to the app). preventDefault on
      // mousedown keeps focus where it is; interactive targets keep native
      // focus behavior.
      onMouseDownCapture={(e) => {
        const t = e.target as HTMLElement;
        if (!t.closest("button, a, input, textarea, select, [contenteditable=true], [role=option]")) e.preventDefault();
      }}
      className="relative w-[94vw] h-[88vh] max-w-[960px] max-h-[680px] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
      onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-sol-bg/80 backdrop-blur-sm" style={{ animation: "fadeIn 150ms ease-out" }}>
          <div className="border-2 border-dashed border-sol-cyan rounded-xl p-12 text-center">
            <svg className="w-10 h-10 mx-auto mb-3 text-sol-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            <p className="text-sol-cyan text-sm font-medium">Drop images to attach</p>
          </div>
        </div>
      )}
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
          onDropFiles={dropFilesRef}
          onSubmitWithIntent={handleSubmit}
          onDidSend={(info) => { if (navIntentRef.current) broadcastComposeOptimistic(info); }}
          escapeOwnedRef={escapeOwnedRef}
        />
      )}
      {confirmClose && (
        <DiscardDraftConfirm
          stubId={stubIdRef.current}
          onKeep={keepDraftAndClose}
          onDiscard={discardDraftAndClose}
          onCancel={() => { setConfirmClose(false); refocusComposer(); }}
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

// The "keep or discard this draft?" confirm shown when a dismissal would drop
// typed content. Renders the draft itself as context — text snippet, pasted
// image thumbnails, target project + agent — so the decision is informed, not
// blind. Each button wears its own key: Enter (autofocused button) keeps, D
// discards; Escape and the backdrop cancel back into the draft.
function DiscardDraftConfirm({ stubId, onKeep, onDiscard, onCancel }: {
  stubId: string | null;
  onKeep: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  // Snapshot once on open — the composer is inert behind this dialog, so the
  // draft can't change while it shows.
  const { text, images, projectName, agentLabel } = useMemo(() => {
    const store = useInboxStore.getState();
    const content = draftContentFor(stubId);
    const row = stubId ? store.sessions[stubId] : undefined;
    return {
      text: content?.text ?? "",
      images: content?.images ?? [],
      projectName: (row?.project_path || row?.git_root)?.split("/").filter(Boolean).pop(),
      agentLabel: AGENT_LAUNCH_OPTIONS.find((a) => a.convexType === row?.agent_type)?.label,
    };
  }, [stubId]);

  // Capture phase, like the composer's Escape listener: MessageInput swallows
  // keys in the bubble phase, and the dialog owns the keyboard while it shows.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "d" && e.key !== "D") return;
      e.preventDefault();
      e.stopPropagation();
      onDiscard();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onDiscard]);

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); onCancel(); } }}
    >
      <div role="alertdialog" aria-modal="true" className="w-[26rem] max-w-[85%] rounded-xl border border-sol-border bg-sol-bg shadow-2xl p-4 animate-in fade-in-0 zoom-in-95 duration-150">
        <div className="text-sm font-medium text-sol-text mb-1">Keep this draft?</div>
        <div className="text-xs text-sol-text-dim mb-3">A kept draft stays in your inbox as a new session, ready to send later.</div>
        <div className="rounded-lg border border-sol-border/60 bg-sol-bg-alt/50 p-2.5 mb-3">
          {(projectName || agentLabel) && (
            <div className="text-[10px] text-sol-text-dim mb-1.5">
              {[projectName, agentLabel].filter(Boolean).join(" · ")}
            </div>
          )}
          {text && <div className="text-xs text-sol-text whitespace-pre-wrap break-words line-clamp-4">{text}</div>}
          {images.length > 0 && (
            <div className="flex items-center gap-1.5 mt-2">
              {images.slice(0, 5).map((img, i) => (
                img.previewUrl
                  ? <img key={i} src={img.previewUrl} alt="" className="h-10 w-10 rounded object-cover border border-sol-border/60" />
                  : <span key={i} className="h-10 w-10 rounded border border-sol-border/60 bg-sol-bg-alt" />
              ))}
              {images.length > 5 && <span className="text-[10px] text-sol-text-dim">+{images.length - 5}</span>}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onDiscard}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-sol-red/40 text-sol-red hover:bg-sol-red/10 transition-colors"
          >
            <KeyCap size="xs">d</KeyCap>
            Discard
          </button>
          <button
            autoFocus
            onClick={onKeep}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-sol-cyan text-white font-medium hover:bg-sol-cyan/90 transition-colors"
          >
            <FooterKeys combo="enter" />
            Keep draft
          </button>
        </div>
        <div className="mt-2.5 flex items-center justify-end gap-3 text-[10px] text-sol-text-dim">
          <span className="flex items-center gap-1.5"><FooterKeys combo="escape" /> back to draft</span>
        </div>
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

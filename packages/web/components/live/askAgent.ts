// The Ask agent logic behind AskAgentControl: per-surface drafts, the start
// confirm's state, sending an ask, picking its target, and the page's Ask claim.
import { createContext, useCallback, useContext, useRef, useState, useSyncExternalStore } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { askAgentBrief, type ArtifactElement, type ArtifactOp, type ArtifactType } from "@codecast/shared/artifacts";
import { sendLiveOps } from "./useLiveArtifact";
import { useInboxStore } from "../../store/inboxStore";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import { cleanTitle } from "../../lib/conversationProcessor";
import type { SwitchLedger } from "../consequential/ConsequentialSwitch";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export type AskDoc = { _id: string; title: string; doc_type: ArtifactType; project_path?: string; git_root?: string };

export type AskRequest = {
  /** The Ask surface the words came from (useAskDraft): its draft clears once the ask goes out, and survives a cancel. */
  slot?: string;
  prompt: string;
  selected?: ArtifactElement[];
  comment_key?: string;
  draft?: boolean;
};

export type AskTarget = { kind: "new" } | { kind: "session"; id: string; title?: string };

// What a person has typed into an Ask surface, per artifact and surface, held
// outside the component: a surface may close while the start confirm is open
// (a board's prompt, a sheet's ask bar). The words go only when the ask
// actually goes out; a cancelled start keeps them and asks the surface to
// open again with them in place.
type AskDraft = { text: string; reopen: number };
const askDrafts = new Map<string, AskDraft>();
const draftListeners = new Set<() => void>();
const draftKey = (docId: string, slot: string) => `${docId}|${slot}`;
const EMPTY_DRAFT: AskDraft = { text: "", reopen: 0 };
function writeDraft(key: string, next: AskDraft) {
  if (!next.text && !next.reopen) askDrafts.delete(key);
  else askDrafts.set(key, next);
  for (const fn of draftListeners) fn();
}

/**
 * An Ask surface's text, kept across closing and a cancelled start.
 * `onReopen` runs when a start from this surface was cancelled: open it again.
 */
export function useAskDraft(docId: string, slot: string, onReopen?: () => void): { text: string; setText: (t: string) => void } {
  const key = draftKey(docId, slot);
  const draft = useSyncExternalStore(
    useCallback((fn: () => void) => { draftListeners.add(fn); return () => { draftListeners.delete(fn); }; }, []),
    () => askDrafts.get(key) ?? EMPTY_DRAFT,
    () => EMPTY_DRAFT,
  );
  const setText = useCallback((text: string) => writeDraft(key, { ...(askDrafts.get(key) ?? EMPTY_DRAFT), text }), [key]);
  // Only a cancel after this surface mounted reopens it.
  const seen = useRef(draft.reopen);
  const reopenRef = useRef(onReopen);
  reopenRef.current = onReopen;
  useWatchEffect(() => {
    if (draft.reopen === seen.current) return;
    seen.current = draft.reopen;
    reopenRef.current?.();
  }, [draft.reopen]);
  return { text: draft.text, setText };
}

function settleDraft(doc: AskDoc, slot: string | undefined, sent: boolean) {
  if (!slot) return;
  const key = draftKey(doc._id, slot);
  const cur = askDrafts.get(key) ?? EMPTY_DRAFT;
  writeDraft(key, sent ? { text: "", reopen: cur.reopen } : { ...cur, reopen: cur.reopen + 1 });
}

// Starting an agent goes through the shared confirm (components/consequential):
// what starts, where, with what, and how to stop it. The review is mounted once
// by the page (AskConfirmHost); sendAsk opens it and waits for the answer.
type PendingConfirm = { ledger: SwitchLedger; resolve: (ok: boolean) => void };
let pendingConfirm: PendingConfirm | null = null;
const confirmListeners = new Set<() => void>();
function setPendingConfirm(next: PendingConfirm | null) {
  pendingConfirm = next;
  for (const fn of confirmListeners) fn();
}
function confirmStart(ledger: SwitchLedger): Promise<boolean> {
  pendingConfirm?.resolve(false);
  return new Promise((resolve) => setPendingConfirm({ ledger, resolve }));
}

/** The confirm review's state, read by AskConfirmHost. */
export function useAskConfirm(): { pending: PendingConfirm | null; done: (ok: boolean) => void } {
  const pending = useSyncExternalStore(
    useCallback((fn: () => void) => { confirmListeners.add(fn); return () => { confirmListeners.delete(fn); }; }, []),
    () => pendingConfirm,
    () => null,
  );
  const done = useCallback((ok: boolean) => {
    if (!pending) return;
    setPendingConfirm(null);
    pending.resolve(ok);
  }, [pending]);
  return { pending, done };
}

function startLedger(doc: AskDoc, req: AskRequest, projectPath: string): SwitchLedger {
  const words = req.prompt.trim().replace(/\s+/g, " ");
  return {
    name: "Start an agent",
    subject: projectPath,
    shift: null,
    figures: [{ value: "1", label: "new session" }],
    rows: [
      { k: "Asked", v: words.length > 90 ? `${words.slice(0, 89)}…` : words },
      { k: "Edits", v: doc.title },
      ...(req.selected?.length ? [{ k: "Selected", v: String(req.selected.length) }] : []),
      ...(req.draft ? [{ k: "Writes to", v: "a draft you save or discard" }] : []),
    ],
    stop: "Stop it from its session",
    confirm: "Start agent",
    keep: "Cancel",
  };
}

/**
 * Send an ask to a live session (at once) or to a new agent (after the start
 * confirm). Resolves to the session's id, or null when the person cancelled or
 * the new-session composer took over (no project known).
 */
export async function sendAsk(doc: AskDoc, req: AskRequest, target: AskTarget): Promise<string | null> {
  const url = `${window.location.origin}/docs/${doc._id}`;
  // Every ask is a comment thread: the agent replies there when done, which
  // notifies the asker and marks the thread answered. A comment sent to an
  // agent is its own thread already.
  const thread = req.comment_key ?? `cm_${nanoid(10)}`;
  const brief = askAgentBrief({ prompt: req.prompt, doc, url, selected: req.selected, comment_key: thread, draft: req.draft });
  const store = useInboxStore.getState() as any;
  const record = (sentTo: string) => {
    const ops: ArtifactOp[] = req.comment_key
      ? [{ k: thread, set: { sent_to: sentTo } }]
      : [{ k: thread, put: { kind: "comment", text: req.prompt.trim(), created_at: Date.now(), sent_to: sentTo, ...(req.selected?.[0] ? { anchor: req.selected[0].key } : {}) } }];
    sendLiveOps(doc._id, "comments", ops);
  };
  if (target.kind === "session") {
    store.sendMessage(target.id, brief, undefined, nanoid(10));
    record(target.id);
    toast.success(`Sent to ${cleanTitle(target.title || "session")}`);
    settleDraft(doc, req.slot, true);
    return target.id;
  }
  const projectPath = doc.project_path || doc.git_root;
  if (!projectPath) {
    // The composer is its own review: the person picks the project and presses send. The words moved there.
    // The thread shows it is with an agent; the agent's reply names which (liveComments rebinds "compose").
    store.openCompose(brief, {});
    record("compose");
    settleDraft(doc, req.slot, true);
    return null;
  }
  if (!(await confirmStart(startLedger(doc, req, projectPath)))) {
    settleDraft(doc, req.slot, false);
    return null;
  }
  const { stubId } = spawnSessionWithPrompt({ prompt: brief, projectPath, failureLabel: "Failed to start the agent" });
  record(stubId);
  // The stub becomes a real session: the thread points at that one, so its link opens it.
  void store.awaitConvexId(stubId).then((real: string) => {
    if (real && real !== stubId) sendLiveOps(doc._id, "comments", [{ k: thread, set: { sent_to: real } }]);
  }).catch(() => {});
  toast.success("Agent started");
  settleDraft(doc, req.slot, true);
  return stubId;
}

/** A surface closed for a session pick that was then dismissed: ask it to open again with its words. */
export function reopenAsk(doc: AskDoc, slot: string) {
  settleDraft(doc, slot, false);
}

/** Open the session picker for an ask. `onCancel` runs when the palette closes without a pick. */
export function pickAskTarget(title: string, onPick: (t: AskTarget) => void, onCancel?: () => void) {
  let settled = false;
  const pick = {
    title,
    kinds: ["session"],
    extras: [{ key: "new", label: "New agent", description: "Start a session in this project", icon: "sparkles" as const, primary: true }],
    onPick: (t: any) => {
      settled = true;
      if (t.kind === "session") onPick({ kind: "session", id: t.id, title: t.label });
      else onPick({ kind: "new" });
    },
  };
  (useInboxStore.getState() as any).openPalette({ pick });
  if (!onCancel) return;
  const unsub = useInboxStore.subscribe((st: any) => {
    if (st.palette?.open && st.palette?.pick === pick) return;
    unsub();
    if (!settled) onCancel();
  });
}

// One Ask agent per page, and it acts on the selection. A product whose own
// toolbar holds Ask (a board, a sheet) renders AskButton there; while one is
// mounted the shell's header button steps aside. A product without one keeps
// the header's. Every Ask looks the same because every one is this button.
type AskClaim = { claim: () => () => void };
const AskClaimContext = createContext<AskClaim | null>(null);

/**
 * The shell's side: whether a product's own Ask is on screen now, and the
 * value its view's provider carries. A claim lasts while the component that
 * made it is mounted (a toolbar, an empty state's prompt).
 */
export function useAskClaims(): { claimed: boolean; value: AskClaim } {
  const [count, setCount] = useState(0);
  const value = useRef<AskClaim>({
    claim: () => {
      setCount((n) => n + 1);
      return () => setCount((n) => n - 1);
    },
  }).current;
  return { claimed: count > 0, value };
}
export const AskClaimProvider = AskClaimContext.Provider;

export const ASK_BUTTON_CLASS =
  "inline-flex shrink-0 items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium whitespace-nowrap bg-sol-violet/15 text-sol-violet hover:bg-sol-violet/25 transition-colors";

/** A product surface that hosts Ask (a toolbar, an empty state's prompt) calls this; while it is mounted the header shows none. */
export function useClaimAsk() {
  const ctx = useContext(AskClaimContext);
  useWatchEffect(() => ctx?.claim(), [ctx]);
}


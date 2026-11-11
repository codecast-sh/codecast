// Ask an agent to work on a live artifact. One control for every product:
// the shell's top-bar button, a product's "Describe a change" on a selection,
// and a comment's "Send to agent" all end here.
//
// Routing reuses the existing paths. A live session gets an ordinary message
// through the store's sendMessage. A new agent starts in the artifact's project
// through spawnSessionWithPrompt. With no project known, the new-session
// composer opens pre-filled so the person picks where it runs. The brief
// (shared askAgentBrief) tells the agent the exact `cast <cli>` verbs to read
// and write the artifact; its writes then show up live with its own cursor.
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Bot, Send } from "lucide-react";
import { askAgentBrief, type ArtifactElement, type ArtifactType } from "@codecast/shared/artifacts";
import { useInboxStore } from "../../store/inboxStore";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import { cleanTitle } from "../../lib/conversationProcessor";
import { KeyCap } from "../KeyCap";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { isMac } from "../../shortcuts/registry";

export type AskDoc = { _id: string; title: string; doc_type: ArtifactType; project_path?: string; git_root?: string };

export type AskRequest = {
  /** The Ask surface the words came from (useAskDraft): its draft clears once the ask goes out, and survives a cancel. */
  slot?: string;
  prompt: string;
  selected?: ArtifactElement[];
  comment_key?: string;
  draft?: boolean;
};

type AskTarget = { kind: "new" } | { kind: "session"; id: string; title?: string };

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
  useEffect(() => {
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

/** Mount once where asks can start agents (the artifact page): the confirm review. */
export function AskConfirmHost() {
  const pending = useSyncExternalStore(
    useCallback((fn: () => void) => { confirmListeners.add(fn); return () => { confirmListeners.delete(fn); }; }, []),
    () => pendingConfirm,
    () => null,
  );
  if (!pending) return null;
  const done = (ok: boolean) => { setPendingConfirm(null); pending.resolve(ok); };
  return <SwitchReview ledger={pending.ledger} onClose={() => done(false)} onConfirm={() => done(true)} />;
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
  const brief = askAgentBrief({ prompt: req.prompt, doc, url, selected: req.selected, comment_key: req.comment_key, draft: req.draft });
  const store = useInboxStore.getState() as any;
  if (target.kind === "session") {
    store.sendMessage(target.id, brief, undefined, nanoid(10));
    toast.success(`Sent to ${cleanTitle(target.title || "session")}`);
    settleDraft(doc, req.slot, true);
    return target.id;
  }
  const projectPath = doc.project_path || doc.git_root;
  if (!projectPath) {
    // The composer is its own review: the person picks the project and presses send. The words moved there.
    store.openCompose(brief, {});
    settleDraft(doc, req.slot, true);
    return null;
  }
  if (!(await confirmStart(startLedger(doc, req, projectPath)))) {
    settleDraft(doc, req.slot, false);
    return null;
  }
  const { stubId } = spawnSessionWithPrompt({ prompt: brief, projectPath, failureLabel: "Failed to start the agent" });
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
  useEffect(() => ctx?.claim(), [ctx]);
}

/** The Ask agent button. In a product toolbar it claims the page's Ask, so the header shows none. */
export function AskButton({ label = "Ask agent", className, ...rest }: { label?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  useClaimAsk();
  return (
    <button type="button" data-live-ask-button className={`${ASK_BUTTON_CLASS}${className ? ` ${className}` : ""}`} {...rest}>
      <Bot className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

/**
 * The Ask agent button with its inline prompt. `selected` is what the person
 * has selected now; the agent receives it with the request.
 */
export function AskAgentControl({
  doc,
  selected,
  draftDefault = false,
  label = "Ask agent",
  onSent,
}: {
  doc: AskDoc;
  selected: ArtifactElement[];
  draftDefault?: boolean;
  label?: string;
  onSent?: (sessionId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { text: prompt, setText: setPrompt } = useAskDraft(doc._id, "header", () => setOpen(true));
  const [draft, setDraft] = useState(draftDefault);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const submit = useCallback(async (target: AskTarget) => {
    if (!prompt.trim()) return;
    setOpen(false);
    const id = await sendAsk(doc, { slot: "header", prompt, selected, draft }, target);
    onSent?.(id);
  }, [doc, prompt, selected, draft, onSent]);

  const choose = useCallback(() => {
    if (!prompt.trim()) return;
    setOpen(false);
    pickAskTarget("Ask which agent?", submit, () => setOpen(true));
  }, [prompt, submit]);

  return (
    <div className="relative" ref={boxRef}>
      <button type="button" data-live-ask onClick={() => setOpen((o) => !o)} className={ASK_BUTTON_CLASS}>
        <Bot className="w-3.5 h-3.5" />
        {label}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-[360px] rounded-lg border border-sol-border/60 bg-sol-bg shadow-xl p-2.5">
          <textarea
            ref={inputRef}
            data-live-ask-input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); choose(); }
              else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit({ kind: "new" }); }
            }}
            rows={3}
            placeholder={selected.length ? `What should change in the ${selected.length} selected?` : "What should the agent do?"}
            className="w-full resize-none bg-sol-bg-alt rounded-md px-2.5 py-2 text-sm text-sol-text placeholder:text-sol-text-dim outline-none border border-sol-border/40 focus:border-sol-violet/50"
          />
          <div className="mt-2 flex items-center gap-2">
            {selected.length > 0 && <span className="text-meta text-sol-text-dim">{selected.length} selected</span>}
            <label className="inline-flex items-center gap-1.5 text-meta text-sol-text-muted cursor-pointer select-none">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} className="accent-[var(--sol-violet)]" />
              As draft
            </label>
            <span className="flex-1" />
            <button
              type="button"
              disabled={!prompt.trim()}
              onClick={choose}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs text-sol-text-muted hover:bg-sol-bg-alt disabled:opacity-40"
              title="Send to a running session"
            >
              Session… <KeyCap>{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap>↵</KeyCap>
            </button>
            <button
              type="button"
              data-live-ask-new
              disabled={!prompt.trim()}
              onClick={() => submit({ kind: "new" })}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium bg-sol-violet text-sol-bg hover:opacity-90 disabled:opacity-40"
            >
              <Send className="w-3 h-3" /> New agent <KeyCap>↵</KeyCap>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

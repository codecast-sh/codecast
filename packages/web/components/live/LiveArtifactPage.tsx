// The page of a live artifact (a board, sheet or dashboard), at /docs/<id>.
// The shell every product shares: the title, who is here (people and agent
// sessions), Ask agent, comments, history, the draft bar, Share, and every
// cursor. The product's view (components/live/registry.ts) fills the body and
// says where positions are on screen.
import { Suspense, useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRouter, useSearchParams } from "next/navigation";
import { Archive, Check, Copy, Download, Link2, Lock, Maximize2, Minimize2, Plus, RotateCcw, Upload, Users, History, MessageSquare, MoreHorizontal, Redo2, Undo2, X } from "lucide-react";
import { artifactSpec, type ArtifactElement, type ArtifactPosition, type ArtifactType } from "@codecast/shared/artifacts";
import { useInboxStore } from "../../store/inboxStore";
import { ShareControl } from "../ShareControl";
import { policyTeamOf } from "@codecast/shared/contracts";
import { PresenceFacepile, type PresenceFace } from "../PresenceFacepile";
import { AppLoader } from "../AppLoader";
import { ErrorBoundary } from "../ErrorBoundary";
import { KeyCap } from "../KeyCap";
import { isMac } from "../../shortcuts/registry";
import { docTypeStyle } from "../../lib/docTypeStyle";
import { DocTypeMark } from "../docs/DocTypeMark";
import "./live.css";
import { useLiveArtifact, useLiveVersions, useLiveDraftState, useLiveElements, useLivePresence, useLiveRefusal, useLiveRestoring, useLiveUnsettled } from "./useLiveArtifact";
import { useWsConnected } from "../../hooks/useWsConnected";
import { useShortcuts } from "../../shortcuts";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { sharePageUrl } from "../../lib/utils";
import { LiveCursors } from "./LiveCursors";
import { AskAgentControl, AskConfirmHost } from "./AskAgentControl";
import { AskClaimProvider, useAskClaims } from "./askAgent";
import { CommentsPanel, HistoryPanel } from "./LiveSidePanels";
import { LIVE_VIEWS, MINIMAL_VIEWS, type LiveExport, type LiveImport, type ScreenPoint } from "./registry";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { duplicateLiveArtifact } from "../../lib/createLiveArtifact";
import { Button } from "../ui/button";
import { toast } from "sonner";

type PanelKind = "comments" | "history" | "product" | null;
const EMPTY: ArtifactElement[] = [];

type ScreenMapFn = (pos: ArtifactPosition) => ScreenPoint | null;

/** A tiny store for the product's position mapping, read by the cursor layer alone. */
function createScreenMap() {
  let current: ScreenMapFn | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (map: ScreenMapFn) => {
      current = map;
      for (const fn of listeners) fn();
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

function CursorLayer({ others, screenMap }: { others: ReturnType<typeof useLivePresence>; screenMap: ReturnType<typeof createScreenMap> }) {
  const map = useSyncExternalStore(screenMap.subscribe, screenMap.get, () => null);
  return <LiveCursors others={others} toScreen={map} />;
}

export function LiveArtifactPage({ doc }: { doc: { _id: string; title: string; doc_type: ArtifactType; project_path?: string; git_root?: string } }) {
  const router = useRouter();
  const params = useSearchParams();
  const live = useLiveArtifact(doc._id);
  const others = useLivePresence(doc._id);
  const elements = useLiveElements(doc._id);
  const spec = artifactSpec(doc.doc_type);
  const minimal = params.get("view") === "minimal";
  const View = (minimal ? MINIMAL_VIEWS : LIVE_VIEWS)[doc.doc_type];
  const askClaims = useAskClaims();
  // In zen the header is the window's top row: it clears the zen corner (and is the desktop drag region).
  const titlebarHead = useTitlebarHead<HTMLElement>();

  const [selection, setSelectionState] = useState<string[]>(() => (params.get("el") ? [params.get("el")!] : []));
  const [panel, setPanelKind] = useState<PanelKind>(() => (params.get("v") ? "history" : params.get("c") ? "comments" : null));
  const [productPanel, setProductPanel] = useState<ReactNode | null>(null);
  const [toolbar, setToolbar] = useState<ReactNode>(null);
  const [exports, setExports] = useState<LiveExport[] | null>(null);
  const [fileImport, setImport] = useState<LiveImport | null>(null);
  const [typeLabel, setTypeLabel] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // A new comment a product asked for (openComments): where it anchors, and a tick that refocuses the box.
  const [commentAsk, setCommentAsk] = useState<{ anchor?: string; tick: number } | null>(null);
  const openComments = useCallback((opts?: { anchor?: string; thread?: string }) => {
    setPanelKind("comments");
    if (opts?.thread) {
      setFocusComment(opts.thread);
      setCommentAsk(null);
    } else {
      setCommentAsk((c) => ({ anchor: opts?.anchor, tick: (c?.tick ?? 0) + 1 }));
    }
  }, []);
  // ?c=<thread> (a notification, a copied comment link) opens that thread.
  const [focusComment, setFocusComment] = useState<string | null>(() => params.get("c"));
  const linkedComment = params.get("c");
  useWatchEffect(() => {
    if (!linkedComment) return;
    setFocusComment(linkedComment);
    setPanelKind("comments");
  }, [linkedComment]);
  // The product's position mapping. Held outside React state: a pan republishes
  // it several times a second, and only the cursor layer redraws for it.
  const screenMap = useRef(createScreenMap()).current;

  // An open version (?v=<rev>) renders read-only from its folded state.
  const openRev = params.get("v") ? Number(params.get("v")) : null;
  const [snapshot, setSnapshot] = useState<ArtifactElement[] | undefined>(undefined);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const [snapshotTry, setSnapshotTry] = useState(0);
  useWatchEffect(() => {
    let alive = true;
    setSnapshot(undefined);
    setSnapshotFailed(false);
    if (openRev === null || Number.isNaN(openRev)) return;
    live.history.preview(openRev).then((els) => { if (alive) setSnapshot(els); }).catch(() => { if (alive) setSnapshotFailed(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handle's preview is stable per doc
  }, [openRev, doc._id, snapshotTry]);

  const setParam = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    const q = next.toString();
    router.replace(`/docs/${doc._id}${q ? `?${q}` : ""}`, { scroll: false });
  }, [params, router, doc._id]);

  const setSelection = useCallback((keys: string[]) => {
    setSelectionState(keys);
    setCommentAsk(null);
    live.setPresence({ selection: keys, position: keys.length ? { key: keys[keys.length - 1] } : undefined });
  }, [live]);

  const toScreen = screenMap.set;

  const setPanel = useCallback((node: ReactNode | null) => {
    setProductPanel(node);
    setPanelKind(node ? "product" : (k) => (k === "product" ? null : k));
  }, []);

  const togglePanel = (k: PanelKind) => {
    setPanelKind((cur) => (cur === k ? null : k));
    // A thread in the address belongs to the comments panel showing it.
    if (params.get("c") && !(k === "comments" && panel !== "comments")) setParam("c", null);
  };

  const selected = useMemo(() => {
    const keys = new Set(selection);
    return elements.filter((e) => keys.has(e.key));
  }, [elements, selection]);

  // ⌘Z / ⇧⌘Z when focus is not in a text field.
  useWatchEffect(() => {
    // An open version is read only: nothing to undo into, and Esc goes back to the current state.
    if (openRev !== null) {
      const onEsc = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        // Ahead of the app's own Esc, which would close the page.
        e.preventDefault();
        e.stopImmediatePropagation();
        setParam("v", null);
      };
      window.addEventListener("keydown", onEsc, true);
      return () => window.removeEventListener("keydown", onEsc, true);
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      if (e.shiftKey) live.redo();
      else live.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, openRev, setParam]);

  const faces: PresenceFace[] = useMemo(() => {
    const seen = new Set<string>();
    const out: PresenceFace[] = [];
    for (const p of others) {
      const id = p.kind === "agent" ? p.actor : p.actor.split(":").slice(0, 2).join(":");
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ user_id: id, user_name: p.kind === "agent" ? `${p.name} (agent)` : p.name, user_color: p.color, user_image: p.image });
    }
    return out;
  }, [others]);

  // The view element only changes when its own props do: presence, the
  // facepile, panels and the cursor mapping re-render the shell, not the view.
  // An archived artifact refuses every write: it opens read only until restored.
  const archived = !!(doc as any).archived_at;
  // Who may change it (the head's edit setting); until the feed says, assume they may.
  const canEdit = useInboxStore((s: any) => s.liveHeads?.[doc._id]?.can_edit !== false);
  const mode = openRev !== null || archived || !canEdit ? "view" : "edit";
  const viewSnapshot = openRev !== null ? snapshot ?? EMPTY : undefined;
  const view = useMemo(
    () => (
      <View
        doc={doc}
        live={live}
        selection={selection}
        setSelection={setSelection}
        mode={mode}
        snapshot={viewSnapshot}
        toScreen={toScreen}
        setToolbar={setToolbar}
        setPanel={setPanel}
        setExports={setExports}
        setImport={setImport}
        openComments={openComments}
        setTypeLabel={setTypeLabel}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doc fields named explicitly
    [View, doc._id, doc.title, doc.doc_type, doc.project_path, doc.git_root, live, selection, setSelection, mode, viewSnapshot, toScreen, setPanel, openComments],
  );

  const draftCount = useLiveElements(doc._id, { layer: "draft" }).length;
  // Share carries the view a person chose (a dashboard's filters, a sheet's tab), never where they happen to be:
  // an open comment, a version, a selected element.
  const shareQuery = useMemo(() => {
    const q = new URLSearchParams(params.toString());
    for (const k of ["c", "v", "el"]) q.delete(k);
    return q.toString();
  }, [params]);
  const openVersion = useLiveVersions(doc._id).find((v) => v.rev === openRev);
  const draftLabel = useLiveDraftState(doc._id)?.label;
  const commentCount = useLiveElements(doc._id, { layer: "comments" }).filter((c) => !c.parent && !c.resolved).length;
  const typeStyle = docTypeStyle(doc.doc_type);
  const mod = isMac ? "⌘" : "Ctrl";

  return (
    <div className="h-full min-w-0 flex flex-col bg-sol-bg" data-live-page={doc.doc_type}>
      <AskConfirmHost />
      <header ref={titlebarHead} className="live-head flex items-center gap-2 px-3 h-11 border-b border-sol-border/40 shrink-0">
        <DocTypeMark type={doc.doc_type} size={15} title={spec.label} />
        <TitleInput docId={doc._id} title={doc.title} placeholder={`Untitled ${spec.label.toLowerCase()}`} readOnly={mode === "view"} />
        <span data-live-type-label className={`text-meta shrink-0 ${typeStyle.color}`}>{typeLabel ?? spec.label}</span>
        {mode === "edit" && <SyncState docId={doc._id} />}
        {/* The product's controls take the room left between the title and the
            shell's own, and clip past it: the shell's buttons always stay reachable. */}
        <div data-live-toolbar className="flex-1 min-w-0 flex items-center justify-end gap-2 overflow-hidden">{toolbar}</div>
        {faces.length > 0 && <span data-live-facepile className="shrink-0"><PresenceFacepile present={faces} size={22} max={5} /></span>}
        {!askClaims.claimed && mode === "edit" && <span className="shrink-0"><AskAgentControl doc={doc} selected={selected} /></span>}
        <IconToggle on={panel === "comments"} title="Comments" onClick={() => togglePanel("comments")} badge={commentCount}>
          <MessageSquare className="w-4 h-4" />
        </IconToggle>
        <IconToggle on={panel === "history"} title="History" onClick={() => togglePanel("history")}>
          <History className="w-4 h-4" />
        </IconToggle>
        <EditAccess doc={doc as any} canEdit={canEdit} />
        <FocusToggle />
        <ArtifactMenu doc={doc as any} canEdit={canEdit && !archived} ready={live.ready} exports={exports} fileImport={mode === "edit" ? fileImport : null} selection={selection} />
        <ShareControl className="shrink-0" label={spec.label.toLowerCase()} path={`/docs/${doc._id}${shareQuery ? `?${shareQuery}` : ""}`} publicShare={{ kind: "doc", id: doc._id, token: (doc as any).share_token, team: policyTeamOf("docs", doc as any) }} />
      </header>

      {live.draft.active && openRev === null && (
        <div className="flex items-center gap-2 px-3 h-9 border-b border-sol-violet/30 bg-sol-violet/10 shrink-0" data-live-draft-bar>
          <span className="text-xs font-medium text-sol-violet">Draft</span>
          <span className="text-meta text-sol-text-muted truncate">{live.draft.by_name} · editors only until saved</span>
          <span className="flex-1" />
          <button type="button" title={`Undo (${mod}Z)`} disabled={!live.canUndo} onClick={live.undo} className="p-1 rounded text-sol-text-muted hover:text-sol-text disabled:opacity-30"><Undo2 className="w-3.5 h-3.5" /></button>
          <button type="button" title={`Redo (${mod}⇧Z)`} disabled={!live.canRedo} onClick={live.redo} className="p-1 rounded text-sol-text-muted hover:text-sol-text disabled:opacity-30"><Redo2 className="w-3.5 h-3.5" /></button>
          <button type="button" data-live-draft-discard onClick={() => setDiscarding(true)} className="inline-flex items-center gap-1 h-6 px-2 rounded text-xs text-sol-text-muted hover:text-sol-red hover:bg-sol-red/10"><X className="w-3 h-3" /> Discard</button>
          <Button type="button" variant="violet" size="xs" data-live-draft-save onClick={live.draft.save} className="h-6">Save</Button>
        </div>
      )}
      {discarding && (
        <SwitchReview
          ledger={{
            name: "Discard draft",
            subject: [draftLabel, live.draft.by_name].filter(Boolean).join(" · ") || "Draft",
            shift: null,
            alert: "Can't be undone",
            figures: [{ value: String(draftCount), label: draftCount === 1 ? "changed element" : "changed elements" }],
            rows: [{ k: "Saved layer", v: "Stays as it is" }],
            confirm: "Discard draft",
            keep: "Keep draft",
          }}
          onClose={() => setDiscarding(false)}
          onConfirm={() => { setDiscarding(false); live.draft.discard(); }}
        />
      )}
      {openRev === null && <RestoreStoppedBar live={live} />}
      {archived && openRev === null && (
        <div className="flex items-center gap-2 px-3 h-9 border-b border-sol-border/40 bg-sol-bg-alt shrink-0" data-live-archived>
          <span className="text-xs font-medium text-sol-text">Archived</span>
          <span className="text-meta text-sol-text-muted">read only</span>
          <span className="flex-1" />
          <Button type="button" variant="outline" size="xs" className="h-6" onClick={() => (useInboxStore.getState() as any).restoreArchivedDoc(doc._id)}>Restore</Button>
        </div>
      )}
      {openRev !== null && (
        <div className="flex items-center gap-2 px-3 h-9 border-b border-sol-blue/30 bg-sol-blue/10 shrink-0" data-live-version-bar>
          <span className="text-xs font-medium text-sol-blue truncate">{openVersion?.label ?? "Version"}</span>
          <span className="text-meta text-sol-text-muted shrink-0">read only</span>
          <span className="flex-1" />
          <button type="button" onClick={() => setParam("v", null)} className="h-6 px-2 rounded text-xs text-sol-text-muted hover:text-sol-text shrink-0">Back to current <KeyCap>Esc</KeyCap></button>
          {!archived && canEdit ? (
            <Button
              type="button"
              variant="blue"
              size="xs"
              data-live-restore={openRev}
              disabled={restoring || snapshot === undefined}
              className="h-6 shrink-0"
              onClick={async () => {
                setRestoring(true);
                try {
                  const r = await live.history.restore(openRev);
                  setParam("v", null);
                  toast.success(r.changed ? `Restored: ${r.changed} element${r.changed === 1 ? "" : "s"} changed` : "Already matches this version");
                } catch (e: any) {
                  toast.error(typeof e?.data === "string" ? e.data : "The restore did not finish");
                } finally {
                  setRestoring(false);
                }
              }}
            >
              <RotateCcw className="w-3 h-3" /> {restoring ? "Restoring…" : "Restore this version"}
            </Button>
          ) : null}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="relative flex-1 min-w-0" data-live-body>
          <ErrorBoundary name={`LiveView:${doc.doc_type}`} level="panel">
            <AskClaimProvider value={askClaims.value}>
              <Suspense fallback={<AppLoader className="h-full" />}>
                {openRev !== null && snapshotFailed ? (
                  <div className="h-full flex items-center justify-center gap-2 text-sm text-sol-text-muted" data-live-version-failed>
                    Version r{openRev} did not load
                    <button type="button" onClick={() => setSnapshotTry((n) => n + 1)} className="h-7 px-2.5 rounded-md text-xs text-sol-text hover:bg-sol-bg-alt border border-sol-border/50">Retry</button>
                  </div>
                ) : openRev !== null && snapshot === undefined ? <AppLoader className="h-full" /> : view}
              </Suspense>
            </AskClaimProvider>
          </ErrorBoundary>
          {openRev === null && <CursorLayer others={others} screenMap={screenMap} />}
        </div>
        {panel && (
          <aside className="live-panel w-[300px] shrink-0 overflow-hidden flex flex-col border-l border-sol-border/40 bg-sol-bg min-h-0" data-live-panel={panel}>
            {panel === "comments" && (
              <CommentsPanel
                doc={doc as any}
                live={live}
                selection={commentAsk?.anchor ? [commentAsk.anchor] : selection}
                composeTick={commentAsk?.tick}
                selectedElements={selected}
                focusKey={focusComment}
                // A viewer still comments; an open version or an archived artifact takes none.
                readOnly={openRev !== null || archived}
                onFocus={(k, anchor) => { setFocusComment(k); setParam("c", k); if (anchor) setSelection([anchor]); }}
                onClose={() => { setPanelKind(null); setParam("c", null); }}
              />
            )}
            {panel === "history" && <HistoryPanel live={live} openRev={openRev} onOpen={(rev) => setParam("v", rev === null ? null : String(rev))} onClose={() => setPanelKind(null)} canEdit={canEdit && !archived} />}
            {panel === "product" && productPanel}
          </aside>
        )}
      </div>
    </div>
  );
}

function TitleInput({ docId, title, placeholder, readOnly }: { docId: string; title: string; placeholder: string; readOnly?: boolean }) {
  const [value, setValue] = useState(title);
  useWatchEffect(() => setValue(title), [title]);
  // Esc ends the edit through blur, which commits: the flag makes that blur throw the edit away.
  const cancelled = useRef(false);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setValue(title);
      return;
    }
    const next = value.trim();
    if (next && next !== title) (useInboxStore.getState() as any).updateDoc(docId, { title: next });
    else setValue(title);
  };
  return (
    <input
      data-live-title
      value={value}
      placeholder={placeholder}
      readOnly={readOnly}
      aria-label="Title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        // Enter and Esc end the edit and go no further: a list or page behind the title must not act on them.
        if (e.key !== "Enter" && e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") cancelled.current = true;
        (e.target as HTMLInputElement).blur();
      }}
      className="min-w-[6ch] max-w-[40%] shrink bg-transparent text-sm font-semibold text-sol-text placeholder:text-sol-text-dim outline-none rounded px-1 -mx-1 hover:bg-sol-bg-alt focus:bg-sol-bg-alt"
      style={{ width: `${Math.max(8, (value || placeholder).length + 1)}ch` }}
    />
  );
}

function IconToggle({ on, title, onClick, badge, children }: { on: boolean; title: string; onClick: () => void; badge?: number; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className={`relative inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-md transition-colors ${on ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt"}`}
    >
      {children}
      {!!badge && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-sol-blue text-mark leading-[14px] text-sol-bg font-semibold text-center">{badge}</span>
      )}
    </button>
  );
}

/** Whether this tab's edits have reached the server: Saving, Saved, or Offline with how many wait. */
function SyncState({ docId }: { docId: string }) {
  const online = useWsConnected();
  const waiting = useLiveUnsettled(docId);
  const refusal = useLiveRefusal(docId);
  const state = !online ? "offline" : waiting > 0 ? "saving" : refusal ? "refused" : "saved";
  const label = state === "offline" ? (waiting > 0 ? `Offline · ${waiting} waiting` : "Offline") : state === "saving" ? "Saving…" : state === "refused" ? "Not saved" : "Saved";
  return (
    <span
      data-live-sync={state}
      title={state === "refused" ? refusal ?? undefined : undefined}
      className={`text-meta shrink-0 tabular-nums ${state === "offline" || state === "refused" ? "text-sol-red" : "text-sol-text-dim"}`}
    >
      {label}
    </span>
  );
}

/** A restore too big for one transaction stopped partway: finish it or put the artifact back. */
function RestoreStoppedBar({ live }: { live: ReturnType<typeof useLiveArtifact> }) {
  const restoring = useLiveRestoring(live.docId);
  const [busy, setBusy] = useState<"finish" | "undo" | null>(null);
  if (!restoring) return null;
  const run = async (kind: "finish" | "undo") => {
    setBusy(kind);
    try {
      await live.history.restore(kind === "finish" ? restoring.to : restoring.from);
    } catch (e: any) {
      toast.error(e?.data ?? e?.message ?? "The restore did not finish");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex items-center gap-2 px-3 h-9 border-b border-sol-red/30 bg-sol-red/10 shrink-0" data-live-restore-stopped>
      <span className="text-xs font-medium text-sol-red">Restore to r{restoring.to} stopped partway</span>
      <span className="text-meta text-sol-text-muted truncate">{restoring.by_name}</span>
      <span className="flex-1" />
      <button type="button" disabled={!!busy} onClick={() => run("undo")} className="h-6 px-2 rounded text-xs text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt disabled:opacity-50">
        {busy === "undo" ? "Undoing…" : `Back to r${restoring.from}`}
      </button>
      <Button type="button" variant="destructive" size="xs" disabled={!!busy} onClick={() => run("finish")} className="h-6">
        {busy === "finish" ? "Finishing…" : "Finish restore"}
      </Button>
    </div>
  );
}

/** The artifact's "..." menu: Duplicate, and every download the view offers. */
function ArtifactMenu({ doc, canEdit, ready, exports, fileImport, selection }: { doc: { _id: string; title: string; doc_type: ArtifactType; team_id?: string; workspace?: string }; canEdit: boolean; ready: boolean; exports: LiveExport[] | null; fileImport: LiveImport | null; selection: string[] }) {
  const router = useRouter();
  const [archiving, setArchiving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const download = async (x: LiveExport, sel: string[]) => {
    const pending = toast.loading(`Preparing ${x.format.toUpperCase()}…`);
    try {
      const blob = await x.run({ selection: sel });
      toast.dismiss(pending);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(doc.title || "Untitled").replace(/[\\/:*?"<>|]+/g, " ").trim()}${sel.length ? " (selection)" : ""}.${x.format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
      toast.dismiss(pending);
      toast.error(`Could not export ${x.format.toUpperCase()}: ${e?.message ?? "failed"}`);
    }
  };
  const words = (x: LiveExport) => x.label ?? x.format.toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title="More" aria-label="More" data-live-menu className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt">
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </DropdownMenuTrigger>
      {/* The menu owns its keys: the Enter that picks a row must not also open the list row behind the page. */}
      <DropdownMenuContent align="end" data-owns-keys="" className="min-w-[200px]">
        {/* A copy holds the whole saved layer: offered once the page has read all of it. */}
        <DropdownMenuItem
          data-live-duplicate
          disabled={!ready}
          onSelect={() => {
            toast.promise(duplicateLiveArtifact(doc, (href) => router.push(href)).then((id) => { if (!id) throw new Error("no copy"); return id; }), {
              loading: "Making a copy…",
              success: "Copy opened",
              error: "Could not make a copy",
            });
          }}
        >
          <Copy className="w-3.5 h-3.5" /> Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem
          data-live-copy-link
          onSelect={() => { void navigator.clipboard?.writeText(sharePageUrl(`/docs/${doc._id}`)).then(() => toast.success("Link copied")); }}
        >
          <Link2 className="w-3.5 h-3.5" /> Copy link
        </DropdownMenuItem>
        {(!!exports?.length || fileImport) && <DropdownMenuSeparator />}
        {fileImport && (
          <DropdownMenuItem data-live-import onSelect={() => fileInput.current?.click()}>
            <Upload className="w-3.5 h-3.5" /> {fileImport.label}
          </DropdownMenuItem>
        )}
        {exports?.map((x) => (
          <DropdownMenuItem key={`${x.format}:${x.label ?? ""}`} data-live-export={x.format} onSelect={() => void download(x, [])}>
            <Download className="w-3.5 h-3.5" /> Download {words(x)}
          </DropdownMenuItem>
        ))}
        {selection.length > 0 && exports?.filter((x) => x.selectionAware).map((x) => (
          <DropdownMenuItem key={`sel:${x.format}:${x.label ?? ""}`} data-live-export-selection={x.format} onSelect={() => void download(x, selection)}>
            <Download className="w-3.5 h-3.5" /> Download selection as {words(x)}
          </DropdownMenuItem>
        ))}
        {canEdit && <DropdownMenuSeparator />}
        {canEdit && (
          <DropdownMenuItem data-live-archive onSelect={() => setArchiving(true)} className="text-sol-red focus:text-sol-red">
            <Archive className="w-3.5 h-3.5" /> Archive…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
      {archiving && (
        <SwitchReview
          ledger={{
            name: `Archive ${artifactSpec(doc.doc_type).label.toLowerCase()}`,
            subject: doc.title || "Untitled",
            shift: null,
            figures: [],
            rows: [{ k: "Who loses it", v: String(doc.workspace ?? "").startsWith("team:") ? "Everyone in the team" : "Only you" }, { k: "Undo", v: "From the toast that follows" }],
            confirm: "Archive",
            keep: "Keep",
          }}
          onClose={() => setArchiving(false)}
          onConfirm={() => {
            setArchiving(false);
            (useInboxStore.getState() as any).archiveDoc(doc._id);
            router.push("/docs");
          }}
        />
      )}
      {fileImport && (
        <input
          ref={fileInput}
          type="file"
          hidden
          accept={fileImport.accept}
          multiple={fileImport.multiple}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) fileImport.run(files);
          }}
        />
      )}
    </DropdownMenu>
  );
}

/**
 * Who may change the artifact. Its owner picks: everyone who can open it, or
 * only the owner and the people named. Anyone else who cannot edit sees that
 * they are viewing; comments stay open to them.
 */
function EditAccess({ doc, canEdit }: { doc: { _id: string; user_id?: string; workspace?: string }; canEdit: boolean }) {
  const me = useInboxStore((s: any) => s.currentUser?._id as string | undefined);
  const edit = useInboxStore((s: any) => (s.liveHeads?.[doc._id]?.edit as "team" | "owners" | undefined) ?? "team");
  const editorsSig = useInboxStore((s: any) => (s.liveHeads?.[doc._id]?.editors ?? []).join(","));
  const editors: string[] = useMemo(() => (editorsSig ? String(editorsSig).split(",") : []), [editorsSig]);
  const roster = useTeamRosterIdentity();
  const owner = !!me && String(doc.user_id) === me;
  // A personal artifact opens for its owner alone: there is no one to let in or keep out.
  if (String(doc.workspace ?? "").startsWith("user:")) return null;
  if (!owner) {
    return canEdit ? null : <span data-live-view-only className="text-meta shrink-0 px-1.5 h-6 inline-flex items-center rounded bg-sol-bg-alt text-sol-text-muted">View only</span>;
  }
  const set = (next: "team" | "owners", list: string[]) => (useInboxStore.getState() as any).liveSetEditAccess(doc._id, next, list);
  const nameOf = (id: string) => roster.find((m) => m._id === id)?.name ?? "Someone";
  const addable = roster.filter((m) => m._id !== me && !editors.includes(m._id) && !(m as any).is_bot);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-live-edit-access={edit} title={edit === "team" ? "Anyone can edit" : "Only you and editors edit"} className="inline-flex items-center gap-1 h-6 px-1.5 rounded text-meta shrink-0 text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt">
          {edit === "team" ? <Users className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
          <span data-live-edit-access-label>{edit === "team" ? "Anyone can edit" : editors.length ? `You + ${editors.length} edit` : "Only you edit"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-owns-keys="" className="min-w-[240px]">
        <DropdownMenuItem onSelect={() => set("team", editors)} data-live-edit-team>
          <Users className="w-3.5 h-3.5" /> <span className="flex-1">Anyone who can open it edits</span>{edit === "team" && <Check className="w-3.5 h-3.5" />}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => set("owners", editors)} data-live-edit-owners>
          <Lock className="w-3.5 h-3.5" /> <span className="flex-1">Only you and editors</span>{edit === "owners" && <Check className="w-3.5 h-3.5" />}
        </DropdownMenuItem>
        {edit === "owners" && (
          <>
            <DropdownMenuSeparator />
            {editors.map((id) => (
              <DropdownMenuItem key={id} onSelect={(e) => { e.preventDefault(); set("owners", editors.filter((x) => x !== id)); }} data-live-editor={id}>
                <span className="flex-1 truncate">{nameOf(id)}</span><X className="w-3.5 h-3.5 text-sol-text-dim" />
              </DropdownMenuItem>
            ))}
            {addable.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><Plus className="w-3.5 h-3.5" /> Add editor</DropdownMenuSubTrigger>
                <DropdownMenuSubContent data-owns-keys="" className="max-h-[320px] overflow-y-auto">
                  {addable.map((m) => (
                    <DropdownMenuItem key={m._id} onSelect={() => set("owners", [...editors, m._id])}>{m.name}</DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Focus: the canvas gets the window. It is the app's zen mode (top bar and
 * sidebar folded away, remembered per person), and while an artifact is open
 * in it the list column beside the open doc folds away too.
 */
function FocusToggle() {
  const zen = useInboxStore((s: any) => s.clientState.ui?.zen_mode ?? false);
  const { dispatchAction } = useShortcuts();
  useWatchEffect(() => {
    if (!zen) return;
    document.documentElement.dataset.liveFocus = "";
    return () => { delete document.documentElement.dataset.liveFocus; };
  }, [zen]);
  return (
    <button
      type="button"
      data-live-focus-toggle={zen ? "on" : "off"}
      aria-pressed={zen}
      title={zen ? "Exit focus" : "Focus"}
      aria-label={zen ? "Exit focus" : "Focus"}
      onClick={() => dispatchAction("ui.zenToggle")}
      className={`inline-flex items-center justify-center w-7 h-7 rounded-md shrink-0 transition-colors ${zen ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt"}`}
    >
      {zen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
    </button>
  );
}

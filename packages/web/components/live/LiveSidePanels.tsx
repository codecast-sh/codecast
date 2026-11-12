// The shell's right-hand panels for a live artifact: comment threads and the
// version history. Both read the store through the live hooks.
import { useMemo, useRef, useState } from "react";
import { Bot, Check, History, Link2, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { artifactSpec, artifactView, type ArtifactElement } from "@codecast/shared/artifacts";
import { useLiveComments, useLiveElement, useLiveElements, useLiveVersions, type LiveHandle } from "./useLiveArtifact";
import { pickAskTarget, sendAsk, type AskDoc } from "./askAgent";
import { relativeTime } from "../../lib/entityDisplay";
import { sharePageUrl } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { CommentComposer } from "../comments/CommentComposer";
import { CommentMarkdown } from "../comments/CommentMarkdown";
import { groupThreads } from "./liveThreads";
const formatRelative = (ts: number) => relativeTime(ts) ?? "";
/** A comment's age the way a thread reads it: "just now", "4 min", then the app's relative time. */
function commentAge(ts: number, now: number): string {
  const mins = Math.floor((now - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  return formatRelative(ts);
}

export function CommentsPanel({
  doc,
  live,
  selection,
  focusKey,
  selectedElements,
  onFocus,
  readOnly = false,
  composeTick,
  onClose,
  canAsk = true,
  onPosted,
}: {
  /** A comment was posted from the new-comment box. */
  onPosted?: () => void;
  /** The person can edit, so an agent they send works with their rights; a viewer's agent could change nothing. */
  canAsk?: boolean;
  onClose?: () => void;
  /** Bumped when a product asks for a new comment: the box takes focus. */
  composeTick?: number;
  /** A version is open, or the viewer cannot edit: read the threads, write nothing. */
  readOnly?: boolean;
  doc: AskDoc & { team_id?: string };
  live: LiveHandle;
  selection: string[];
  focusKey: string | null;
  selectedElements: ArtifactElement[];
  onFocus: (commentKey: string, anchor?: string) => void;
}) {
  const all = useLiveComments(live.docId);
  const me = useInboxStore((s: any) => s.currentUser?._id as string | undefined);
  const [toAgent, setToAgent] = useState(false);
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const threads = useMemo(() => groupThreads(all), [all]);
  // A thread pinned to an element follows it: the product stamps the element with the thread's key (`cm`),
  // so a sheet's sort or insert moves the thread with its cell. Its `anchor` is only where it was made.
  const elements = useLiveElements(live.docId);
  const spec = artifactSpec(doc.doc_type);
  const view = useMemo(() => artifactView(doc.doc_type, doc.title, elements), [doc.doc_type, doc.title, elements]);
  // Where each thread is now: the product says (a sheet's thread rides its cell through sorts and inserts,
  // and loses it when the cell is deleted: null); else the element stamped with the thread's key; else its anchor.
  const placeOf = useMemo(() => {
    if (spec.commentPlaces) return spec.commentPlaces(view, threads.map((t) => ({ key: t.root.key, anchor: t.root.anchor })));
    const m = new Map<string, string | null>();
    for (const e of elements) if (typeof e.cm === "string") m.set(e.cm, e.key);
    return m;
  }, [spec, view, threads, elements]);
  const anchorOf = (root: ArtifactElement): string | null | undefined =>
    placeOf.has(root.key) ? placeOf.get(root.key) : root.anchor ? String(root.anchor) : undefined;
  const open = threads.filter((t) => !t.root.resolved);
  const resolved = threads.filter((t) => t.root.resolved);
  // A thread whose element is gone is shown, but no longer counts as open.
  const openCount = open.filter((t) => anchorOf(t.root) !== null).length;
  const shown = tab === "open" ? open : resolved;
  // Once words are in the new-comment box, it stays on the element it was started for: clicking elsewhere
  // moves the selection, not the comment. Posting or emptying the box lets go.
  const draftText = useInboxStore((s: any) => (s.drafts?.[`comment:live:${doc._id}:new`]?.draft_message as string | undefined) ?? "");
  const [heldAnchor, setHeldAnchor] = useState<string | null>(null);
  const hasDraft = draftText.trim().length > 0;
  useWatchEffect(() => {
    if (!hasDraft) setHeldAnchor(null);
    else if (heldAnchor === null && selection[0]) setHeldAnchor(selection[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- holds the anchor the draft began on
  }, [hasDraft]);
  const anchor = heldAnchor ?? selection[0];
  // A thread opened from a link (?c=) shows wherever it is filed.
  const focusedResolved = focusKey ? threads.find((x) => x.root.key === focusKey)?.root.resolved : undefined;
  const focusKnown = focusedResolved !== undefined || (!!focusKey && threads.some((x) => x.root.key === focusKey));
  useWatchEffect(() => {
    if (focusKnown) setTab(focusedResolved ? "resolved" : "open");
    // Only a newly focused thread (or one that just arrived) moves the tab; resolving the focused one keeps it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, focusKnown]);

  const post = (body: string) => {
    const key = live.comment({ text: body, ...(anchor ? { anchor } : {}) });
    // Tie the new thread to its element (a sheet's cell) so it moves with it. Only an editor can write the element.
    if (anchor && canAsk && spec.pinComment) {
      const pin = spec.pinComment(view, anchor, key);
      if (pin.length) live.apply(pin, { layer: "main", undoable: false });
    }
    onPosted?.();
    if (toAgent) {
      pickAskTarget("Send this comment to…", (target) => {
        void sendAsk(doc, { prompt: body, selected: selectedElements, comment_key: key }, target);
      });
      setToAgent(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-w-0" data-live-comments>
      <div className="flex items-center gap-1 px-2 h-9 border-b border-sol-border/40 shrink-0" role="tablist">
        {(["open", "resolved"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            data-live-comments-tab={k}
            onClick={() => setTab(k)}
            className={`h-6 px-2 rounded text-xs ${tab === k ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
          >
            {k === "open" ? "Open" : "Resolved"} <span className="text-sol-text-dim tabular-nums">{k === "open" ? openCount : resolved.length}</span>
          </button>
        ))}
        <span className="flex-1" />
        {onClose && <PanelClose onClose={onClose} />}
      </div>
      {/* The new-thread box stands aside while a thread is open (its own reply box answers it) or the resolved ones show. */}
      {!readOnly && tab === "open" && focusKey && threads.some((t) => t.root.key === focusKey) && (
        <div className="px-2 py-1.5 border-b border-sol-border/30 shrink-0">
          <button type="button" data-live-comment-new-open onClick={() => onFocus("", undefined)} className="inline-flex items-center gap-1 h-6 px-1.5 rounded text-meta text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt">
            <Plus className="w-3 h-3" /> New comment
          </button>
        </div>
      )}
      {!readOnly && tab === "open" && (!focusKey || !threads.some((t) => t.root.key === focusKey)) && (
        <div className="p-2 border-b border-sol-border/30 shrink-0 min-w-0" data-live-comment-new>
          {anchor && <AnchorLabel docId={doc._id} anchor={anchor} />}
          <CommentComposer
            key={composeTick ?? 0}
            autoFocus={!!composeTick}
            conversationId={`live:${doc._id}`}
            scopeKey={`live:${doc._id}:new`}
            enabled={false}
            authed
            mentionTeamId={doc.team_id}
            chatMentionMode
            placeholder="Comment, @ to mention"
            onSubmit={post}
          />
          {canAsk && <label className="mt-1.5 inline-flex items-center gap-2 text-meta text-sol-text-muted cursor-pointer select-none">
            <Switch checked={toAgent} onCheckedChange={setToAgent} aria-label="Send to agent" />
            Send to agent
          </label>}
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {shown.length === 0 && <div className="px-3 py-6 text-center text-xs text-sol-text-dim">{tab === "open" ? "No open comments" : "Nothing resolved"}</div>}
        {shown.map(({ root, replies }) => (
          <Thread
            key={root.key}
            doc={doc}
            live={live}
            me={me}
            root={root}
            replies={replies}
            focused={focusKey === root.key}
            readOnly={readOnly}
            onFocus={onFocus}
            anchor={anchorOf(root)}
            onReopened={() => { setTab("open"); onFocus(root.key, anchorOf(root) ?? undefined); }}
          />
        ))}
      </div>
    </div>
  );
}

function Thread({ doc, live, me, root, replies, focused, readOnly, onFocus, onReopened, anchor }: {
  /** Where the thread is now (it may have moved with its element since it was made); null when its element is gone. */
  anchor?: string | null;
  onReopened: () => void;
  doc: AskDoc & { team_id?: string };
  live: LiveHandle;
  me?: string;
  root: ArtifactElement;
  replies: ArtifactElement[];
  focused: boolean;
  readOnly: boolean;
  onFocus: (k: string, anchor?: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const setRoot = (set: Record<string, any>) => live.apply([{ k: root.key, set }], { layer: "comments", undoable: false });
  const mine = (c: ArtifactElement) => !!me && c.author === `u:${me}`;
  // The artifact's owner moderates: they may delete any comment, a whole thread included.
  const owner = !!me && String((doc as any).user_id ?? "") === me;
  const canDelete = (c: ArtifactElement) => owner || mine(c);
  // A thread goes with its first comment, so only when every reply in it is yours too (or you own the artifact).
  const canDeleteThread = owner || (mine(root) && replies.every(mine));
  const remove = (c: ArtifactElement) => {
    const gone = c.key === root.key ? [root, ...replies] : [c];
    live.apply(gone.map((x) => ({ k: x.key, del: true as const })), { layer: "comments", undoable: false });
    toast(gone.length > 1 ? `Thread deleted` : "Comment deleted", {
      action: {
        label: "Undo",
        onClick: () => live.apply(gone.map((x) => ({ k: x.key, put: commentFields(x) })), { layer: "comments", undoable: false }),
      },
    });
  };
  const edit = (c: ArtifactElement, text: string) => live.apply([{ k: c.key, set: { text, edited_at: Date.now() } }], { layer: "comments", undoable: false });
  const copyLink = () => {
    const url = sharePageUrl(`/docs/${live.docId}?c=${root.key}`);
    void Promise.resolve(navigator.clipboard?.writeText(url))
      .then(() => toast.success("Link to comment copied"))
      .catch(() => toast.error("Could not copy the link", { description: url }));
  };
  return (
    <div
      ref={ref}
      data-live-thread={root.key}
      onClick={() => onFocus(root.key, anchor ?? undefined)}
      className={`group px-3 py-2.5 border-b border-sol-border/20 cursor-pointer ${focused ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt/60"}`}
    >
      <CommentLine docId={live.docId} c={root} anchor={anchor} canDelete={!readOnly && canDeleteThread} onDelete={() => remove(root)} onEdit={!readOnly && mine(root) ? (text) => edit(root, text) : undefined} />
      {root.sent_to ? <AskState root={root} /> : null}
      {replies.map((r) => (
        <div key={r.key} className="mt-2 pl-3 border-l border-sol-border/40">
          <CommentLine docId={live.docId} c={r} canDelete={!readOnly && canDelete(r)} onDelete={() => remove(r)} onEdit={!readOnly && mine(r) ? (text) => edit(r, text) : undefined} />
        </div>
      ))}
      {!readOnly && (
        <div className="mt-1.5 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            data-live-resolve={root.key}
            onClick={() => {
              const toastId = `resolve:${root.key}`;
              if (root.resolved) {
                setRoot({ resolved: null });
                toast.dismiss(toastId);
                onReopened();
              } else {
                setRoot({ resolved: true });
                toast("Thread resolved", { id: toastId, action: { label: "Undo", onClick: () => setRoot({ resolved: null }) } });
              }
            }}
            className="inline-flex items-center gap-1 h-6 px-1.5 rounded text-meta text-sol-text-dim hover:text-sol-green hover:bg-sol-green/10"
          >
            {root.resolved ? <RotateCcw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
            {root.resolved ? "Reopen" : "Resolve"}
          </button>
          <button
            type="button"
            data-live-comment-link={root.key}
            onClick={copyLink}
            className="inline-flex items-center gap-1 h-6 px-1.5 rounded text-meta text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt"
          >
            <Link2 className="w-3 h-3" /> Copy link
          </button>
        </div>
      )}
      {focused && !readOnly && !root.resolved && (
        <div className="mt-1.5" onClick={(e) => e.stopPropagation()} data-live-reply={root.key}>
          <CommentComposer
            conversationId={`live:${doc._id}`}
            scopeKey={`live:${doc._id}:${root.key}`}
            enabled={false}
            authed
            mentionTeamId={doc.team_id}
            chatMentionMode
            placeholder="Reply"
            autoFocus
            onSubmit={(text) => { live.comment({ text, parent: root.key }); }}
          />
        </div>
      )}
    </div>
  );
}

function PanelClose({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" title="Close" aria-label="Close panel" data-live-panel-close onClick={onClose} className="p-1 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt">
      <X className="w-3.5 h-3.5" />
    </button>
  );
}

/** A comment's own fields, to put it back (Undo of a delete). */
function commentFields(c: ArtifactElement): { kind: string } & Record<string, any> {
  const { key: _k, rev: _r, by: _b, at: _a, kind, ...rest } = c as any;
  return { kind: kind ?? "comment", ...rest };
}

/** What a new comment pins to, in words a person reads: a cell's address, an element's kind and text. */
function AnchorLabel({ docId, anchor, inline = false }: { docId: string; anchor: string; inline?: boolean }) {
  const el = useLiveElement(docId, anchor);
  // A sheet cell "c:<tabId>!A1" reads with its tab's name, from the tab:<id> element.
  const cell = anchor.startsWith("c:") ? anchor.slice(2).split("!") : null;
  const tab = useLiveElement(docId, cell && cell.length === 2 ? `tab:${cell[0]}` : "");
  const text = typeof el?.text === "string" ? el.text.trim().replace(/\s+/g, " ") : typeof el?.title === "string" ? el.title : "";
  const words = cell ? (cell.length === 2 ? `${typeof tab?.name === "string" && tab.name ? tab.name : cell[0]}!${cell[1]}` : cell[0]) : el ? `${el.kind}${text ? ` "${text.length > 28 ? `${text.slice(0, 28)}…` : text}"` : ""}` : inline ? "a removed element" : "selection";
  if (inline) return <span className="text-sol-text-dim truncate min-w-0">{words}</span>;
  return <div className="mb-1 text-meta text-sol-text-dim truncate" data-live-comment-anchor>on {words}</div>;
}

/** Where an ask stands: with the agent, or answered in this thread. */
function AskState({ root }: { root: ArtifactElement }) {
  const answered = !!root.answered_at;
  return (
    <div className={`mt-1 inline-flex items-center gap-1 h-5 px-1.5 rounded text-meta ${answered ? "bg-sol-green/10 text-sol-green" : "bg-sol-violet/10 text-sol-violet"}`} data-live-ask-state={answered ? "answered" : "working"}>
      <Bot className="w-3 h-3" />
      {answered ? `Answered · ${String(root.answered_by_name ?? "agent")}` : "With agent"}
    </div>
  );
}

/** Ticks with the clock (a coarse one: no re-render faster than the words change). */
function CommentTime({ ts, edited }: { ts: number; edited: boolean }) {
  const now = useCoarseNow(30_000);
  return (
    <span className="text-sol-text-dim shrink-0" title={new Date(ts).toLocaleString()}>
      {commentAge(ts, now)}{edited ? " · edited" : ""}
    </span>
  );
}

function CommentLine({ docId, c, anchor = c.anchor ? String(c.anchor) : undefined, canDelete, onDelete, onEdit }: { docId: string; c: ArtifactElement; anchor?: string | null; canDelete: boolean; onDelete: () => void; onEdit?: (text: string) => void }) {
  // The author's own words open into an editor; Enter saves, Esc leaves them as they were.
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const save = () => {
    if (cancelled.current) { cancelled.current = false; return; }
    const next = draft?.trim();
    if (next && next !== c.text) onEdit?.(next);
    setDraft(null);
  };
  return (
    <div>
      <div className="flex items-center gap-1.5 text-meta">
        <span className={`font-medium truncate min-w-0 ${String(c.author ?? "").startsWith("s:") ? "text-sol-violet" : "text-sol-text"}`}>{String(c.author_name ?? "Someone")}</span>
        {anchor === null ? <span className="text-sol-text-dim italic shrink-0" data-live-comment-detached>its {c.anchor && String(c.anchor).startsWith("c:") ? "cell" : "element"} was deleted</span> : null}{anchor ? <AnchorLabel docId={docId} anchor={anchor} inline /> : null}
        <span className="flex-1" />
        <CommentTime ts={Number(c.created_at ?? c.at ?? 0)} edited={!!c.edited_at} />
        {onEdit && draft === null && (
          <button
            type="button"
            title="Edit"
            aria-label="Edit comment"
            onClick={(e) => { e.stopPropagation(); cancelled.current = false; setDraft(String(c.text ?? "")); }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-sol-text-dim hover:text-sol-text"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            title="Delete"
            aria-label="Delete comment"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-sol-text-dim hover:text-sol-red"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {draft !== null ? (
        <textarea
          autoFocus
          data-live-comment-edit
          value={draft}
          rows={Math.min(6, Math.max(2, draft.split("\n").length))}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); save(); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; setDraft(null); }
          }}
          className="mt-1 w-full resize-none rounded-md bg-sol-bg-alt border border-sol-blue/50 px-2 py-1.5 text-xs text-sol-text outline-none"
        />
      ) : (
        <div className="mt-0.5 text-xs text-sol-text break-words"><CommentMarkdown content={String(c.text ?? "")} /></div>
      )}
    </div>
  );
}

export function HistoryPanel({ live, openRev, onOpen, onClose, canEdit = true }: { live: LiveHandle; openRev: number | null; onOpen: (rev: number | null) => void; onClose?: () => void; canEdit?: boolean }) {
  const versions = useLiveVersions(live.docId);
  // Naming a version: null while not saving, the typed name while saving.
  const [naming, setNaming] = useState<string | null>(null);
  const save = () => {
    live.history.checkpoint(naming?.trim() || undefined);
    setNaming(null);
  };
  return (
    <div className="flex flex-col h-full" data-live-history>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-sol-border/40 text-xs font-medium text-sol-text-muted shrink-0">
        <History className="w-3.5 h-3.5" /> History
        <span className="flex-1" />
        {canEdit && openRev === null && naming === null && (
          <button type="button" data-live-save-version onClick={() => setNaming("")} className="h-6 px-1.5 rounded text-meta text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt">Save version</button>
        )}
        {onClose && <PanelClose onClose={onClose} />}
      </div>
      {naming !== null && (
        <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-sol-border/30 shrink-0">
          <input
            autoFocus
            data-live-version-name
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); save(); }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setNaming(null); }
            }}
            placeholder="Name this version"
            maxLength={120}
            className="flex-1 min-w-0 h-7 px-2 rounded-md bg-sol-bg-alt border border-sol-border/40 text-xs text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-blue/50"
          />
          <Button type="button" size="xs" variant="primary" onClick={save} className="h-7">Save</Button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <button
          type="button"
          onClick={() => onOpen(null)}
          className={`w-full text-left px-3 py-2 border-b border-sol-border/20 ${openRev === null ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt/60"}`}
        >
          <div className="text-xs text-sol-text font-medium">Current</div>
        </button>
        {versions.length === 0 && <div className="px-3 py-6 text-center text-xs text-sol-text-dim">No versions yet</div>}
        {versions.map((v) => (
          <button
            type="button"
            key={v._id}
            data-live-version={v.rev}
            onClick={() => onOpen(v.rev)}
            className={`w-full text-left px-3 py-2 border-b border-sol-border/20 ${openRev === v.rev ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt/60"}`}
          >
            <div className="text-xs text-sol-text truncate">{v.label}</div>
            <div className="flex items-center gap-1.5 text-meta text-sol-text-dim min-w-0">
              <span className="shrink-0 tabular-nums">{versionTime(v.at)}</span>
              <span>·</span>
              <span className="truncate">{v.by_name}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** When a version was taken, as a person reads it: "12:31" today, "Nov 9, 12:31" before. */
function versionTime(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `Today ${time}` : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

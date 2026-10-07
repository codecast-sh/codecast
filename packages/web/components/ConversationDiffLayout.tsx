import { useState, useRef, useMemo } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useDragGatedLayoutPersist } from "../hooks/useDragGatedLayoutPersist";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { Panel, Group, Separator } from "react-resizable-panels";
import { ConversationView } from "./ConversationView";
import type { ConversationData, ConversationViewHandle, ConversationViewProps } from "./conversation/types";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { extractFileChanges, mergeFileChanges } from "../lib/fileChangeExtractor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { FileDiffLayout } from "./FileDiffLayout";
import { foldReadyFiles, lastPromptAt } from "../lib/conversationDiffFiles";
import type { FileChangeEntry } from "../store/diffViewerStore";
import { useInboxStore, useTrackedStore, isConvexId } from "../store/inboxStore";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useFileChangeBodies } from "../hooks/useFileChangeBodies";
import { DIFF_BASES, diffBaseStart, selectRangeFoldInputs, type DiffBase } from "@codecast/shared/diff";
import { SegmentedToggle } from "./SegmentedToggle";
import { isSeen, toggleSeenFile } from "../lib/diffSeenMarks";
import { api } from "@codecast/convex/convex/_generated/api";
import { getRelativePath } from "@codecast/shared/render";
import { shareTokenArg } from "../lib/shareTokenScope";
import { devRenderCount } from "../lib/devRenderCount";
import { requestFilePathMenu } from "../lib/filePathMenu";
import { filePathHref } from "../lib/filePathLinks";
import { keyBelongsElsewhere } from "../shortcuts/keyOwnership";
import { useSurface } from "../lib/surfaces";
import { useFollowSurface } from "../hooks/useFollowSurface";

const MOBILE_BREAKPOINT = 768;
const DEFAULT_DIFF_LAYOUT = { content: 40, diff: 60 };

type Layout = { [key: string]: number };

export interface ConversationDiffLayoutProps {
  conversation: ConversationData;
  embedded?: boolean;
  headerExtra?: React.ReactNode;
  headerLeft?: React.ReactNode;
  headerEnd?: React.ReactNode;
  commits?: any[];
  pullRequests?: any[];
  hasMoreAbove?: boolean;
  hasMoreBelow?: boolean;
  isLoadingOlder?: boolean;
  isLoadingNewer?: boolean;
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
  onJumpToStart?: () => void;
  onJumpToEnd?: () => void;
  onJumpToTimestamp?: (ts: number) => void;
  highlightQuery?: string;
  onClearHighlight?: () => void;
  targetMessageId?: string;
  targetNonce?: number;
  isJumpingToTarget?: boolean;
  onTargetSettled?: ConversationViewProps["onTargetSettled"];
  isOwner?: boolean;
  guest?: boolean;
  showMessageInput?: boolean;
  onSendAndAdvance?: () => void;
  onSendAndDismiss?: () => void;
  autoFocusInput?: boolean;
  backHref?: string;
  fallbackStickyContent?: string | null;
  onBack?: () => void;
  subHeaderContent?: React.ReactNode;
  // A host that already carries the conversation's identity (the anchor
  // slide-over) drops the inner header rather than showing two.
  hideHeader?: boolean;
  /** See ConversationViewProps: a host that owns the send (the staffing pane). */
  onSendOverride?: ConversationViewProps["onSendOverride"];
  composerNode?: React.ReactNode;
  leadNode?: ConversationViewProps["leadNode"];
  leadPinned?: ConversationViewProps["leadPinned"];
  stickyPrompt?: ConversationViewProps["stickyPrompt"];
  initialDensity?: ConversationViewProps["initialDensity"];
  foldWorkingTurns?: ConversationViewProps["foldWorkingTurns"];
  openAtTop?: ConversationViewProps["openAtTop"];
  composerPlaceholder?: ConversationViewProps["composerPlaceholder"];
  /** A host with no room for the diff (a proposal's thread in the org page's
   *  column): the conversation alone, at every width. */
  hideDiff?: boolean;
}

const EMPTY_LIST: any[] = [];

export function ConversationDiffLayout({
  conversation,
  embedded,
  headerExtra,
  headerLeft,
  headerEnd,
  commits,
  pullRequests,
  hasMoreAbove,
  hasMoreBelow,
  isLoadingOlder,
  isLoadingNewer,
  onLoadOlder,
  onLoadNewer,
  onJumpToStart,
  onJumpToEnd,
  onJumpToTimestamp,
  highlightQuery,
  targetMessageId,
  targetNonce,
  isJumpingToTarget,
  onTargetSettled,
  onClearHighlight,
  isOwner,
  guest,
  showMessageInput,
  onSendAndAdvance,
  onSendAndDismiss,
  autoFocusInput,
  backHref: backHrefProp,
  fallbackStickyContent,
  onBack,
  subHeaderContent,
  hideHeader,
  onSendOverride,
  composerNode,
  leadNode,
  leadPinned,
  stickyPrompt,
  initialDensity,
  foldWorkingTurns,
  openAtTop,
  composerPlaceholder,
  hideDiff: hideDiffProp,
}: ConversationDiffLayoutProps) {
  devRenderCount("ConversationDiffLayout");
  // Hosted mode has no diff panel (lib/surfaces.ts).
  const diffShown = useSurface("diff");
  const hideDiff = hideDiffProp || !diffShown;
  const heightClass = "h-full";
  const [isMobile, setIsMobile] = useState(false);
  const layoutPref = useInboxStore(s => s.clientState.layouts?.conversation_diff ?? DEFAULT_DIFF_LAYOUT);
  const updateLayout = useInboxStore(s => s.updateClientLayout);
  const layout: Layout = { "content-panel": layoutPref.content, "diff-panel": layoutPref.diff };
  const conversationRef = useRef<ConversationViewHandle>(null);

  const {
    changes,
    nextChange,
    prevChange,
    toggleDiffMode,
    toggleFileTree,
    clearSelection,
    setChanges,
    diffPanelOpen,
  } = useDiffViewerStore();

  // Every change of the session, materialized server-side at ingest and
  // independent of how many message pages are loaded. References only: the
  // text of a change arrives separately, for the few changes a fold reads
  // (useFileChangeBodies), so a session with hundreds of whole-file snapshots
  // costs the same to open as a short one. Undefined while loading; empty for
  // conversations whose edits predate materialization.
  const { data: serverFileChanges } = useQueryNoThrow(
    api.messages.getConversationFileChangeIndex,
    conversation?._id && isConvexId(conversation._id)
      ? { conversation_id: conversation._id, ...shareTokenArg(conversation._id) }
      : "skip",
  );

  useWatchEffect(() => {
    // Merge the authoritative server set with the client window extraction: server
    // gives completeness without scrolling; the client backfills un-materialized
    // (pre-feature) conversations so nothing regresses to "scroll up to see it",
    // and its changes carry their text, which seeds the body cache.
    const clientChanges: FileChangeEntry[] = conversation?.messages ? extractFileChanges(conversation.messages as any) : [];
    setChanges(conversation?._id ?? null, mergeFileChanges<FileChangeEntry>(serverFileChanges ?? [], clientChanges));
  }, [conversation?._id, conversation?.messages, serverFileChanges, setChanges]);

  // Follow mode (lib/follow.ts): the side panel beside the transcript is part
  // of a person's place, "diff" while it is open and "none" while it is not,
  // and so is the change the diff is folded up to (the diff's base), which
  // decides which files the pane holds. The state is global, so a copy kept
  // mounted in a background tab reads and writes the same answer. The file
  // and line are the pane's own (FileDiffLayout), applied after this.
  const selectedChangeIndex = useDiffViewerStore((s) => s.selectedChangeIndex);
  useFollowSurface(
    {
      read: () => ({
        panel: diffPanelOpen ? "diff" : "none",
        diff: diffPanelOpen ? { file: "", base: selectedChangeIndex === null ? "all" : `change:${selectedChangeIndex}` } : undefined,
      }),
      apply: (view) => {
        const dv = useDiffViewerStore.getState();
        const base = view.diff?.base;
        if (base === "all" && dv.selectedChangeIndex !== null) dv.clearSelection();
        else if (base?.startsWith("change:")) {
          const index = Number(base.slice(7));
          if (Number.isInteger(index) && index >= 0 && index < dv.changes.length && index !== dv.selectedChangeIndex) dv.selectChange(index);
        }
        if (view.panel !== "diff" && view.panel !== "none") return [];
        dv.setDiffPanelOpen(view.panel === "diff");
        return ["panel"];
      },
    },
    !hideDiff,
    [diffPanelOpen, selectedChangeIndex],
  );

  useMountEffect(() => {
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
  });

  useEventListener("resize", () => {
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
  });

  useEventListener("keydown", (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInput = keyBelongsElsewhere(target);

    if (isInput || !diffShown) return;

    switch (e.key) {
      case "[":
        e.preventDefault();
        prevChange();
        break;
      case "]":
        e.preventDefault();
        nextChange();
        break;
      case "c":
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        toggleDiffMode();
        break;
      case "f":
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        toggleFileTree();
        break;
      case "Escape":
        if (conversation?.status === "active") return;
        e.preventDefault();
        clearSelection();
        break;
    }
  });

  const handleLayoutChange = useDragGatedLayoutPersist((newLayout) => {
    updateLayout("conversation_diff", { content: newLayout["content-panel"] || 40, diff: newLayout["diff-panel"] || 60 });
  });

  // Element props handed to the memoized ConversationView must keep identity
  // across this component's own re-renders, or the memo never holds.
  const combinedHeaderExtra = useMemo(() => {
    const changesOverlay = changes.length > 0 && !diffPanelOpen && !hideDiff ? <ChangesBar changes={changes} /> : null;
    return changesOverlay ? (
      <>
        {headerExtra}
        {changesOverlay}
      </>
    ) : headerExtra;
  }, [changes, diffPanelOpen, hideDiff, headerExtra]);

  const conversationViewProps = {
    ref: conversationRef,
    conversation,
    backHref: backHrefProp || "/team/activity",
    headerExtra: combinedHeaderExtra,
    headerLeft,
    headerEnd,
    commits: commits || EMPTY_LIST,
    pullRequests: pullRequests || EMPTY_LIST,
    hasMoreAbove,
    hasMoreBelow,
    isLoadingOlder,
    isLoadingNewer,
    onLoadOlder,
    onLoadNewer,
    onJumpToStart,
    onJumpToEnd,
    onJumpToTimestamp,
    highlightQuery,
    onClearHighlight,
    embedded,
    targetMessageId,
    targetNonce,
    isJumpingToTarget,
    onTargetSettled,
    isOwner,
    guest,
    showMessageInput,
    onSendAndAdvance,
    onSendAndDismiss,
    autoFocusInput,
    fallbackStickyContent,
    onBack,
    subHeaderContent,
    hideHeader,
    onSendOverride,
    composerNode,
    leadNode,
    leadPinned,
    stickyPrompt,
    initialDensity,
    foldWorkingTurns,
    openAtTop,
    composerPlaceholder,
  };

  // Mobile: tabs layout
  if (isMobile && !hideDiff) {
    return (
      <div className={`${heightClass} w-full`}>
        <Tabs defaultValue="conversation" className="h-full flex flex-col">
          <TabsList className="grid w-full grid-cols-2 shrink-0 h-9 sm:h-11">
            <TabsTrigger value="conversation" className="py-1.5 sm:py-2 text-xs sm:text-sm">Conversation</TabsTrigger>
            <TabsTrigger value="diff" className="py-1.5 sm:py-2 text-xs sm:text-sm">
              Diff {changes.length > 0 && `(${changes.length})`}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="conversation" className="flex-1 overflow-auto m-0">

            <ConversationView {...conversationViewProps} />
          </TabsContent>
          <TabsContent value="diff" className="flex-1 overflow-auto m-0">
            <DiffPane conversation={conversation} />
          </TabsContent>
        </Tabs>
      </div>
    );
  }

  // Desktop: diff panel closed - simple layout
  if (!diffPanelOpen || hideDiff) {
    return (
      <div className={`${heightClass} w-full overflow-y-auto relative`}>
        <ConversationView {...conversationViewProps} />
      </div>
    );
  }

  // Desktop: diff panel open - resizable panels
  return (
    <div className={`${heightClass} w-full relative`}>
      <Group
        orientation="horizontal"
        onLayoutChange={handleLayoutChange}
        defaultLayout={layout}
        className="h-full"
      >
        {/* Conversation Panel */}
        <Panel id="content-panel" minSize={15}>
          <div className="h-full relative overflow-y-auto">

            <ConversationView {...conversationViewProps} />
          </div>
        </Panel>

        {/* Resize handle - on LEFT of timeline */}
        <Separator className="cc-split" />

        {/* Timeline + Diff Panel */}
        <Panel id="diff-panel" minSize={20}>
          <div className="h-full flex">
            {/* Timeline Strip */}
            <div className="w-10 h-full border-r border-sol-border bg-sol-bg-alt/30 relative flex-shrink-0">
              <TimelineStrip conversationRef={conversationRef} />
            </div>
            {/* Diff Content */}
            <div className="flex-1 h-full min-w-0">
              <DiffPane conversation={conversation} />
            </div>
          </div>
        </Panel>
      </Group>

    </div>
  );
}

// The base switch: where the diff starts. Labels stay one word so the control
// fits a narrow pane; the tooltip says what each one means here.
const BASE_LABELS: Record<DiffBase, { label: string; title: string }> = {
  session: { label: "Session", title: "Every change this session made" },
  branch: { label: "Branch", title: "Since the branch left the default branch, as far as this session's commits show" },
  commit: { label: "Commit", title: "Changes since the session's last commit" },
  turn: { label: "Turn", title: "Changes since your last message" },
};
const BASE_UNAVAILABLE: Partial<Record<DiffBase, string>> = {
  commit: "This session has not committed yet",
  turn: "No message of yours is loaded here",
};
const BASE_EMPTY: Record<DiffBase, string> = {
  session: "No changes yet",
  branch: "Nothing changed since the branch base",
  commit: "Nothing changed since the last commit",
  turn: "Nothing changed since your last message",
};

export function DiffPane({ conversation }: { conversation?: ConversationData }) {
  const conversationId = conversation?._id;
  const gitRoot = conversation?.git_root;
  const { selectedChangeIndex, rangeStart, rangeEnd, changes, selectedFile, bodies, missingBodies, setDiffBase } = useDiffViewerStore();
  const ui = useTrackedStore([
    (s) => (conversationId ? s.clientState.ui?.diff_base?.[conversationId] : undefined),
    (s) => (conversationId ? s.clientState.ui?.diff_seen_files?.[conversationId] : undefined),
  ]).clientState.ui;
  const chosenBase: DiffBase = (conversationId && ui?.diff_base?.[conversationId]) || "session";
  const seenMarks = conversationId ? ui?.diff_seen_files?.[conversationId] : undefined;

  // Where each base starts in this session's changes. A base that names
  // nothing here (no commit yet) shows disabled, and a remembered choice that
  // names nothing falls back to the whole session.
  const turnStartedAt = useMemo(() => lastPromptAt(conversation?.messages), [conversation?.messages]);
  const starts = useMemo(
    () => Object.fromEntries(DIFF_BASES.map((b) => [b, diffBaseStart(changes, b, { turnStartedAt, branch: conversation?.git_branch })])) as Record<DiffBase, number | null>,
    [changes, turnStartedAt, conversation?.git_branch],
  );
  const base: DiffBase = starts[chosenBase] === null ? "session" : chosenBase;

  // A range picked on the timeline wins over the base; otherwise the base to
  // the selected change (or the end). The changes the fold reads on each side
  // of the boundary, then their text, then the tree. Files whose text is
  // still on its way join the tree as it lands.
  const from = rangeStart ?? starts[base] ?? 0;
  const to = rangeStart !== null ? rangeEnd : selectedChangeIndex;
  const foldInputs = useMemo(() => selectRangeFoldInputs(changes, from, to), [changes, from, to]);
  const needed = useMemo(() => [...new Set([...foldInputs.base, ...foldInputs.head])], [foldInputs]);
  useFileChangeBodies(conversationId, needed);
  const { files: diffFiles, pending: pendingFiles } = useMemo(
    () => foldReadyFiles(foldInputs, bodies, missingBodies),
    [foldInputs, bodies, missingBodies],
  );

  // Viewed marks: live only while the file's text is the one marked.
  const hashByPath = useMemo(() => new Map(diffFiles.map((f) => [f.filename, f.contentHash])), [diffFiles]);
  const fileMarks = useMemo(() => (path: string) => {
    const hash = hashByPath.get(path);
    return hash && isSeen(seenMarks, path, hash) ? { viewed: true } : undefined;
  }, [hashByPath, seenMarks]);
  const onToggleViewed = useMemo(() => {
    if (!conversationId) return undefined;
    return (path: string) => {
      const hash = hashByPath.get(path);
      if (hash) toggleSeenFile(conversationId, path, hash);
    };
  }, [conversationId, hashByPath]);

  // Line comments in the panel share anchors with the transcript's inline diffs:
  // the same conversation + getRelativePath(file) identity, so a durable thread
  // left in either surface renders in both.
  const commentContextFor = useMemo(() => {
    if (!conversationId || !isConvexId(conversationId)) return undefined;
    return (filename: string) => ({
      conversationId,
      anchorKey: `diffpanel:${filename}`,
      filePath: getRelativePath(filename),
    });
  }, [conversationId]);

  const baseSwitch = conversationId ? (
    <div className="shrink-0">
    <SegmentedToggle
      size="sm"
      value={rangeStart !== null ? "" : base}
      onChange={(key) => setDiffBase(conversationId, key as DiffBase)}
      items={DIFF_BASES.map((b) => ({
        key: b,
        label: BASE_LABELS[b].label,
        title: starts[b] === null ? BASE_UNAVAILABLE[b] : BASE_LABELS[b].title,
        disabled: starts[b] === null,
      }))}
    />
    </div>
  ) : null;

  if (changes.length === 0) {
    return (
      <div className="h-full w-full flex flex-col bg-background">
        <div className="flex items-center justify-end px-2 py-1.5 border-b border-sol-border/50">
          <button
            onClick={() => useDiffViewerStore.getState().setDiffPanelOpen(false)}
            className="p-1 rounded hover:bg-sol-bg-alt text-muted-foreground hover:text-foreground transition-colors"
            title="Close panel"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-lg font-medium">No changes yet</p>
            <p className="text-sm mt-1">
              File changes will appear here as the conversation progresses
            </p>
          </div>
        </div>
      </div>
    );
  }

  const lastShown = to ?? changes.length - 1;
  const positionLabel = (rangeStart !== null
    ? `Changes ${rangeStart + 1} to ${lastShown + 1} of ${changes.length}`
    : from > 0
      ? `Changes ${Math.min(from + 1, changes.length)} to ${lastShown + 1} of ${changes.length}`
      : selectedChangeIndex !== null
        ? `Up to change ${selectedChangeIndex + 1} of ${changes.length}`
        : `All ${changes.length} changes`)
    + (pendingFiles > 0 ? ` · loading ${pendingFiles} ${pendingFiles === 1 ? "file" : "files"}` : "");

  // A changed file's name (tree row or header) opens the same menu as a file
  // link in the transcript: open it, its folder, the sessions that touched it.
  const onFileContextMenu = (e: React.MouseEvent) => {
    if (e.shiftKey) return;
    const path = (e.target as HTMLElement).closest<HTMLElement>("[data-diff-file]")?.dataset.diffFile;
    if (!path) return;
    const ctx = { base: gitRoot ?? undefined, gitRoot };
    requestFilePathMenu(e, { path, href: filePathHref(path, undefined, ctx), ctx });
  };

  return (
    <div className="h-full w-full flex flex-col bg-background" onContextMenu={onFileContextMenu}>
      <FileDiffLayout
        files={diffFiles}
        commentContextFor={commentContextFor}
        headerExtra={baseSwitch}
        emptyState={<p>{rangeStart !== null ? "Nothing changed in the selected range" : BASE_EMPTY[base]}</p>}
        fileMarks={fileMarks}
        onToggleViewed={onToggleViewed}
        focusFile={selectedFile}
        sidebarHeader={
          <div className="px-3 py-2 border-b border-sol-border/50 bg-sol-bg-alt/30">
            <span className="text-xs text-sol-text-dim">{positionLabel}</span>
          </div>
        }
        onCloseDiffPanel={() => useDiffViewerStore.getState().setDiffPanelOpen(false)}
      />
    </div>
  );
}

function ChangesBar({ changes }: { changes: FileChangeEntry[] }) {
  const setDiffPanelOpen = useDiffViewerStore((state) => state.setDiffPanelOpen);

  const uniqueFiles = useMemo(() => {
    const seen = new Set<string>();
    return changes
      .filter((c) => c.changeType !== "commit")
      .filter((c) => {
        if (seen.has(c.filePath)) return false;
        seen.add(c.filePath);
        return true;
      });
  }, [changes]);

  if (uniqueFiles.length === 0) return null;

  const displayFiles = uniqueFiles.slice(0, 5);
  const remaining = uniqueFiles.length - displayFiles.length;

  return (
    <button
      onClick={() => setDiffPanelOpen(true)}
      // --conv-sticky-h (set on the conversation header) pushes the pill below the
      // sticky prompt card so the two never overlap at narrow widths. While pushed
      // down it sits in the message tick rail's band, so it also shifts left
      // (min() saturates at 2.5rem for any visible sticky) to clear the rail.
      style={{
        top: "calc(100% + var(--conv-sticky-h, 0px))",
        right: "calc(0.75rem + min(var(--conv-sticky-h, 0px), 2.5rem))",
      }}
      // No background by design (globals.css .cc-changes-pill): the pill is
      // fully transparent, and its backdrop blur is what keeps the label
      // readable when it floats over body text in a narrow column.
      className="cc-changes-pill absolute mt-2 z-30 flex items-center gap-2 px-2.5 py-1 rounded-md border border-sol-border/50 shadow-sm hover:border-sol-border/80 transition-all group cursor-pointer select-none"
    >
      <div className="flex items-center gap-1">
        {displayFiles.map((f) => (
          <span
            key={f.filePath}
            className="w-1.5 h-1.5 rounded-full flex-shrink-0 opacity-60"
            style={{ backgroundColor: getFileColor(f.filePath) }}
          />
        ))}
        {remaining > 0 && (
          <span className="text-[10px] text-sol-text-dim">+{remaining}</span>
        )}
      </div>
      {/* The label hides when the COLUMN is narrow, not when the window is.
          The old sm: breakpoints are viewport-based, so a 290px conversation
          column on a wide screen still rendered the full-length label and
          covered that much more text. */}
      <span className="text-[11px] text-sol-text-dim group-hover:text-sol-text-secondary transition-colors">
        {uniqueFiles.length}
        <span className="cc-changes-pill__label"> file{uniqueFiles.length !== 1 ? "s" : ""} changed</span>
      </span>
      <svg className="w-3 h-3 text-sol-text-dim/60 group-hover:text-sol-text-dim transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}

function getFileColor(filePath: string): string {
  const colors = [
    "#3b82f6", // blue
    "#10b981", // green
    "#f59e0b", // amber
    "#ef4444", // red
    "#8b5cf6", // purple
    "#ec4899", // pink
    "#06b6d4", // cyan
    "#f97316", // orange
  ];

  let hash = 0;
  for (let i = 0; i < filePath.length; i++) {
    hash = filePath.charCodeAt(i) + ((hash << 5) - hash);
  }

  return colors[Math.abs(hash) % colors.length];
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function TimelineStrip({ conversationRef }: { conversationRef: React.RefObject<ConversationViewHandle | null> }) {
  const { changes, selectedChangeIndex, rangeStart, rangeEnd, selectChange, selectRange, syncScroll } = useDiffViewerStore();

  const handleDotClick = (index: number, messageId: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      if (selectedChangeIndex !== null && selectedChangeIndex !== index) {
        selectRange(selectedChangeIndex, index);
      } else {
        selectChange(index);
      }
    } else {
      selectChange(index);
    }

    if (syncScroll && conversationRef.current) {
      conversationRef.current.scrollToMessage(messageId);
    }
  };

  const isInRange = (index: number) => {
    if (rangeStart !== null && rangeEnd !== null) {
      return index >= rangeStart && index <= rangeEnd;
    }
    return false;
  };

  return (
    <TooltipProvider delayDuration={100}>
      <div className="h-full w-full flex flex-col items-center py-4 gap-2 overflow-y-auto relative">
        {changes.map((change, index) => {
          const isSelected = selectedChangeIndex === index;
          const inRange = isInRange(index);
          const fileColor = getFileColor(change.filePath);
          const isCommit = change.changeType === "commit";

          return (
            <Tooltip key={change.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => handleDotClick(index, change.messageId, e)}
                  className={`
                    w-3 h-3 transition-all relative z-10 shrink-0
                    ${isCommit ? "rounded-sm" : "rounded-full"}
                    ${isSelected ? "scale-150 ring-2 ring-primary/50" : "hover:scale-125"}
                    ${inRange && !isSelected ? "ring-1 ring-primary/30" : ""}
                  `}
                  style={{ backgroundColor: fileColor }}
                />
              </TooltipTrigger>
              <TooltipContent side="right" className="bg-popover text-popover-foreground border-border shadow-md">
                <div className="font-medium">
                  {isCommit ? "Git commit" : getFileName(change.filePath)}
                </div>
                <div className="text-muted-foreground mt-0.5 flex items-center gap-1.5">
                  <span className="capitalize">{change.changeType}</span>
                  <span className="text-muted-foreground/50">-</span>
                  <span>{formatTimeAgo(change.timestamp)}</span>
                </div>
                {isCommit && change.commitMessage && (
                  <div className="text-muted-foreground mt-1 max-w-[200px] truncate">
                    {change.commitMessage}
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
        {rangeStart !== null && rangeEnd !== null && (
          <div
            className="absolute w-1 bg-primary/20 left-1/2 -translate-x-1/2 rounded-full z-0"
            style={{
              top: `${(rangeStart / changes.length) * 100}%`,
              height: `${((rangeEnd - rangeStart) / changes.length) * 100}%`,
            }}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

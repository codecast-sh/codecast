import { useState, useRef, useMemo } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { Panel, Group, Separator } from "react-resizable-panels";
import { ConversationView, ConversationData, ConversationViewHandle } from "./ConversationView";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { extractFileChanges } from "../lib/fileChangeExtractor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { FileDiffLayout, DiffFile } from "./FileDiffLayout";
import type { FileChange } from "../store/diffViewerStore";
import { useInboxStore } from "../store/inboxStore";

const MOBILE_BREAKPOINT = 768;
const DEFAULT_DIFF_LAYOUT = { content: 40, diff: 60 };

type Layout = { [key: string]: number };

interface ConversationDiffLayoutProps {
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
  highlightQuery?: string;
  onClearHighlight?: () => void;
  targetMessageId?: string;
  isOwner?: boolean;
  showMessageInput?: boolean;
  onSendAndAdvance?: () => void;
  onSendAndDismiss?: () => void;
  autoFocusInput?: boolean;
  backHref?: string;
  fallbackStickyContent?: string | null;
  onBack?: () => void;
  subHeaderContent?: React.ReactNode;
}

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
  highlightQuery,
  targetMessageId,
  onClearHighlight,
  isOwner,
  showMessageInput,
  onSendAndAdvance,
  onSendAndDismiss,
  autoFocusInput,
  backHref: backHrefProp,
  fallbackStickyContent,
  onBack,
  subHeaderContent,
}: ConversationDiffLayoutProps) {
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

  useWatchEffect(() => {
    if (conversation?.messages) {
      const extractedChanges = extractFileChanges(conversation.messages as any);
      setChanges(extractedChanges);
    }
  }, [conversation?.messages, setChanges]);

  useMountEffect(() => {
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
  });

  useEventListener("resize", () => {
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
  });

  useEventListener("keydown", (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

    if (isInput) return;

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

  const handleLayoutChange = (newLayout: Layout) => {
    updateLayout("conversation_diff", { content: newLayout["content-panel"] || 40, diff: newLayout["diff-panel"] || 60 });
  };

  const changesOverlay = changes.length > 0 && !diffPanelOpen ? <ChangesBar changes={changes} /> : null;
  const combinedHeaderExtra = changesOverlay ? (
    <>
      {headerExtra}
      {changesOverlay}
    </>
  ) : headerExtra;

  const conversationViewProps = {
    ref: conversationRef,
    conversation,
    backHref: backHrefProp || "/dashboard",
    headerExtra: combinedHeaderExtra,
    headerLeft,
    headerEnd,
    commits: commits || [],
    pullRequests: pullRequests || [],
    hasMoreAbove,
    hasMoreBelow,
    isLoadingOlder,
    isLoadingNewer,
    onLoadOlder,
    onLoadNewer,
    onJumpToStart,
    onJumpToEnd,
    highlightQuery,
    onClearHighlight,
    embedded,
    targetMessageId,
    isOwner,
    showMessageInput,
    onSendAndAdvance,
    onSendAndDismiss,
    autoFocusInput,
    fallbackStickyContent,
    onBack,
    subHeaderContent,
  };

  // Mobile: tabs layout
  if (isMobile) {
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
            <DiffPane />
          </TabsContent>
        </Tabs>
      </div>
    );
  }

  // Desktop: diff panel closed - simple layout
  if (!diffPanelOpen) {
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
        <Separator className="w-1 bg-sol-border hover:bg-sol-cyan data-[resize-handle-active]:bg-sol-cyan cursor-col-resize transition-colors" />

        {/* Timeline + Diff Panel */}
        <Panel id="diff-panel" minSize={20}>
          <div className="h-full flex">
            {/* Timeline Strip */}
            <div className="w-10 h-full border-r border-sol-border bg-sol-bg-alt/30 relative flex-shrink-0">
              <TimelineStrip conversationRef={conversationRef} />
            </div>
            {/* Diff Content */}
            <div className="flex-1 h-full min-w-0">
              <DiffPane />
            </div>
          </div>
        </Panel>
      </Group>

    </div>
  );
}

function computeCumulativeFiles(changes: FileChange[], upToIndex: number | null): DiffFile[] {
  const endIndex = upToIndex !== null ? upToIndex : changes.length - 1;
  if (endIndex < 0) return [];

  const relevantChanges = changes.slice(0, endIndex + 1).filter(c => c.changeType !== "commit");

  const fileGroups = new Map<string, { changes: FileChange[]; lastGlobalIdx: number }>();
  relevantChanges.forEach((change, idx) => {
    const existing = fileGroups.get(change.filePath);
    if (existing) {
      existing.changes.push(change);
      existing.lastGlobalIdx = idx;
    } else {
      fileGroups.set(change.filePath, { changes: [change], lastGlobalIdx: idx });
    }
  });

  const files: (DiffFile & { lastIndex: number })[] = [];

  for (const [filePath, { changes: fileChanges, lastGlobalIdx }] of fileGroups) {
    let currentContent: string | undefined;
    let originalContent: string | undefined;
    let hasFullContent = false;
    let isNewFile = false;

    for (const change of fileChanges) {
      if (change.changeType === "write") {
        if (originalContent === undefined) {
          originalContent = "";
          isNewFile = true;
        }
        currentContent = change.newContent;
        hasFullContent = true;
      } else if (change.changeType === "edit") {
        if (hasFullContent && currentContent !== undefined && change.oldContent) {
          const idx = currentContent.indexOf(change.oldContent);
          if (idx !== -1) {
            currentContent =
              currentContent.slice(0, idx) +
              change.newContent +
              currentContent.slice(idx + change.oldContent.length);
          }
        } else if (!hasFullContent) {
          if (currentContent === undefined) {
            originalContent = change.oldContent || "";
            currentContent = change.newContent;
          } else if (change.oldContent) {
            const idx = currentContent.indexOf(change.oldContent);
            if (idx !== -1) {
              if (originalContent !== undefined) {
                const origIdx = originalContent.indexOf(change.oldContent);
                if (origIdx !== -1) {
                  originalContent =
                    originalContent.slice(0, origIdx) +
                    change.oldContent +
                    originalContent.slice(origIdx + change.oldContent.length);
                } else {
                  originalContent += "\n" + change.oldContent;
                }
              }
              currentContent =
                currentContent.slice(0, idx) +
                change.newContent +
                currentContent.slice(idx + change.oldContent.length);
            } else {
              originalContent = (originalContent || "") + "\n" + change.oldContent;
              currentContent = currentContent + "\n" + change.newContent;
            }
          }
        }
      }
    }

    if (currentContent === undefined) continue;

    const oldStr = originalContent || "";
    const newStr = currentContent;

    if (oldStr === newStr) continue;

    const patch = generateUnifiedPatch(filePath, oldStr, newStr);
    const patchLines = patch.split('\n');
    const additions = patchLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    const deletions = patchLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;

    files.push({
      filename: filePath,
      status: isNewFile ? "added" : "modified",
      additions,
      deletions,
      changes: additions + deletions,
      patch,
      lastIndex: lastGlobalIdx,
    });
  }

  files.sort((a, b) => b.lastIndex - a.lastIndex);

  return files.map(({ lastIndex, ...file }) => file);
}

function generateUnifiedPatch(filename: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let patch = `--- a/${filename}\n+++ b/${filename}\n`;

  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diff: Array<{ type: "add" | "del" | "ctx"; line: string }> = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: "ctx", line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: "add", line: newLines[j - 1] });
      j--;
    } else {
      diff.unshift({ type: "del", line: oldLines[i - 1] });
      i--;
    }
  }

  let hunkStart = -1;
  let hunkLines: string[] = [];
  let oldStart = 1, newStart = 1, oldCount = 0, newCount = 0;

  const flushHunk = () => {
    if (hunkLines.length > 0) {
      patch += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
      patch += hunkLines.join("\n") + "\n";
      hunkLines = [];
    }
  };

  let currentOldLine = 1, currentNewLine = 1;
  let lastChangeIdx = -1;

  diff.forEach((d, idx) => {
    const isChange = d.type !== "ctx";

    if (isChange) {
      if (hunkStart === -1 || idx > lastChangeIdx + 4) {
        flushHunk();
        const contextStart = Math.max(0, idx - 3);
        hunkStart = contextStart;
        oldStart = currentOldLine - (idx - contextStart);
        newStart = currentNewLine - (idx - contextStart);
        oldCount = 0;
        newCount = 0;

        for (let k = contextStart; k < idx; k++) {
          const prev = diff[k];
          if (prev.type === "ctx") {
            hunkLines.push(" " + prev.line);
            oldCount++;
            newCount++;
          }
        }
      }
      lastChangeIdx = idx;
    }

    if (hunkStart !== -1 && idx <= lastChangeIdx + 3) {
      if (d.type === "add") {
        hunkLines.push("+" + d.line);
        newCount++;
      } else if (d.type === "del") {
        hunkLines.push("-" + d.line);
        oldCount++;
      } else {
        hunkLines.push(" " + d.line);
        oldCount++;
        newCount++;
      }
    }

    if (d.type === "del") currentOldLine++;
    else if (d.type === "add") currentNewLine++;
    else { currentOldLine++; currentNewLine++; }
  });

  flushHunk();

  return patch;
}

function DiffPane() {
  const { selectedChangeIndex, changes } = useDiffViewerStore();

  const diffFiles = useMemo(() => {
    return computeCumulativeFiles(changes, selectedChangeIndex);
  }, [changes, selectedChangeIndex]);

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

  const positionLabel = selectedChangeIndex !== null
    ? `Up to change ${selectedChangeIndex + 1} of ${changes.length}`
    : `All ${changes.length} changes`;

  return (
    <div className="h-full w-full flex flex-col bg-background">
      <FileDiffLayout
        files={diffFiles}
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

function ChangesBar({ changes }: { changes: FileChange[] }) {
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
      className="absolute top-full right-0 mt-2 mr-3 z-30 flex items-center gap-2 px-2.5 py-1 rounded-md bg-sol-bg-alt/80 backdrop-blur-sm border border-sol-border/40 shadow-sm hover:border-sol-border/70 hover:bg-sol-bg-alt/95 transition-all group cursor-pointer select-none"
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
      <span className="text-[11px] text-sol-text-dim group-hover:text-sol-text-secondary transition-colors">
        <span className="sm:hidden">{uniqueFiles.length}</span>
        <span className="hidden sm:inline">{uniqueFiles.length} file{uniqueFiles.length !== 1 ? "s" : ""} changed</span>
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

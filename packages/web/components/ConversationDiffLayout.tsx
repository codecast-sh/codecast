"use client";

import { useState, useEffect, useRef } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { ConversationView, ConversationData, ConversationViewHandle } from "./ConversationView";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { extractFileChanges } from "../lib/fileChangeExtractor";
import { Keyboard } from "lucide-react";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { KeyboardShortcutsHelp } from "./KeyboardShortcutsHelp";
import { FileTreeSidebar } from "./FileTreeSidebar";
import { DiffView } from "./DiffView";
import type { FileChange } from "../store/diffViewerStore";

interface ConversationDiffLayoutProps {
  conversation: ConversationData;
  embedded?: boolean;
}

const STORAGE_KEY = "conversation-diff-layout";
const MOBILE_BREAKPOINT = 768;

const getInitialLayout = (): number[] => {
  if (typeof window === 'undefined') return [40, 60];
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length === 2) {
        return parsed;
      }
    } catch {}
  }
  return [40, 60];
};

export function ConversationDiffLayout({
  conversation,
  embedded,
}: ConversationDiffLayoutProps) {
  const heightClass = embedded ? "h-full" : "h-screen";
  const [isMobile, setIsMobile] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [layout, setLayout] = useState(getInitialLayout);
  const conversationRef = useRef<ConversationViewHandle>(null);

  const {
    changes,
    nextChange,
    prevChange,
    toggleDiffMode,
    toggleFileTree,
    clearSelection,
    setChanges
  } = useDiffViewerStore();

  useEffect(() => {
    if (conversation?.messages) {
      const extractedChanges = extractFileChanges(conversation.messages as any);
      setChanges(extractedChanges);
    }
  }, [conversation?.messages, setChanges]);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
          e.preventDefault();
          toggleDiffMode();
          break;
        case "f":
          e.preventDefault();
          toggleFileTree();
          break;
        case "Escape":
          e.preventDefault();
          clearSelection();
          break;
        case "?":
          e.preventDefault();
          setShowHelp((prev) => !prev);
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nextChange, prevChange, toggleDiffMode, toggleFileTree, clearSelection]);

  const handleLayoutChange = (sizes: number[]) => {
    setLayout(sizes);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  };

  if (isMobile) {
    return (
      <div className={`${heightClass} w-full`}>
        <Tabs defaultValue="conversation" className="h-full flex flex-col">
          <TabsList className="grid w-full grid-cols-2 shrink-0">
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
            <TabsTrigger value="diff">
              Diff {changes.length > 0 && `(${changes.length})`}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="conversation" className="flex-1 overflow-auto m-0">
            <ConversationView
              ref={conversationRef}
              conversation={conversation}
              backHref="/dashboard"
            />
          </TabsContent>
          <TabsContent value="diff" className="flex-1 overflow-auto m-0">
            <DiffPane />
          </TabsContent>
        </Tabs>
      </div>
    );
  }

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
          <div className="h-full relative">
            <ConversationView
              ref={conversationRef}
              conversation={conversation}
              backHref="/dashboard"
            />
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
            <div className="flex-1 h-full relative min-w-0">
              <DiffPane />
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-2 right-2 z-10 h-6 w-6 opacity-50 hover:opacity-100"
                onClick={() => setShowHelp(true)}
                title="Keyboard shortcuts (?)"
              >
                <Keyboard className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Panel>
      </Group>

      <KeyboardShortcutsHelp isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
}

function getFileExtension(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    cpp: "cpp", c: "c", h: "c", hpp: "cpp", cs: "csharp",
    json: "json", yaml: "yaml", yml: "yaml", md: "markdown",
    html: "html", css: "css", scss: "scss", sql: "sql",
    sh: "bash", bash: "bash", zsh: "bash",
  };
  return ext ? langMap[ext] : undefined;
}

function DiffPane() {
  const { selectedChangeIndex, rangeStart, rangeEnd, changes, getCurrentDiffContent, showFileTree } = useDiffViewerStore();

  const diffContent = getCurrentDiffContent();

  if (changes.length === 0) {
    return (
      <div className="h-full w-full flex bg-background">
        {showFileTree && <FileTreeSidebar getFileColor={getFileColor} />}
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

  if (!diffContent) {
    return (
      <div className="h-full w-full flex bg-background">
        {showFileTree && <FileTreeSidebar getFileColor={getFileColor} />}
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <p>Select a change from the timeline to view diff</p>
        </div>
      </div>
    );
  }

  const getRangeDisplay = () => {
    if (rangeStart !== null && rangeEnd !== null) {
      return `Changes ${rangeStart + 1}-${rangeEnd + 1} of ${changes.length}`;
    }
    return `Change ${selectedChangeIndex! + 1} of ${changes.length}`;
  };

  const selectedChange = selectedChangeIndex !== null ? changes[selectedChangeIndex] : null;
  const isCommit = selectedChange?.changeType === "commit";

  if (isCommit) {
    return (
      <div className="h-full w-full flex bg-background">
        {showFileTree && <FileTreeSidebar getFileColor={getFileColor} />}
        <div className="flex-1 overflow-auto">
          <div className="p-4">
            <div className="mb-4 pb-2 border-b">
              <h3 className="font-mono text-sm font-medium flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm bg-primary/70"></span>
                Git Commit
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                {getRangeDisplay()}
              </p>
            </div>

            <div className="space-y-4">
              <div className="rounded border border-border bg-muted/30 p-4">
                <div className="text-xs text-muted-foreground mb-2">Commit Message</div>
                <div className="font-mono text-sm whitespace-pre-wrap">
                  {selectedChange.commitMessage}
                </div>
                {selectedChange.commitHash && (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <div className="text-xs text-muted-foreground">Hash</div>
                    <div className="font-mono text-xs text-primary mt-1">
                      {selectedChange.commitHash}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const language = getFileExtension(diffContent.filePath);

  return (
    <div className="h-full w-full flex bg-background">
      {showFileTree && <FileTreeSidebar getFileColor={getFileColor} />}
      <div className="flex-1 overflow-auto">
        <div className="p-4">
          <div className="mb-4 pb-2 border-b">
            <h3 className="font-mono text-sm font-medium">{diffContent.filePath}</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {getRangeDisplay()}
            </p>
          </div>

          <div className="rounded overflow-hidden border border-sol-border/30 bg-sol-bg-alt">
            <DiffView
              oldStr={diffContent.oldContent || ""}
              newStr={diffContent.newContent}
              language={language}
              contextLines={3}
              maxLines={50}
            />
          </div>
        </div>
      </div>
    </div>
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
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

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
    <div className="h-full w-full flex flex-col items-center py-4 gap-2 overflow-y-auto relative">
      {changes.map((change, index) => {
        const isSelected = selectedChangeIndex === index;
        const inRange = isInRange(index);
        const fileColor = getFileColor(change.filePath);
        const isCommit = change.changeType === "commit";
        const isHovered = hoveredIndex === index;

        return (
          <div key={change.id} className="relative shrink-0">
            <button
              onClick={(e) => handleDotClick(index, change.messageId, e)}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              className={`
                w-3 h-3 transition-all relative z-10
                ${isCommit ? "rounded-sm" : "rounded-full"}
                ${isSelected ? "scale-150 ring-2 ring-primary/50" : "hover:scale-125"}
                ${inRange && !isSelected ? "ring-1 ring-primary/30" : ""}
              `}
              style={{ backgroundColor: fileColor }}
            />
            {isHovered && (
              <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 pointer-events-none">
                <div className="bg-popover text-popover-foreground border border-border rounded-md shadow-lg px-2.5 py-1.5 text-xs whitespace-nowrap">
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
                </div>
              </div>
            )}
          </div>
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
  );
}

"use client";

import { useState, useEffect, useRef } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { ConversationView, ConversationData, ConversationViewHandle } from "./ConversationView";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { extractFileChanges } from "../lib/fileChangeExtractor";
import { ChevronLeft, ChevronRight, Keyboard, Link as LinkIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { KeyboardShortcutsHelp } from "./KeyboardShortcutsHelp";
import { FileTreeSidebar } from "./FileTreeSidebar";
import { DiffView } from "./DiffView";

interface ConversationDiffLayoutProps {
  conversation: ConversationData;
  embedded?: boolean;
}

const STORAGE_KEY = "conversation-diff-layout";
const MOBILE_BREAKPOINT = 768;

export function ConversationDiffLayout({
  conversation,
  embedded,
}: ConversationDiffLayoutProps) {
  const heightClass = embedded ? "h-[calc(100vh-56px)]" : "h-screen";
  const [isMobile, setIsMobile] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const conversationRef = useRef<ConversationViewHandle>(null);

  const {
    selectedChangeIndex,
    changes,
    nextChange,
    prevChange,
    toggleDiffMode,
    toggleFileTree,
    clearSelection,
    syncScroll,
    toggleSyncScroll,
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

  const handleLayoutChange = (layout: Record<string, number>) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  };

  const getDefaultLayout = (): Record<string, number> | undefined => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        // fallback to defaults
      }
    }
    return undefined;
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
      <PanelGroup
        orientation="horizontal"
        onLayoutChange={handleLayoutChange}
        defaultLayout={getDefaultLayout()}
        className="h-full"
      >
        {!leftCollapsed && (
          <>
            <Panel
              defaultSize={40}
              minSize={20}
              maxSize={70}
              id="conversation-panel"
            >
              <div className="h-full relative">
                <ConversationView
                  ref={conversationRef}
                  conversation={conversation}
                  backHref="/dashboard"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 z-10 h-6 w-6 opacity-50 hover:opacity-100"
                  onClick={() => setLeftCollapsed(true)}
                  title="Collapse conversation panel"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </div>
            </Panel>
            <PanelResizeHandle className="w-1 bg-border hover:bg-primary/20 transition-colors cursor-col-resize" />
          </>
        )}

        {/* Timeline Panel */}
        <Panel
          defaultSize={3}
          minSize={2}
          maxSize={5}
          id="timeline-panel"
          className="relative"
        >
          <div className="h-full border-x border-border bg-muted/30 relative">
            <TimelineStrip conversationRef={conversationRef} />
            {/* Sync Scroll Toggle Button */}
            <Button
              variant="ghost"
              size="icon"
              className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-20 h-8 w-8 ${syncScroll ? "text-primary" : "text-muted-foreground"}`}
              onClick={toggleSyncScroll}
              title={syncScroll ? "Disable scroll sync" : "Enable scroll sync"}
            >
              <LinkIcon className={`h-4 w-4 ${syncScroll ? "" : "opacity-50"}`} />
            </Button>
          </div>
        </Panel>

        <PanelResizeHandle className="w-1 bg-border hover:bg-primary/20 transition-colors cursor-col-resize" />

        {!rightCollapsed && (
          <Panel
            defaultSize={57}
            minSize={30}
            maxSize={80}
            id="diff-panel"
          >
            <div className="h-full relative">
              <DiffPane />
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-2 left-2 z-10 h-6 w-6 opacity-50 hover:opacity-100"
                onClick={() => setRightCollapsed(true)}
                title="Collapse diff panel"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
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
          </Panel>
        )}
      </PanelGroup>

      {/* Collapse buttons for when panels are hidden */}
      {leftCollapsed && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 left-2 z-20 h-8 w-8"
          onClick={() => setLeftCollapsed(false)}
          title="Show conversation panel"
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      )}

      {rightCollapsed && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 z-20 h-8 w-8"
          onClick={() => setRightCollapsed(false)}
          title="Show diff panel"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
      )}

      <KeyboardShortcutsHelp isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
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
    <div className="h-full w-full flex flex-col items-center py-4 gap-2 overflow-y-auto relative">
      {changes.map((change, index) => {
        const isSelected = selectedChangeIndex === index;
        const inRange = isInRange(index);
        const fileColor = getFileColor(change.filePath);
        const isCommit = change.changeType === "commit";

        return (
          <button
            key={change.id}
            onClick={(e) => handleDotClick(index, change.messageId, e)}
            className={`
              w-3 h-3 transition-all shrink-0 relative z-10
              ${isCommit ? "rounded-sm" : "rounded-full"}
              ${isSelected ? "scale-150 ring-2 ring-primary/50" : "hover:scale-125"}
              ${inRange && !isSelected ? "ring-1 ring-primary/30" : ""}
            `}
            style={{ backgroundColor: fileColor }}
            title={isCommit ? `Git commit: ${change.commitMessage}` : `${change.filePath} - ${change.changeType}`}
          />
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

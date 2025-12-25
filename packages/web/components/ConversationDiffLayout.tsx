"use client";

import { useState, useEffect } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { ConversationView, ConversationData } from "./ConversationView";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface ConversationDiffLayoutProps {
  conversation: ConversationData;
}

const STORAGE_KEY = "conversation-diff-layout";
const MOBILE_BREAKPOINT = 768;

export function ConversationDiffLayout({
  conversation,
}: ConversationDiffLayoutProps) {
  const [isMobile, setIsMobile] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const { selectedChangeIndex, changes } = useDiffViewerStore();

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

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
      <div className="h-screen w-full">
        <Tabs defaultValue="conversation" className="h-full flex flex-col">
          <TabsList className="grid w-full grid-cols-2 shrink-0">
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
            <TabsTrigger value="diff">
              Diff {changes.length > 0 && `(${changes.length})`}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="conversation" className="flex-1 overflow-auto m-0">
            <ConversationView
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
    <div className="h-screen w-full relative flex">
      <div className="flex-1 min-w-0">
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
              <PanelResizeHandle className="w-1 bg-border hover:bg-primary/20 transition-colors" />
            </>
          )}

          {!rightCollapsed && (
            <Panel
              defaultSize={60}
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
              </div>
            </Panel>
          )}
        </PanelGroup>
      </div>

      {/* Center - Fixed Timeline Strip (overlaid) */}
      <div className="absolute left-1/2 top-0 bottom-0 -translate-x-1/2 w-[40px] border-x border-border bg-muted/30 z-10 pointer-events-none">
        <div className="pointer-events-auto h-full">
          <TimelineStrip />
        </div>
      </div>

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
    </div>
  );
}

function TimelineStrip() {
  const { changes, selectedChangeIndex, selectChange } = useDiffViewerStore();

  return (
    <div className="h-full w-full flex flex-col items-center py-4 gap-2 overflow-y-auto">
      {changes.map((change, index) => {
        const isSelected = selectedChangeIndex === index;
        const fileColor = getFileColor(change.filePath);

        return (
          <button
            key={change.id}
            onClick={() => selectChange(index)}
            className={`
              w-3 h-3 rounded-full transition-all shrink-0
              ${isSelected ? "scale-150 ring-2 ring-primary/50" : "hover:scale-125"}
            `}
            style={{ backgroundColor: fileColor }}
            title={`${change.filePath} - ${change.changeType}`}
          />
        );
      })}
    </div>
  );
}

function DiffPane() {
  const { selectedChangeIndex, changes, getCurrentDiffContent } = useDiffViewerStore();

  const diffContent = getCurrentDiffContent();

  if (changes.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-lg font-medium">No changes yet</p>
          <p className="text-sm mt-1">
            File changes will appear here as the conversation progresses
          </p>
        </div>
      </div>
    );
  }

  if (!diffContent) {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground">
        <p>Select a change from the timeline to view diff</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto bg-background">
      <div className="p-4">
        <div className="mb-4 pb-2 border-b">
          <h3 className="font-mono text-sm font-medium">{diffContent.filePath}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Change {selectedChangeIndex! + 1} of {changes.length}
          </p>
        </div>

        <div className="space-y-1">
          {diffContent.oldContent && (
            <div className="font-mono text-sm">
              <div className="text-red-600 dark:text-red-400">
                {diffContent.oldContent.split("\n").map((line, i) => (
                  <div key={i} className="hover:bg-red-50 dark:hover:bg-red-950/20">
                    <span className="inline-block w-12 text-right pr-2 text-muted-foreground select-none">
                      {i + 1}
                    </span>
                    <span className="bg-red-100 dark:bg-red-900/30">- {line}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="font-mono text-sm">
            <div className="text-green-600 dark:text-green-400">
              {diffContent.newContent.split("\n").map((line, i) => (
                <div key={i} className="hover:bg-green-50 dark:hover:bg-green-950/20">
                  <span className="inline-block w-12 text-right pr-2 text-muted-foreground select-none">
                    {i + 1}
                  </span>
                  <span className="bg-green-100 dark:bg-green-900/30">+ {line}</span>
                </div>
              ))}
            </div>
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

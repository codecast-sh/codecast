"use client";
import { ReactNode, useState } from "react";
import { Panel, Group, Separator, usePanelRef } from "react-resizable-panels";
import { PanelLeftOpen } from "lucide-react";

const separatorClass = "relative z-10 w-px bg-black/10 cursor-col-resize before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan";

export function DetailSplitLayout({
  list,
  children,
}: {
  list: ReactNode;
  children: ReactNode;
}) {
  const listPanelRef = usePanelRef();
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <Group orientation="horizontal" className="h-full" defaultLayout={{ "detail-list": 30, "detail-content": 70 }}>
      <Panel
        id="detail-list"
        panelRef={listPanelRef}
        minSize={200}
        maxSize="80%"
        collapsible
        collapsedSize={0}
        onResize={(size) => setIsCollapsed(size.asPercentage === 0)}
        className="overflow-hidden"
      >
        <div className="h-full cq-container">{list}</div>
      </Panel>
      <Separator className={separatorClass}>
        {isCollapsed && (
          <button
            onClick={(e) => { e.stopPropagation(); listPanelRef.current?.expand(); }}
            className="absolute top-3 -right-px z-20 p-1.5 bg-sol-bg-alt border border-sol-border/40 border-l-0 rounded-r-md text-sol-text-dim hover:text-sol-cyan transition-colors shadow-sm"
            title="Show list"
          >
            <PanelLeftOpen className="w-3.5 h-3.5" />
          </button>
        )}
      </Separator>
      <Panel id="detail-content" minSize={100} className="overflow-hidden">
        {children}
      </Panel>
    </Group>
  );
}

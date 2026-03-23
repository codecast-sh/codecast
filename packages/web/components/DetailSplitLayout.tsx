"use client";
import { ReactNode } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";

const separatorClass = "relative z-10 w-px bg-black/10 cursor-col-resize before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan";

export function DetailSplitLayout({
  list,
  children,
}: {
  list: ReactNode;
  children: ReactNode;
}) {
  return (
    <Group orientation="horizontal" className="h-full" defaultLayout={{ "detail-list": 30, "detail-content": 70 }}>
      <Panel id="detail-list" minSize={30} maxSize="80%" className="overflow-hidden">
        <div className="h-full cq-container">{list}</div>
      </Panel>
      <Separator className={separatorClass} />
      <Panel id="detail-content" minSize={100} className="overflow-hidden">
        {children}
      </Panel>
    </Group>
  );
}

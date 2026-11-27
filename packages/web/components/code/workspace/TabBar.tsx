// One editor group's tab strip. A preview tab is italic and is replaced by the
// next preview open; a double click (or editing) keeps it. A pinned tab sits
// at the left with a pin and no close button. A dirty tab shows a dot where
// its close button is, and the button on hover. Middle click closes; tabs drag
// to reorder and between groups; the strip scrolls sideways with the active
// tab kept in view.

import { memo, useMemo, useRef, useState } from "react";
import { File, FileStack, FileText, Image as ImageIcon, Pin, SquareSplitHorizontal, X } from "lucide-react";
import { isVaultAssetPath, isVaultMarkdownPath } from "@codecast/shared/contracts";
import { bufferKey, useCodeStore } from "../../../store/codeStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useIsNewFile } from "../../../lib/code/newFiles";
import { isVirtualTab, virtualTabTitle } from "../../../lib/code/workspace/virtualTabs";
import { ContextMenu, CtxItem, CtxSeparator, useContextMenu } from "../../ui/context-menu";
import { withShortcut } from "../../../shortcuts";
import type { WsGroup, WsTab } from "../../../lib/code/workspace/model";
import { PresenceDot } from "../agent/PresenceDot";
import { endTabDrag, isDraggingTab, startTabDrag, takeTabDrag } from "../../../lib/code/workspace/tabDrag";

const DRAG_TYPE = "application/x-codecast-tab";

export interface TabBarProps {
  vaultId: string;
  group: WsGroup;
  focused: boolean;
  /** Room for the page's corner toggles. */
  leftInset: boolean;
  rightInset: boolean;
  canSplit: boolean;
  /** Each takes the group, so one stable set serves every group. */
  onActivate(groupId: string, path: string): void;
  onClose(groupId: string, path: string): void;
  onKeep(groupId: string, path: string): void;
  onMove(fromGroupId: string, path: string, toGroupId: string, toIndex: number): void;
  onMenu(groupId: string, action: TabMenuAction, path: string): void;
  onSplit(groupId: string): void;
}

/** A tab's handlers: one object per strip that never changes, so a tab
 *  re-renders only when its own props do. */
interface TabEvents {
  activate(path: string): void;
  close(path: string): void;
  keep(path: string): void;
  context(e: React.MouseEvent, path: string): void;
  dragStart(e: React.DragEvent, path: string): void;
  dragOver(e: React.DragEvent, path: string): void;
  drop(e: React.DragEvent, path: string): void;
}

export type TabMenuAction = "close" | "closeOthers" | "closeRight" | "pin" | "keep" | "splitRight" | "copyPath" | "copyRelative" | "reveal";

function tabIcon(path: string) {
  const cls = "h-3.5 w-3.5 shrink-0 opacity-60";
  if (isVirtualTab(path)) return <FileStack className={cls} />;
  if (isVaultMarkdownPath(path)) return <FileText className={cls} />;
  if (isVaultAssetPath(path)) return <ImageIcon className={cls} />;
  return <File className={cls} />;
}

const nameOf = (path: string) => (isVirtualTab(path) ? virtualTabTitle(path) : path.slice(path.lastIndexOf("/") + 1));

/** Width of the fade over a clipped edge of the strip. */
const FADE_PX = 28;

/** Fade whichever edges hide tabs. */
function paintClip(strip: HTMLElement): void {
  const left = strip.scrollLeft > 1;
  const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
  const clip = left && right ? "both" : left ? "left" : right ? "right" : "";
  if ((strip.dataset.clip ?? "") === clip) return;
  if (clip) strip.dataset.clip = clip;
  else delete strip.dataset.clip;
  const l = left ? `transparent 0, #000 ${FADE_PX}px` : "#000 0";
  const r = right ? `#000 calc(100% - ${FADE_PX}px), transparent 100%` : "#000 100%";
  const mask = clip ? `linear-gradient(to right, ${l}, ${r})` : "";
  strip.style.maskImage = mask;
  strip.style.webkitMaskImage = mask;
}

/** Scroll the strip (never the page) so the tab sits fully outside the fades. */
function revealTab(strip: HTMLElement, tab: HTMLElement): void {
  const start = tab.offsetLeft;
  const end = start + tab.offsetWidth;
  const first = tab === strip.firstElementChild;
  const last = !tab.nextElementSibling || !(tab.nextElementSibling as HTMLElement).dataset.tabPath;
  if (start - (first ? 0 : FADE_PX) < strip.scrollLeft) strip.scrollLeft = first ? 0 : start - FADE_PX;
  else if (end + (last ? 0 : FADE_PX) > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = last ? strip.scrollWidth : end + FADE_PX - strip.clientWidth;
}

const Tab = memo(function Tab({
  vaultId,
  tab,
  active,
  focused,
  duplicateName,
  dropBefore,
  events,
}: {
  vaultId: string;
  tab: WsTab;
  active: boolean;
  focused: boolean;
  duplicateName: boolean;
  dropBefore: boolean;
  events: TabEvents;
}) {
  const dirty = useCodeStore((s) => !!s.dirty[bufferKey(vaultId, tab.path)]);
  const isNew = useIsNewFile(bufferKey(vaultId, tab.path));
  const name = nameOf(tab.path);
  const dir = duplicateName ? tab.path.slice(0, Math.max(0, tab.path.length - name.length - 1)).split("/").pop() : null;
  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-path={tab.path}
      draggable
      title={isNew ? `${tab.path} (new file, created on save)` : tab.path}
      data-new-file={isNew || undefined}
      onMouseDown={(e) => {
        if (e.button === 0) events.activate(tab.path);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          events.close(tab.path);
        }
      }}
      onDoubleClick={() => events.keep(tab.path)}
      onContextMenu={(e) => events.context(e, tab.path)}
      onDragStart={(e) => events.dragStart(e, tab.path)}
      onDragOver={(e) => events.dragOver(e, tab.path)}
      onDrop={(e) => events.drop(e, tab.path)}
      onDragEnd={endTabDrag}
      className={`group/tab relative flex h-full shrink-0 cursor-default select-none items-center gap-1.5 border-r border-sol-border/30 pl-2.5 pr-1 text-meta transition-colors ${
        active ? "bg-sol-bg text-sol-text" : "text-sol-text-dim hover:bg-sol-bg/50 hover:text-sol-text-muted"
      }`}
    >
      {active && <span className={`absolute inset-x-0 top-0 h-px ${focused ? "bg-sol-cyan" : "bg-sol-border"}`} />}
      {active && <span className="absolute inset-x-0 -bottom-px h-px bg-sol-bg" />}
      {dropBefore && <span className="absolute inset-y-1 -left-px w-0.5 rounded bg-sol-cyan" />}
      {tab.pinned ? <Pin className="h-3 w-3 shrink-0 -rotate-45 text-sol-text-dim" /> : tabIcon(tab.path)}
      <span className={`whitespace-nowrap ${tab.preview ? "italic" : ""}`}>{name}</span>
      {dir && <span className="max-w-[12ch] truncate text-sol-text-dim/80">{dir}</span>}
      {isNew && <span className="shrink-0 rounded-sm bg-sol-green/15 px-1 text-mark leading-4 text-sol-green">new</span>}
      {!isVirtualTab(tab.path) && <PresenceDot vaultId={vaultId} path={tab.path} />}
      {tab.pinned && !dirty ? (
        <span className="w-1" />
      ) : (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Close ${name}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            events.close(tab.path);
          }}
          className="relative flex size-[18px] shrink-0 items-center justify-center rounded text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"
        >
          {dirty && <span className="absolute size-2 rounded-full bg-sol-text-muted group-hover/tab:hidden" />}
          <X className={`h-3 w-3 ${dirty ? "invisible group-hover/tab:visible" : active ? "" : "invisible group-hover/tab:visible"}`} />
        </button>
      )}
    </div>
  );
});

export const TabBar = memo(function TabBar({
  vaultId,
  group,
  focused,
  leftInset,
  rightInset,
  canSplit,
  onActivate,
  onClose,
  onKeep,
  onMove,
  onMenu,
  onSplit,
}: TabBarProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const menu = useContextMenu<string>();

  // Keep the active tab in view, clear of the fades, as it changes or the
  // strip overflows.
  useWatchEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const tabs = strip.querySelectorAll<HTMLElement>("[data-tab-path]");
    const el = [...tabs].find((t) => t.dataset.tabPath === group.active);
    const reveal = () => {
      if (el) revealTab(strip, el);
      paintClip(strip);
    };
    reveal();
    // The tab can grow after it is shown (its "new" or dirty mark arriving).
    const ro = el && typeof ResizeObserver === "function" ? new ResizeObserver(reveal) : null;
    if (el) ro?.observe(el);
    return () => ro?.disconnect();
  }, [group.active, group.tabs.length]);

  // A fade on each edge the strip clips, written straight to the element on
  // scroll and resize: no render for either.
  useWatchEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const paint = () => paintClip(strip);
    paint();
    strip.addEventListener("scroll", paint, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(paint) : null;
    ro?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", paint);
      ro?.disconnect();
    };
  }, []);

  const names = new Map<string, number>();
  for (const t of group.tabs) names.set(nameOf(t.path), (names.get(nameOf(t.path)) ?? 0) + 1);

  const indexOf = (path: string) => group.tabs.findIndex((t) => t.path === path);
  const dropIndex = (e: React.DragEvent, path: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return indexOf(path) + (e.clientX > r.left + r.width / 2 ? 1 : 0);
  };
  const accept = (e: React.DragEvent) => {
    if (!isDraggingTab()) return false;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    return true;
  };
  const drop = (index: number) => {
    const d = takeTabDrag();
    setDropAt(null);
    if (d) onMove(d.groupId, d.path, group.id, index);
  };

  const latest = useRef({ group, accept, drop, dropIndex, menu, onActivate, onClose, onKeep });
  latest.current = { group, accept, drop, dropIndex, menu, onActivate, onClose, onKeep };
  const events = useMemo<TabEvents>(
    () => ({
      activate: (path) => latest.current.onActivate(latest.current.group.id, path),
      close: (path) => latest.current.onClose(latest.current.group.id, path),
      keep: (path) => latest.current.onKeep(latest.current.group.id, path),
      context: (e, path) => latest.current.menu.open(e, path, { force: true }),
      dragStart: (e, path) => {
        startTabDrag({ groupId: latest.current.group.id, path });
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(DRAG_TYPE, path);
        e.dataTransfer.setData("text/plain", path);
      },
      dragOver: (e, path) => {
        if (latest.current.accept(e)) setDropAt(latest.current.dropIndex(e, path));
      },
      drop: (e, path) => {
        if (!isDraggingTab()) return;
        e.preventDefault();
        e.stopPropagation();
        latest.current.drop(latest.current.dropIndex(e, path));
      },
    }),
    [],
  );

  return (
    <div
      role="tablist"
      className={`flex h-8 shrink-0 items-stretch border-b border-sol-border/30 bg-sol-bg-alt/50 ${leftInset ? "pl-9" : ""} ${rightInset ? "pr-9" : ""}`}
    >
      <div
        ref={stripRef}
        className="relative flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onWheel={(e) => {
          // A vertical wheel scrolls the strip sideways.
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
        onDragOver={(e) => {
          if (accept(e) && e.target === e.currentTarget) setDropAt(group.tabs.length);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
        }}
        onDrop={(e) => {
          if (!isDraggingTab()) return;
          e.preventDefault();
          drop(e.target === e.currentTarget ? group.tabs.length : (dropAt ?? group.tabs.length));
        }}
      >
        {group.tabs.map((t, i) => (
          <Tab
            key={t.path}
            vaultId={vaultId}
            tab={t}
            active={t.path === group.active}
            focused={focused}
            duplicateName={(names.get(nameOf(t.path)) ?? 0) > 1}
            dropBefore={dropAt === i}
            events={events}
          />
        ))}
        {dropAt === group.tabs.length && <span className="my-1 w-0.5 shrink-0 rounded bg-sol-cyan" />}
      </div>
      {canSplit && group.active && (
        <>
          <span className="my-auto h-4 w-px shrink-0 bg-sol-border/40" />
          <button
            type="button"
            title={withShortcut("Split right", "code.splitRight")}
            aria-label="Split right"
            onClick={() => onSplit(group.id)}
            className="my-auto ml-1 mr-1.5 flex size-6 shrink-0 items-center justify-center rounded text-sol-text-dim transition-colors hover:bg-sol-bg hover:text-sol-text"
          >
            <SquareSplitHorizontal className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      <ContextMenu state={menu}>
        {(path) => {
          const tab = group.tabs.find((t) => t.path === path);
          const at = indexOf(path);
          return (
            <>
              <CtxItem icon={X} shortcut="code.closeTab" onSelect={() => onMenu(group.id, "close", path)}>
                Close
              </CtxItem>
              <CtxItem disabled={group.tabs.length < 2} onSelect={() => onMenu(group.id, "closeOthers", path)}>
                Close others
              </CtxItem>
              <CtxItem disabled={at === group.tabs.length - 1} onSelect={() => onMenu(group.id, "closeRight", path)}>
                Close to the right
              </CtxItem>
              <CtxSeparator />
              <CtxItem icon={Pin} onSelect={() => onMenu(group.id, "pin", path)}>
                {tab?.pinned ? "Unpin" : "Pin"}
              </CtxItem>
              {tab?.preview && <CtxItem onSelect={() => onMenu(group.id, "keep", path)}>Keep open</CtxItem>}
              {canSplit && (
                <CtxItem icon={SquareSplitHorizontal} shortcut="code.splitRight" onSelect={() => onMenu(group.id, "splitRight", path)}>
                  Split right
                </CtxItem>
              )}
              {!isVirtualTab(path) && (
                <>
                  <CtxSeparator />
                  <CtxItem onSelect={() => onMenu(group.id, "copyPath", path)}>Copy path</CtxItem>
                  <CtxItem onSelect={() => onMenu(group.id, "copyRelative", path)}>Copy relative path</CtxItem>
                  <CtxItem onSelect={() => onMenu(group.id, "reveal", path)}>Reveal in file tree</CtxItem>
                </>
              )}
            </>
          );
        }}
      </ContextMenu>
    </div>
  );
});

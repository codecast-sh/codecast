// One editor group's tab strip. A preview tab is italic and is replaced by the
// next preview open; a double click (or editing) keeps it. A pinned tab sits
// at the left with a pin and no close button. A dirty tab shows a dot where
// its close button is, and the button on hover. Middle click closes; tabs drag
// to reorder and between groups; the strip scrolls sideways with the active
// tab kept in view. Pinned tabs stay put at the left, outside the scroll, and
// a count of the tabs scrolled out of view opens the group's tab list.

import { FileStateMark, deletedNameClass, fileStateWords } from "./FileStateMark";
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
import { focusGroup } from "../../../lib/code/workspace/groupRegistry";
import { useCodeGroup } from "./groupContext";
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
  /** Its number among the groups, when there are several. */
  groupNumber?: number;
  /** Each takes the group, so one stable set serves every group. */
  onActivate(groupId: string, path: string): void;
  onClose(groupId: string, path: string): void;
  onKeep(groupId: string, path: string): void;
  onMove(fromGroupId: string, path: string, toGroupId: string, toIndex: number): void;
  onMenu(groupId: string, action: TabMenuAction, path: string): void;
  onSplit(groupId: string): void;
  /** List this group's tabs (the strip hides some). */
  onListTabs(groupId: string): void;
}

/** A tab's handlers: one object per strip that never changes, so a tab
 *  re-renders only when its own props do. */
interface TabEvents {
  activate(path: string): void;
  close(path: string): void;
  keep(path: string): void;
  context(e: React.MouseEvent | React.KeyboardEvent, path: string): void;
  /** Back to the group's editor (a press on a tab leaves focus there). */
  focusView(): void;
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

/** A name's tail that stays whole when the name is cut: its extension, with a
 *  test or spec marker before it. */
const NAME_TAIL = /(?:\.(?:test|spec|stories|mount\.test|d))?\.[^.]+$/;

/** Fade whichever edges hide tabs, and count the tabs not wholly in view. */
function paintClip(strip: HTMLElement, chip: HTMLElement | null): void {
  const left = strip.scrollLeft > 1;
  const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
  if (chip) {
    let hidden = 0;
    if (left || right) {
      const from = strip.scrollLeft;
      const to = from + strip.clientWidth;
      for (const el of strip.children) {
        const t = el as HTMLElement;
        if (t.dataset.tabPath && (t.offsetLeft < from - 1 || t.offsetLeft + t.offsetWidth > to + 1)) hidden++;
      }
    }
    const label = hidden ? `+${hidden}` : "";
    if (chip.textContent !== label) {
      chip.textContent = label;
      chip.setAttribute("aria-label", `${hidden} more tabs`);
    }
    chip.hidden = !hidden;
  }
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

/** The name, at most 22ch: the middle goes, the extension stays. */
function TabName({ name, italic, className = "" }: { name: string; italic: boolean; className?: string }) {
  const tail = NAME_TAIL.exec(name)?.[0] ?? "";
  const stem = tail && tail.length < name.length ? name.slice(0, -tail.length) : name;
  return (
    <span className={`flex min-w-0 max-w-[22ch] whitespace-nowrap ${italic ? "italic" : ""} ${className}`}>
      <span className="min-w-0 truncate">{stem}</span>
      {stem !== name && <span className="shrink-0">{tail}</span>}
    </span>
  );
}

const Tab = memo(function Tab({
  vaultId,
  tab,
  active,
  focused,
  duplicateName,
  dropBefore,
  panelId,
  events,
}: {
  vaultId: string;
  panelId: string;
  tab: WsTab;
  active: boolean;
  focused: boolean;
  duplicateName: boolean;
  dropBefore: boolean;
  events: TabEvents;
}) {
  const dirty = useCodeStore((s) => !!s.dirty[bufferKey(vaultId, tab.path)]);
  const conflict = useCodeStore((s) => s.conflicts[bufferKey(vaultId, tab.path)]);
  const isNew = useIsNewFile(bufferKey(vaultId, tab.path));
  const name = nameOf(tab.path);
  const dir = duplicateName ? tab.path.slice(0, Math.max(0, tab.path.length - name.length - 1)).split("/").pop() : null;
  const state = fileStateWords(conflict, dirty);
  // Anything pending holds the close button's slot, as a dirty dot does.
  const marked = !!state;
  const label = [dir ? `${name} (${dir})` : name, state, tab.pinned && "pinned", tab.preview && "preview", isNew && "new file"].filter(Boolean).join(", ");
  const pressed = useRef(false);
  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={label}
      aria-controls={panelId}
      // One stop in the Tab order, on the active tab; arrows walk the rest.
      tabIndex={active ? 0 : -1}
      data-tab-path={tab.path}
      draggable
      title={isNew ? `${tab.path} (new file, created on save)` : tab.path}
      data-new-file={isNew || undefined}
      onPointerDown={() => void (pressed.current = true)}
      // A press focuses the editor, as in Zed; only keys stop on the tab.
      onFocus={() => {
        if (pressed.current) events.focusView();
        pressed.current = false;
      }}
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
      className={`group/tab relative flex h-full shrink-0 cursor-default select-none items-center gap-1.5 border-r border-sol-border/30 pl-2.5 pr-1 text-meta outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sol-cyan ${
        active ? "bg-sol-bg text-sol-text" : "text-sol-text-dim hover:bg-sol-bg/50 hover:text-sol-text-muted"
      }`}
    >
      {active && <span className={`absolute inset-x-0 top-0 h-px ${focused ? "bg-sol-cyan" : "bg-sol-border"}`} />}
      {active && <span className="absolute inset-x-0 -bottom-px h-px bg-sol-bg" />}
      {dropBefore && <span className="absolute inset-y-1 -left-px w-0.5 rounded bg-sol-cyan" />}
      {tab.pinned ? <Pin className="h-3 w-3 shrink-0 -rotate-45 text-sol-text-dim" /> : tabIcon(tab.path)}
      <TabName name={name} italic={!!tab.preview} className={deletedNameClass(conflict)} />
      {dir && <span className="max-w-[12ch] truncate text-sol-text-dim/80">{dir}</span>}
      {isNew && <span className="shrink-0 rounded-sm bg-sol-green/15 px-1 text-meta leading-4 text-sol-green">new</span>}
      {!isVirtualTab(tab.path) && <PresenceDot vaultId={vaultId} path={tab.path} />}
      {tab.pinned && !marked ? (
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
          {marked && <FileStateMark conflict={conflict} dirty={dirty} className="absolute group-hover/tab:hidden" />}
          <X className={`h-3 w-3 ${marked ? "invisible group-hover/tab:visible" : active ? "" : "invisible group-hover/tab:visible"}`} />
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
  groupNumber,
  onActivate,
  onClose,
  onKeep,
  onMove,
  onMenu,
  onSplit,
  onListTabs,
}: TabBarProps) {
  const groupCtx = useCodeGroup();
  const groupKey = groupCtx?.key ?? group.id;
  const stripRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLButtonElement | null>(null);
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
      paintClip(strip, chipRef.current);
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
    const paint = () => paintClip(strip, chipRef.current);
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

  const pinned = group.tabs.filter((t) => t.pinned);
  const rest = pinned.length ? group.tabs.filter((t) => !t.pinned) : group.tabs;
  const tabProps = (t: WsTab) => ({
    vaultId,
    tab: t,
    active: t.path === group.active,
    focused,
    duplicateName: (names.get(nameOf(t.path)) ?? 0) > 1,
    dropBefore: dropAt === indexOf(t.path),
    panelId: `${groupKey}:panel`,
  });

  const latest = useRef({ group, groupKey, accept, drop, dropIndex, menu, onActivate, onClose, onKeep });
  latest.current = { group, groupKey, accept, drop, dropIndex, menu, onActivate, onClose, onKeep };
  const events = useMemo<TabEvents>(
    () => ({
      activate: (path) => latest.current.onActivate(latest.current.group.id, path),
      close: (path) => latest.current.onClose(latest.current.group.id, path),
      keep: (path) => latest.current.onKeep(latest.current.group.id, path),
      context: (e, path) => {
        // From the keyboard (Shift-F10, the menu key) the menu opens under
        // the tab; a click opens it at the pointer.
        if ("key" in e || (e.clientX === 0 && e.clientY === 0)) {
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          return latest.current.menu.openAt(r.left, r.bottom + 2, path);
        }
        latest.current.menu.open(e, path, { force: true });
      },
      focusView: () => focusGroup(latest.current.groupKey),
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
      aria-label={groupNumber ? `Editor tabs, group ${groupNumber}` : "Editor tabs"}
      onKeyDown={(e) => {
        const el = e.target as HTMLElement;
        const path = el.getAttribute("role") === "tab" ? el.dataset.tabPath : undefined;
        if (!path) return;
        const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")];
        const i = tabs.indexOf(el);
        const to = (j: number) => tabs[(j + tabs.length) % tabs.length]?.focus();
        if (e.key === "ArrowRight") to(i + 1);
        else if (e.key === "ArrowLeft") to(i - 1);
        else if (e.key === "Home") to(0);
        else if (e.key === "End") to(tabs.length - 1);
        else if (e.key === "Enter" || e.key === " ") {
          onActivate(group.id, path);
          requestAnimationFrame(() => focusGroup(groupKey));
        } else if (e.key === "Escape") focusGroup(groupKey);
        else if (e.key === "Delete" || e.key === "Backspace") {
          onClose(group.id, path);
          // Focus stays in the strip, on the tab that took its place.
          requestAnimationFrame(() => stripRef.current?.parentElement?.querySelector<HTMLElement>("[role=tab][tabindex='0']")?.focus());
        } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) events.context(e, path);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      className={`flex h-8 shrink-0 items-stretch border-b border-sol-border/30 bg-sol-bg-alt/50 ${leftInset ? "pl-9" : ""} ${rightInset ? "pr-9" : ""}`}
    >
      {pinned.length > 0 && (
        <div className="flex shrink-0 items-stretch border-r border-sol-border/40">
          {pinned.map((t) => (
            <Tab key={t.path} {...tabProps(t)} events={events} />
          ))}
        </div>
      )}
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
        {rest.map((t) => (
          <Tab key={t.path} {...tabProps(t)} events={events} />
        ))}
        {dropAt === group.tabs.length && <span className="my-1 w-0.5 shrink-0 rounded bg-sol-cyan" />}
      </div>
      {/* Filled in by paintClip; React never renders the count. */}
      <button
        ref={chipRef}
        type="button"
        hidden
        aria-label="All tabs in this group"
        onClick={() => onListTabs(group.id)}
        className="my-auto ml-1 h-5 shrink-0 rounded px-1.5 text-meta tabular-nums text-sol-text-dim transition-colors hover:bg-sol-bg hover:text-sol-text"
      />
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

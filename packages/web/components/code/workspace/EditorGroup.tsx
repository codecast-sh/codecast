// One editor group: its tab strip, then the active tab's view. A markdown note
// opens the notes view, anything else the file view (the code editor for
// text); one tab strip serves both. The code editor stays mounted while the
// group moves between code tabs, so a tab switch is a state swap, never a new
// editor (docs/architecture/code-editor.md, contract 2).

import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { File, FileText } from "lucide-react";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { VaultFileView } from "../../vault/VaultFileView";
import { KeyCap } from "../../KeyCap";
import { useShortcutParts } from "../../../shortcuts";
import type { ShortcutAction } from "../../../shortcuts/registry";
import { useVaultStore } from "../../../store/vaultStore";
import { runCodeCommand } from "../../../lib/code/commands";
import { CodeGroupContext } from "./groupContext";
import { TabBar, type TabMenuAction } from "./TabBar";
import { isDraggingTab, takeTabDrag } from "../../../lib/code/workspace/tabDrag";
import type { WsGroup } from "../../../lib/code/workspace/model";
import { SEARCH_RESULTS_TAB } from "../../../lib/code/workspace/virtualTabs";
import { SearchResultsTab } from "../search/SearchResultsEditorHost";

/** Tabs whose saved cursor was already put back this page load. */
const restored = new Set<string>();

/** How many recent files an empty group lists. */
const EMPTY_RECENT = 8;

export interface EditorGroupProps {
  instance: string;
  vaultId: string;
  group: WsGroup;
  focused: boolean;
  leftInset: boolean;
  rightInset: boolean;
  canSplit: boolean;
  /** Its number among the groups, when there are several. */
  groupNumber?: number;
  /** Files opened lately, for the group while it has no tab. */
  recent: readonly string[];
  /** A deep link is resolving into this workspace: an empty group stays blank
   *  rather than flash its choices before the file lands. */
  deepLinking: boolean;
  renderNote(path: string, line: string | null): ReactNode;
  onFocusGroup(groupId: string): void;
  onActivate(groupId: string, path: string): void;
  onOpen(groupId: string, path: string): void;
  onClose(groupId: string, path: string): void;
  onKeep(groupId: string, path: string): void;
  onMove(fromGroupId: string, path: string, toGroupId: string, toIndex: number): void;
  onMenu(groupId: string, action: TabMenuAction, path: string): void;
  onSplit(groupId: string): void;
  onListTabs(groupId: string): void;
}

/** A key hint that is also the button: name, then its keys. */
function KeyAction({ label, action, onClick }: { label: string; action: ShortcutAction; onClick(): void }) {
  const keys = useShortcutParts(action);
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-sol-bg-alt hover:text-sol-text-muted">
      <span>{label}</span>
      {keys && (
        <span className="flex gap-0.5">
          {keys.map((k, i) => (
            <KeyCap key={i} size="xs">
              {k}
            </KeyCap>
          ))}
        </span>
      )}
    </button>
  );
}

/** A group with no tab: the files opened lately, one click each, and the two
 *  ways to find another. */
function EmptyGroup({ recent, onOpen }: { recent: readonly string[]; onOpen(path: string): void }) {
  // Only files still on disk; a string, so a watcher event re-renders nothing.
  const present = useVaultStore((s) => recent.filter((p) => s.files[p]).slice(0, EMPTY_RECENT).join("\n"));
  const rows = present ? present.split("\n") : [];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-meta text-sol-text-dim">
      {rows.length > 0 && (
        <div className="flex w-full max-w-sm flex-col py-1" aria-label="Recent files">
          {rows.map((p) => {
            const slash = p.lastIndexOf("/");
            const Icon = isVaultMarkdownPath(p) ? FileText : File;
            return (
              <button
                key={p}
                type="button"
                onClick={() => onOpen(p)}
                className="flex w-full items-center gap-2.5 rounded px-3 py-1 text-left text-[13px] text-sol-text-muted transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 opacity-50" />
                <span className="shrink-0 truncate">{p.slice(slash + 1)}</span>
                {slash > 0 && <span className="min-w-0 truncate text-meta text-sol-text-dim">{p.slice(0, slash)}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-2">
        <KeyAction label="Go to file" action="code.quickOpen" onClick={() => runCodeCommand("quickOpen")} />
        <KeyAction label="Search" action="vault.search" onClick={() => runCodeCommand("search.project", {})} />
      </div>
    </div>
  );
}

export const EditorGroup = memo(function EditorGroup({
  instance,
  vaultId,
  group,
  focused,
  leftInset,
  rightInset,
  canSplit,
  groupNumber,
  recent,
  deepLinking,
  renderNote,
  onFocusGroup,
  onActivate,
  onOpen,
  onClose,
  onKeep,
  onMove,
  onMenu,
  onSplit,
  onListTabs,
}: EditorGroupProps) {
  const ctx = useMemo(() => ({ key: `${instance}:${group.id}`, groupId: group.id, active: focused }), [instance, group.id, focused]);
  const [dropping, setDropping] = useState(false);
  const path = group.active;
  const tab = path ? group.tabs.find((t) => t.path === path) : undefined;

  // A tab's saved cursor (from before a reload) goes back once per page load,
  // and holds while the tab is shown, so a file whose text arrives later
  // still lands there.
  const restore = useRef<{ path: string | null; at: string | null }>({ path: null, at: null });
  if (restore.current.path !== path) {
    const key = `${vaultId}\u0000${path}`;
    const c = tab?.cursor;
    const saved = path && c && !restored.has(key) ? `${c.line}:${c.col}${c.top ? `@${c.top}` : ""}` : null;
    if (path) restored.add(key);
    restore.current = { path, at: saved };
  }
  const line = path && group.reveal?.path === path ? `${group.reveal.at}#${group.reveal.n}` : restore.current.at;

  return (
    <CodeGroupContext.Provider value={ctx}>
      <div
        className="flex h-full min-h-0 flex-col"
        data-code-group={group.id}
        data-group-idle={focused ? undefined : ""}
        // A press moves focus to a group; focus arriving on its own (a view
        // that focuses itself as it mounts) never does, so two groups can
        // never hand focus back and forth.
        onPointerDownCapture={() => !focused && onFocusGroup(group.id)}
      >
        <TabBar
          vaultId={vaultId}
          group={group}
          focused={focused}
          leftInset={leftInset}
          rightInset={rightInset}
          canSplit={canSplit}
          groupNumber={groupNumber}
          onActivate={onActivate}
          onClose={onClose}
          onKeep={onKeep}
          onMove={onMove}
          onMenu={onMenu}
          onSplit={onSplit}
          onListTabs={onListTabs}
        />
        {/* Focusable, so a press on a group with no editor in it (a missing
            file, an empty group) keeps focus in the workspace and Cmd-W
            closes the editor tab, not the app tab. */}
        <div
          className="relative min-h-0 flex-1 outline-none"
          data-group-body={ctx.key}
          id={`${ctx.key}:panel`}
          role="tabpanel"
          tabIndex={-1}
          onDragOver={(e) => {
            if (!isDraggingTab()) return;
            e.preventDefault();
            setDropping(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
          }}
          onDrop={(e) => {
            setDropping(false);
            const d = takeTabDrag();
            if (!d) return;
            e.preventDefault();
            onMove(d.groupId, d.path, group.id, group.tabs.length);
          }}
        >
          {!path ? (
            deepLinking ? null : <EmptyGroup recent={recent} onOpen={(p) => onOpen(group.id, p)} />
          ) : path === SEARCH_RESULTS_TAB ? (
            <SearchResultsTab onClose={() => onClose(group.id, path)} />
          ) : isVaultMarkdownPath(path) ? (
            renderNote(path, line)
          ) : (
            <VaultFileView path={path} line={line} />
          )}
          {dropping && <div className="pointer-events-none absolute inset-0 z-20 bg-sol-cyan/10 ring-1 ring-inset ring-sol-cyan/50" />}
        </div>
      </div>
    </CodeGroupContext.Provider>
  );
});

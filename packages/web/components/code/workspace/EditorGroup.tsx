// One editor group: its tab strip, then the active tab's view. A markdown note
// opens the notes view, anything else the file view (the code editor for
// text); one tab strip serves both. The code editor stays mounted while the
// group moves between code tabs, so a tab switch is a state swap, never a new
// editor (docs/architecture/code-editor.md, contract 2).

import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { FolderTree } from "lucide-react";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { VaultFileView } from "../../vault/VaultFileView";
import { KeyCap } from "../../KeyCap";
import { useShortcutParts } from "../../../shortcuts";
import { CodeGroupContext } from "./groupContext";
import { TabBar, type TabMenuAction } from "./TabBar";
import { isDraggingTab, takeTabDrag } from "../../../lib/code/workspace/tabDrag";
import type { WsGroup } from "../../../lib/code/workspace/model";
import { SEARCH_RESULTS_TAB } from "../../../lib/code/workspace/virtualTabs";
import { SearchResultsTab } from "../search/SearchResultsEditorHost";

/** Tabs whose saved cursor was already put back this page load. */
const restored = new Set<string>();

export interface EditorGroupProps {
  instance: string;
  vaultId: string;
  group: WsGroup;
  focused: boolean;
  leftInset: boolean;
  rightInset: boolean;
  canSplit: boolean;
  renderNote(path: string, line: string | null): ReactNode;
  onFocusGroup(groupId: string): void;
  onActivate(groupId: string, path: string): void;
  onClose(groupId: string, path: string): void;
  onKeep(groupId: string, path: string): void;
  onMove(fromGroupId: string, path: string, toGroupId: string, toIndex: number): void;
  onMenu(groupId: string, action: TabMenuAction, path: string): void;
  onSplit(groupId: string): void;
}

function EmptyGroup() {
  const keys = useShortcutParts("code.quickOpen");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sol-text-dim">
      <FolderTree className="h-8 w-8 opacity-30" />
      {keys && (
        <div className="flex items-center gap-2 text-meta">
          <span>Open a file</span>
          <span className="flex gap-0.5">
            {keys.map((k, i) => (
              <KeyCap key={i} size="xs">
                {k}
              </KeyCap>
            ))}
          </span>
        </div>
      )}
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
  renderNote,
  onFocusGroup,
  onActivate,
  onClose,
  onKeep,
  onMove,
  onMenu,
  onSplit,
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
    const saved = path && tab?.cursor && !restored.has(key) ? `${tab.cursor.line}:${tab.cursor.col}` : null;
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
          onActivate={onActivate}
          onClose={onClose}
          onKeep={onKeep}
          onMove={onMove}
          onMenu={onMenu}
          onSplit={onSplit}
        />
        {/* Focusable, so a press on a group with no editor in it (a missing
            file, an empty group) keeps focus in the workspace and Cmd-W
            closes the editor tab, not the app tab. */}
        <div
          className="relative min-h-0 flex-1 outline-none"
          data-group-body
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
            <EmptyGroup />
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

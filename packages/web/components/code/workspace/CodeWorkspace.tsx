// The Files content area as a code workspace: up to three editor groups side
// by side (or stacked), each with its own tabs, plus quick open, the tab
// switcher and the line prompt. The workspace lives in codeStore per vault
// and persists across reloads; the URL's ?f= stays the address of the file in
// the focused group, so links, history, Share and the app's own tabs work as
// they did with one file.
//
// Every workspace command in lib/code/commands.ts that the shell owns is
// registered here, so vim's ex adapters (:e, :vs, :bn, :q, <C-w>l), the
// catalog shortcuts and the palette all reach the same verbs.

import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useConvex } from "convex/react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { EditorView } from "@codemirror/view";
import { useCodeStore, workspaceFor } from "../../../store/codeStore";
import { useInboxStore } from "../../../store/inboxStore";
import { useVaultStore } from "../../../store/vaultStore";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useTabActive } from "../../../hooks/usePagePresence";
import { usePaneShortcutAction } from "../../../shortcuts";
import { registerCodeCommands, type CodeCommandContext } from "../../../lib/code/commands";
import { isVirtualTab, SEARCH_RESULTS_TAB } from "../../../lib/code/workspace/virtualTabs";
import { workspaceActions as A } from "../../../lib/code/workspace/controller";
import { groupKeyOfView, viewOfGroup } from "../../../lib/code/workspace/groupRegistry";
import { followVaultFiles, forgetFile, isFolderPath } from "../../../lib/code/workspace/followFiles";
import { peekHistory, stepHistory } from "../../../lib/code/workspace/navHistory";
import { persistWorkspaces } from "../../../lib/code/workspace/persist";
import { MAX_GROUPS, activeGroup, groupById, mruTabs, neighborGroup, type FocusDirection, type MruEntry } from "../../../lib/code/workspace/model";
import { EditorGroup } from "./EditorGroup";
import { QuickOpen } from "./QuickOpen";
import { TabSwitcher } from "./TabSwitcher";
import { GotoLine } from "./GotoLine";
import type { TabMenuAction } from "./TabBar";
import { resolveVaultPath } from "../../../lib/code/vaultPath";
import { AgentLayer } from "../agent/AgentLayer";

let persisting = false;
function startPersistence(): void {
  if (persisting || typeof window === "undefined") return;
  persisting = true;
  persistWorkspaces(useCodeStore.subscribe, () => useCodeStore.getState().workspaces);
}

let instances = 0;

// A hairline between groups with a wider grab area, lit while dragged.
// One status bar for the workspace: every group keeps the bar's row, so the
// editors end on one line, but only the focused group draws its items. A
// narrow bar drops items by their priority (lib/code/statusBar.ts).
const STATUS_CSS = `
[data-code-workspace] [data-code-group][data-group-idle] .cm-code-status > * { visibility: hidden; }`;

const separatorClass = {
  horizontal:
    "relative z-10 w-px bg-sol-border/50 before:absolute before:inset-y-0 before:-left-[2px] before:-right-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan",
  vertical:
    "relative z-10 h-px bg-sol-border/50 before:absolute before:inset-x-0 before:-top-[2px] before:-bottom-[2px] before:content-[''] before:transition-colors before:duration-150 hover:before:bg-sol-cyan data-[resize-handle-active]:before:bg-sol-cyan",
};

type Overlay =
  | { kind: "quickOpen"; query?: string }
  | { kind: "switcher"; held: boolean }
  | { kind: "gotoLine"; line: number; lines: number }
  | null;

export interface CodeWorkspaceProps {
  vaultId: string;
  /** The vault's folder on this machine, for copy path and the terminal. */
  vaultRoot: string | null;
  urlPath: string | null;
  urlLine: string | null;
  /** A ?path= link is still resolving to a file: the workspace leaves the
   *  address bar to it. */
  deepLinking?: boolean;
  /** The page's tree toggle covers the first group's top-left corner. */
  treeOpen: boolean;
  /** Put a file (or nothing) in the address bar. */
  onNavigate(path: string | null, opts?: { replace?: boolean }): void;
  onToggleTree(open?: boolean): void;
  renderNote(path: string, line: string | null): ReactNode;
}

export const CodeWorkspace = memo(function CodeWorkspace(props: CodeWorkspaceProps) {
  const { vaultId, urlPath, urlLine, treeOpen, renderNote } = props;
  const convex = useConvex();
  const instance = useMemo(() => `ws${++instances}`, []);
  const ws = useCodeStore((s) => s.workspaces[vaultId]) ?? workspaceFor(vaultId);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const tabActive = useTabActive();
  const live = useRef({ props, ws, tabActive, convex });
  live.current = { props, ws, tabActive, convex };

  // page.tsx keys this component by vault, so `vaultId` is fixed for its life
  // and every verb below may close over it.
  useMountEffect(() => {
    startPersistence();
    // The persisted workspace joins the store, so every reader sees one value.
    useCodeStore.getState().updateWorkspace(vaultId, (w) => w);
    followVaultFiles(vaultId);
  });

  // ── the address bar and the workspace, kept in step ───────────────────────
  // The URL moving (a tree click, a link, back/forward) opens its file as a
  // preview in the focused group; the focused tab changing puts its file in
  // the URL. Each side reacts only to its own change, so neither echoes.
  const activeNow = activeGroup(ws).active;
  const seenUrl = useRef<string | null | undefined>(undefined);
  const seenUrlLine = useRef<string | null>(null);
  const seenActive = useRef<string | null | undefined>(undefined);
  useWatchEffect(() => {
    const first = seenUrl.current === undefined;
    const urlMoved = urlPath !== seenUrl.current || (urlLine !== seenUrlLine.current && !!urlLine);
    seenUrl.current = urlPath;
    seenUrlLine.current = urlLine;
    if (!urlMoved) return;
    const w = live.current.ws;
    const current = activeGroup(w).active;
    // A folder in ?f= (an old link) is no tab: the tree shows it.
    if (urlPath && isFolderPath(useVaultStore.getState().files, urlPath)) return;
    if (urlPath && (urlPath !== current || urlLine)) {
      // Shown already: the focused group's tab, else another group's.
      const holder = activeGroup(w).tabs.some((t) => t.path === urlPath) ? activeGroup(w) : w.groups.find((g) => g.tabs.some((t) => t.path === urlPath));
      if (holder) A.activate(vaultId, holder.id, urlPath, urlLine ?? undefined);
      else {
        A.open(vaultId, urlPath, { preview: true, at: urlLine ?? undefined });
        // Not in the scan (capped, filtered, or still loading): the daemon
        // says what it is, and a folder keeps no tab.
        const store = useVaultStore.getState();
        if (!store.files[urlPath]) {
          void store.ensureEntry(urlPath).then((row) => {
            if (row?.dir) forgetFile(vaultId, urlPath);
          });
        }
      }
    } else if (!urlPath && first && current && !live.current.props.deepLinking) {
      // A reload of bare /files comes back to the workspace it left. A
      // ?path= link is still choosing the file, and wins.
      live.current.props.onNavigate(current, { replace: true });
    }
  }, [urlPath, urlLine]);
  useWatchEffect(() => {
    if (seenActive.current === undefined) {
      seenActive.current = activeNow;
      return;
    }
    if (activeNow === seenActive.current) return;
    seenActive.current = activeNow;
    // Closing the last tab clears the address; a ?path= link in flight keeps
    // it. A tab that is no file (search results) has no address either, so
    // a click on the file the URL last named still opens it.
    const target = isVirtualTab(activeNow) ? null : activeNow;
    if (target !== urlPath && !(target === null && live.current.props.deepLinking)) live.current.props.onNavigate(target);
  }, [activeNow]);

  // Editing a preview tab keeps it.
  useMountEffect(() =>
    useCodeStore.subscribe((s, prev) => {
      if (s.dirty === prev.dirty) return;
      const prefix = `${live.current.props.vaultId}\u0000`;
      for (const key in s.dirty) {
        if (!prev.dirty[key] && key.startsWith(prefix)) A.keepOpenEverywhere(live.current.props.vaultId, key.slice(prefix.length));
      }
    }),
  );

  // ── verbs ─────────────────────────────────────────────────────────────────

  /** The group a command acts on: the one its editor sits in, else the
   *  focused group. Null when the command came from another workspace. */
  const groupFor = useCallback(
    (ctx?: CodeCommandContext): string | null => {
      const w = live.current.ws;
      if (ctx?.view) {
        const key = groupKeyOfView(ctx.view);
        if (!key?.startsWith(`${instance}:`)) return null;
        return key.slice(instance.length + 1);
      }
      if (!live.current.tabActive) return null;
      return w.activeGroup;
    },
    [instance],
  );

  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
  const absolute = (path: string) => (live.current.props.vaultRoot ? `${live.current.props.vaultRoot.replace(/\/$/, "")}/${path}` : path);

  const openRecent = useCallback((entry: { path: string; line: number; col: number }) => {
    const w = live.current.ws;
    const group = activeGroup(w);
    const at = `${entry.line}:${entry.col}`;
    if (group.tabs.some((t) => t.path === entry.path)) A.activate(vaultId, group.id, entry.path, at);
    else A.open(vaultId, entry.path, { at });
  }, [vaultId]);

  /** Back or forward through cursor history; a stop in another vault ends
   *  the walk here without spending the press. */
  const navStep = (ctx: CodeCommandContext | undefined, delta: -1 | 1) => {
    if (!groupFor(ctx)) return false;
    if (peekHistory(delta)?.vaultId !== vaultId) return false;
    openRecent(stepHistory(delta)!);
  };

  const focusDir = (dir: FocusDirection) => {
    const target = neighborGroup(live.current.ws, dir);
    if (target) A.focusGroup(vaultId, target);
    return !!target;
  };

  const showGotoLine = () => {
    const key = `${instance}:${live.current.ws.activeGroup}`;
    const view = viewOfGroup(key) as EditorView | null;
    if (!view) return false;
    const head = view.state.selection.main.head;
    setOverlay({ kind: "gotoLine", line: view.state.doc.lineAt(head).number, lines: view.state.doc.lines });
    return true;
  };

  const toggleTerminal = async () => {
    const store = useInboxStore.getState();
    if (store.workspace.dock.pane != null) {
      store.setDockOpen(false);
      return;
    }
    store.setDockOpen(true);
    const root = live.current.props.vaultRoot;
    if (!root) return;
    const [{ getTerminalEndpoint }, terms] = await Promise.all([import("../../../lib/terminal/endpoint"), import("../../../lib/terminal/termSessions")]);
    const endpoint = await getTerminalEndpoint(live.current.convex);
    if (!endpoint) return;
    const existing = terms.listTabs().find((t) => t.kind === "shell" && t.cwd === root && t.status !== "exited");
    if (existing) terms.setActiveTab(existing.id);
    else terms.openTerminal({ endpoint, kind: "shell", cwd: root });
  };

  useMountEffect(() =>
    registerCodeCommands({
      // The results editor is a tab: brought forward where it is open, else
      // opened in the focused group.
      "search.openEditor": (_a, ctx) => {
        if (!groupFor(ctx)) return false;
        const holder = live.current.ws.groups.find((g) => g.tabs.some((t) => t.path === SEARCH_RESULTS_TAB));
        if (holder) A.activate(vaultId, holder.id, SEARCH_RESULTS_TAB);
        else A.open(vaultId, SEARCH_RESULTS_TAB);
      },
      "file.open": (args, ctx) => {
        const g = groupFor(ctx);
        const resolved = typeof args?.path === "string" ? resolveVaultPath(args.path, live.current.props.vaultRoot) : null;
        if (!g || !resolved || "refused" in resolved) return false;
        const { path } = resolved;
        const line = typeof args?.line === "number" ? args.line : undefined;
        const at = line ? (typeof args?.column === "number" ? `${line}:${args.column}` : `${line}`) : undefined;
        const split = args?.split === "right" || args?.split === "down" ? args.split : null;
        if (split) A.split(vaultId, g, path, split, { at });
        else A.open(vaultId, path, { groupId: g, at });
      },
      "file.close": (_a, ctx) => {
        const g = groupFor(ctx);
        const group = groupById(live.current.ws, g);
        if (!group?.active) return false;
        A.close(vaultId, group.id, group.active);
      },
      "file.closeOthers": (_a, ctx) => {
        const group = groupById(live.current.ws, groupFor(ctx));
        if (!group?.active) return false;
        A.closeOthers(vaultId, group.id, group.active);
      },
      "file.reopenClosed": (_a, ctx) => {
        if (!groupFor(ctx) || !live.current.ws.closed.length) return false;
        A.reopen(vaultId);
      },
      "file.copyPath": (args, ctx) => {
        const group = groupById(live.current.ws, groupFor(ctx));
        if (!group?.active) return false;
        copy(args?.relative ? group.active : absolute(group.active));
      },
      "file.reveal": (_a, ctx) => {
        const group = groupById(live.current.ws, groupFor(ctx));
        if (!group?.active) return false;
        live.current.props.onToggleTree(true);
        useVaultStore.getState().requestReveal(group.active);
      },
      quickOpen: (args, ctx) => {
        if (!groupFor(ctx)) return false;
        setOverlay({ kind: "quickOpen", query: typeof args?.query === "string" ? args.query : undefined });
      },
      "tabs.switcher": (_a, ctx) => {
        if (!groupFor(ctx) || mruTabs(live.current.ws).length === 0) return false;
        setOverlay({ kind: "switcher", held: false });
      },
      "tabs.next": (_a, ctx) => {
        const g = groupFor(ctx);
        if (!g) return false;
        A.focusGroup(vaultId, g);
        A.cycle(vaultId, 1);
      },
      "tabs.prev": (_a, ctx) => {
        const g = groupFor(ctx);
        if (!g) return false;
        A.focusGroup(vaultId, g);
        A.cycle(vaultId, -1);
      },
      "tabs.goto": (args, ctx) => {
        const g = groupFor(ctx);
        if (!g || typeof args?.index !== "number") return false;
        A.focusGroup(vaultId, g);
        A.goto(vaultId, args.index);
      },
      "goto.line": (args, ctx) => {
        const group = groupById(live.current.ws, groupFor(ctx));
        if (!group?.active) return false;
        if (typeof args?.line === "number") A.activate(vaultId, group.id, group.active, String(args.line));
        else return showGotoLine();
      },
      "nav.back": (_a, ctx) => navStep(ctx, -1),
      "nav.forward": (_a, ctx) => navStep(ctx, 1),
      "split.right": (_a, ctx) => {
        const group = groupById(live.current.ws, groupFor(ctx));
        if (!group?.active) return false;
        A.split(vaultId, group.id, group.active, "right");
      },
      "split.down": (_a, ctx) => {
        const group = groupById(live.current.ws, groupFor(ctx));
        if (!group?.active) return false;
        A.split(vaultId, group.id, group.active, "down");
      },
      "split.close": (_a, ctx) => {
        const g = groupFor(ctx);
        if (!g || live.current.ws.groups.length < 2) return false;
        A.closeGroup(vaultId, g);
      },
      "split.only": (_a, ctx) => {
        const g = groupFor(ctx);
        if (!g) return false;
        A.only(vaultId, g);
      },
      "focus.left": (_a, ctx) => !!groupFor(ctx) && focusDir("left"),
      "focus.right": (_a, ctx) => !!groupFor(ctx) && focusDir("right"),
      "focus.up": (_a, ctx) => !!groupFor(ctx) && focusDir("up"),
      "focus.down": (_a, ctx) => !!groupFor(ctx) && focusDir("down"),
      "tree.toggle": (_a, ctx) => {
        if (!groupFor(ctx)) return false;
        live.current.props.onToggleTree();
      },
      "tree.reveal": (_a, ctx) => {
        const group = groupById(live.current.ws, groupFor(ctx));
        if (!group) return false;
        live.current.props.onToggleTree(true);
        if (group.active) useVaultStore.getState().requestReveal(group.active);
      },
      "terminal.toggle": (_a, ctx) => {
        if (!groupFor(ctx)) return false;
        void toggleTerminal();
      },
    }),
  );

  // ── catalog shortcuts ─────────────────────────────────────────────────────
  const hasFocus = () => {
    const root = rootRef.current;
    const active = document.activeElement;
    return !!root && !!active && root.contains(active);
  };
  usePaneShortcutAction("code.quickOpen", () => {
    setOverlay({ kind: "quickOpen" });
    return true;
  });
  /** Focus in the workspace, or anywhere in the Files surface around it (the
   *  tree, the search pane), as Zed and VS Code close the editor tab from
   *  their sidebars. */
  const surfaceHasFocus = () => {
    if (hasFocus()) return true;
    const surface = document.activeElement?.closest("[data-files-surface]");
    return !!surface && !!rootRef.current && surface.contains(rootRef.current);
  };
  usePaneShortcutAction("code.closeTab", () => {
    const group = activeGroup(live.current.ws);
    if (!surfaceHasFocus() || !group.active) return false;
    A.close(vaultId, group.id, group.active);
    return true;
  });
  usePaneShortcutAction("code.reopenTab", () => {
    if (!live.current.ws.closed.length) return false;
    A.reopen(vaultId);
    return true;
  });
  usePaneShortcutAction("code.splitRight", () => {
    const group = activeGroup(live.current.ws);
    if (!group.active || live.current.ws.groups.length >= MAX_GROUPS) return false;
    A.split(vaultId, group.id, group.active, "right");
    return true;
  });

  // ── render ────────────────────────────────────────────────────────────────

  const onMenu = useCallback(
    (groupId: string, action: TabMenuAction, path: string) => {
      switch (action) {
        case "close":
          return A.close(vaultId, groupId, path);
        case "closeOthers":
          return A.closeOthers(vaultId, groupId, path);
        case "closeRight":
          return A.closeToRight(vaultId, groupId, path);
        case "pin":
          return A.pin(vaultId, groupId, path);
        case "keep":
          return A.keepOpen(vaultId, groupId, path);
        case "splitRight":
          return A.split(vaultId, groupId, path, "right");
        case "copyPath":
          return copy(absolute(path));
        case "copyRelative":
          return copy(path);
        case "reveal":
          live.current.props.onToggleTree(true);
          return useVaultStore.getState().requestReveal(path);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vaultId],
  );
  const handlers = useMemo(
    () => ({
      onFocusGroup: (g: string) => A.focusGroup(vaultId, g),
      onActivate: (g: string, p: string) => A.activate(vaultId, g, p),
      onClose: (g: string, p: string) => A.close(vaultId, g, p),
      onKeep: (g: string, p: string) => A.keepOpen(vaultId, g, p),
      onMove: (from: string, p: string, to: string, i: number) => A.move(vaultId, from, p, to, i),
      onSplit: (g: string) => {
        const group = groupById(live.current.ws, g);
        if (group?.active) A.split(vaultId, g, group.active, "right");
      },
    }),
    [vaultId],
  );

  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of mruTabs(ws)) if (!seen.has(e.path) && !isVirtualTab(e.path)) seen.add(e.path) && out.push(e.path);
    for (const c of ws.closed) if (!seen.has(c.path) && !isVirtualTab(c.path)) seen.add(c.path) && out.push(c.path);
    for (const p of useVaultStore.getState().recentPaths) if (!seen.has(p)) seen.add(p) && out.push(p);
    return out;
  }, [ws]);

  const closeOverlay = useCallback(() => {
    setOverlay(null);
    const view = viewOfGroup(`${instance}:${live.current.ws.activeGroup}`) as EditorView | null;
    requestAnimationFrame(() => view?.focus());
  }, [instance]);

  const horizontal = ws.orientation === "horizontal";
  const groups = ws.groups;
  const multi = groups.length > 1;
  const canSplit = groups.length < MAX_GROUPS;
  const layout = useMemo(() => {
    const sizes = ws.sizes && ws.sizes.length === groups.length ? ws.sizes : groups.map(() => 100 / groups.length);
    return Object.fromEntries(groups.map((g, i) => [g.id, sizes[i]]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.map((g) => g.id).join(","), ws.orientation]);

  const groupNumbers = useMemo(() => (multi ? new Map(groups.map((g, i) => [g.id, i + 1])) : null), [groups, multi]);

  return (
    <div
      ref={rootRef}
      className="h-full min-h-0"
      data-code-workspace
      onKeyDownCapture={(e) => {
        // Ctrl-Tab here is the tab switcher, ahead of vim and of the app's
        // recent-views walk (a window listener this stops). Chrome keeps
        // Ctrl-Tab for its own tabs; the desktop app and :Buffers reach it.
        if (e.ctrlKey && e.key === "Tab" && !overlay) {
          e.preventDefault();
          e.stopPropagation();
          if (mruTabs(ws).length > 1) setOverlay({ kind: "switcher", held: true });
        }
      }}
    >
      <style>{STATUS_CSS}</style>
      <AgentLayer vaultId={vaultId} root={props.vaultRoot} />
      <Group
        key={horizontal ? "h" : "v"}
        orientation={horizontal ? "horizontal" : "vertical"}
        className="h-full min-h-0"
        defaultLayout={layout}
        onLayoutChanged={(l) => {
          if (multi) A.sizes(vaultId, groups.map((g) => l[g.id] ?? 0));
        }}
      >
        {groups.map((g, i) => (
          <GroupPanel key={g.id} id={g.id} separator={i > 0 ? (horizontal ? "horizontal" : "vertical") : null}>
            <EditorGroup
              instance={instance}
              vaultId={vaultId}
              group={g}
              focused={multi ? g.id === ws.activeGroup : true}
              leftInset={!treeOpen && i === 0}
              rightInset={horizontal ? i === groups.length - 1 : i === 0}
              canSplit={canSplit}
              renderNote={renderNote}
              onMenu={onMenu}
              {...handlers}
            />
          </GroupPanel>
        ))}
      </Group>
      {overlay?.kind === "quickOpen" && (
        <QuickOpen
          vaultId={vaultId}
          initialQuery={overlay.query}
          recent={recent}
          onClose={closeOverlay}
          onGotoLine={(at) => {
            const group = activeGroup(live.current.ws);
            setOverlay(null);
            if (group.active) A.activate(vaultId, group.id, group.active, at);
          }}
          onOpen={(path, at, split) => {
            setOverlay(null);
            const group = activeGroup(live.current.ws);
            if (split) A.split(vaultId, group.id, path, "right", { at, preview: true });
            else A.open(vaultId, path, { preview: true, at });
          }}
        />
      )}
      {overlay?.kind === "switcher" && (
        <TabSwitcher
          vaultId={vaultId}
          entries={mruTabs(ws)}
          groupNumbers={groupNumbers}
          held={overlay.held}
          onClose={closeOverlay}
          onPick={(entry: MruEntry) => {
            setOverlay(null);
            A.activate(vaultId, entry.groupId, entry.path);
          }}
        />
      )}
      {overlay?.kind === "gotoLine" && (
        <GotoLine
          line={overlay.line}
          lines={overlay.lines}
          onClose={closeOverlay}
          onGo={(at) => {
            const group = activeGroup(live.current.ws);
            setOverlay(null);
            if (group.active) A.activate(vaultId, group.id, group.active, at);
          }}
        />
      )}
    </div>
  );
});

function GroupPanel({ id, separator, children }: { id: string; separator: "horizontal" | "vertical" | null; children: ReactNode }) {
  return (
    <>
      {separator && <Separator className={separatorClass[separator]} />}
      {/* A percentage minimum can always be met; a pixel one in a pane too
          narrow for it livelocks the panel library (see app/files/page.tsx). */}
      <Panel id={id} minSize="12%" className="min-h-0 min-w-0">
        {children}
      </Panel>
    </>
  );
}

export default CodeWorkspace;

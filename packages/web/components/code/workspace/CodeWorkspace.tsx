// The Files content area as a code workspace: up to three editor groups in a
// two-level split (columns that stack, or rows that divide), each with its own tabs, plus quick open, the tab
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
import type { EditorView } from "@codemirror/view";
import { useCodeStore, workspaceFor } from "../../../store/codeStore";
import { useInboxStore } from "../../../store/inboxStore";
import { useVaultStore } from "../../../store/vaultStore";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useDerivedSize } from "../../../hooks/useDerivedSize";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useTabActive } from "../../../hooks/usePagePresence";
import { usePaneShortcutAction } from "../../../shortcuts";
import { registerCodeCommands, runCodeCommand, type CodeCommandContext, type CodeCommandId } from "../../../lib/code/commands";
import { isVirtualTab, SEARCH_RESULTS_TAB } from "../../../lib/code/workspace/virtualTabs";
import { workspaceActions as A } from "../../../lib/code/workspace/controller";
import { focusGroup, groupKeyOfView, viewOfGroup } from "../../../lib/code/workspace/groupRegistry";
import { followVaultFiles, forgetFile, isFolderPath } from "../../../lib/code/workspace/followFiles";
import { peekHistory, stepHistory } from "../../../lib/code/workspace/navHistory";
import { persistWorkspaces } from "../../../lib/code/workspace/persist";
import { registerExCompletionSource } from "../../../lib/code/vim/completionSource";
import {
  MIN_GROUP_SIZE,
  activeGroup,
  alternateTab,
  canSplitMore,
  cycleGroup,
  groupById,
  groupRects,
  laneGroups,
  lanesOf,
  mruTabs,
  neighborGroup,
  previousGroup,
  type FocusDirection,
  type GroupEdge,
  type MruEntry,
  type SplitDirection,
  type Workspace,
  type WsGroup,
} from "../../../lib/code/workspace/model";
import { EditorGroup } from "./EditorGroup";
import { SplitRun } from "./SplitRun";
import { MIN_GROUP_PX, SIZE_QUANTUM, minShare, roomToSplit } from "../../../lib/code/workspace/splitRoom";
import { QuickOpen } from "./QuickOpen";
import { TabSwitcher } from "./TabSwitcher";
import { GotoLine } from "./GotoLine";
import type { TabMenuAction } from "./TabBar";
import { resolveVaultPath } from "../../../lib/code/vaultPath";
import { filesHref, navigateToFiles } from "../../../lib/vault/vaultHref";
import { AgentLayer } from "../agent/AgentLayer";

let persisting = false;
function startPersistence(): void {
  if (persisting || typeof window === "undefined") return;
  persisting = true;
  persistWorkspaces(useCodeStore.subscribe, () => useCodeStore.getState().workspaces);
}

let instances = 0;

/** What a group with tabs gets for its recent list: the same empty array
 *  every render, so a tab change elsewhere leaves it alone. */
const NO_RECENT: readonly string[] = [];

/** The real file the focused group shows, if any. */
const activeOf = (ws: Parameters<typeof activeGroup>[0]): string | null => {
  const path = activeGroup(ws).active;
  return path && !isVirtualTab(path) ? path : null;
};

// A hairline between groups with a wider grab area, lit while dragged.
// One status bar for the workspace: every group keeps the bar's row, so the
// editors end on one line, but only the focused group draws its items. A
// narrow bar drops items by their priority (lib/code/statusBar.ts).
const STATUS_CSS = `
[data-code-workspace] [data-code-group][data-group-idle] .cm-code-status > * { visibility: hidden; }`;

/** What each item of a tab's menu runs. */
const TAB_MENU_COMMANDS: Record<TabMenuAction, [CodeCommandId, Record<string, unknown>?]> = {
  close: ["file.close"],
  closeOthers: ["file.closeOthers"],
  closeRight: ["tabs.closeRight"],
  pin: ["tabs.pin"],
  keep: ["tabs.keep"],
  splitRight: ["split.right"],
  copyPath: ["file.copyPath"],
  copyRelative: ["file.copyPath", { relative: true }],
  reveal: ["file.reveal"],
};

type Overlay =
  | { kind: "quickOpen"; query?: string }
  | { kind: "switcher"; held: boolean }
  | { kind: "groupTabs"; groupId: string }
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
  const sizeKey = useDerivedSize(
    rootRef,
    (w, h) => `${Math.round(w / SIZE_QUANTUM) * SIZE_QUANTUM}x${Math.round(h / SIZE_QUANTUM) * SIZE_QUANTUM}`,
    () => "0x0",
  );
  const size = useMemo(() => {
    const [w, h] = sizeKey.split("x").map(Number);
    return { w, h };
  }, [sizeKey]);
  const live = useRef({ props, ws, tabActive, convex, size });
  live.current = { props, ws, tabActive, convex, size };

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

  /** The tab a tab verb acts on: the one a tab's menu names (args.group is
   *  the group's key, `<instance>:<id>`), else the active tab of the
   *  command's group. Null when the command belongs to another workspace. */
  const tabFor = (args: Record<string, unknown> | undefined, ctx: CodeCommandContext | undefined): { group: WsGroup; path: string } | null => {
    const key = typeof args?.group === "string" ? args.group : null;
    if (key && !key.startsWith(`${instance}:`)) return null;
    const group = groupById(live.current.ws, key ? key.slice(instance.length + 1) : groupFor(ctx));
    const path = typeof args?.path === "string" ? args.path : group?.active;
    return group && path && group.tabs.some((t) => t.path === path) ? { group, path } : null;
  };

  /** Split a group, when it has room; false (vim's E36) when it has none. */
  const split = (groupId: string, path: string, dir: SplitDirection, opts?: { at?: string; preview?: boolean }) => {
    if (!roomToSplit(live.current.ws, groupId, dir, live.current.size)) return false;
    A.split(vaultId, groupId, path, dir, opts);
    return true;
  };

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

  /** Run a layout verb with the command's group focused; false when the
   *  command came from another workspace. */
  const onGroup = (ctx: CodeCommandContext | undefined, verb: () => void) => {
    const g = groupFor(ctx);
    if (!g) return false;
    A.focusGroup(vaultId, g);
    verb();
  };
  const axisOf = (args: Record<string, unknown> | undefined) => (args?.axis === "height" ? "height" : "width");

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

  // The `:` line's Tab completion reads this folder's files and tabs.
  useMountEffect(() =>
    registerExCompletionSource((view) => {
      if (!groupKeyOfView(view)?.startsWith(`${instance}:`)) return null;
      return {
        files: () => useVaultStore.getState().files,
        tabs: () => [...new Set(mruTabs(live.current.ws).map((e) => e.path))].filter((p) => !isVirtualTab(p)),
      };
    }),
  );

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
        const splitDir = args?.split === "right" || args?.split === "down" ? args.split : null;
        if (splitDir) return split(g, path, splitDir, { at });
        A.open(vaultId, path, { groupId: g, at });
      },
      "file.close": (args, ctx) => {
        const t = tabFor(args, ctx);
        if (!t) return false;
        A.close(vaultId, t.group.id, t.path);
      },
      "file.closeOthers": (args, ctx) => {
        const t = tabFor(args, ctx);
        if (!t) return false;
        A.closeOthers(vaultId, t.group.id, t.path);
      },
      "tabs.closeRight": (args, ctx) => {
        const t = tabFor(args, ctx);
        if (!t) return false;
        A.closeToRight(vaultId, t.group.id, t.path);
      },
      "tabs.pin": (args, ctx) => {
        const t = tabFor(args, ctx);
        if (!t) return false;
        A.pin(vaultId, t.group.id, t.path);
      },
      "tabs.keep": (args, ctx) => {
        const t = tabFor(args, ctx);
        if (!t) return false;
        A.keepOpen(vaultId, t.group.id, t.path);
      },
      "file.reopenClosed": (_a, ctx) => {
        if (!groupFor(ctx) || !live.current.ws.closed.length) return false;
        A.reopen(vaultId);
      },
      "file.copyPath": (args, ctx) => {
        const t = tabFor(args, ctx);
        if (!t || isVirtualTab(t.path)) return false;
        copy(args?.relative ? t.path : absolute(t.path));
      },
      "file.reveal": (args, ctx) => {
        const t = tabFor(args, ctx);
        if (!t || isVirtualTab(t.path)) return false;
        live.current.props.onToggleTree(true);
        useVaultStore.getState().requestReveal(t.path);
      },
      // The breadcrumbs take focus at the file's own crumb; arrows walk them
      // and Escape comes back (CodeFileBar).
      "breadcrumbs.focus": (_a, ctx) => {
        const g = groupFor(ctx);
        const crumb = g && rootRef.current?.querySelector<HTMLElement>(`[data-code-group="${g}"] [data-crumbs] [aria-current]`);
        if (!crumb) return false;
        crumb.focus();
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
      "split.right": (args, ctx) => {
        const t = tabFor(args, ctx);
        if (!t) return false;
        return split(t.group.id, t.path, "right");
      },
      "split.down": (_a, ctx) => {
        const group = groupById(live.current.ws, groupFor(ctx));
        if (!group?.active) return false;
        return split(group.id, group.active, "down");
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
      "tabs.alternate": (_a, ctx) => {
        const g = groupFor(ctx);
        if (!g) return false;
        A.focusGroup(vaultId, g);
        const alt = alternateTab(live.current.ws);
        if (!alt) return false;
        A.activate(vaultId, alt.groupId, alt.path);
      },
      // Window commands act on the group the command came from.
      "split.equalize": (_a, ctx) => onGroup(ctx, () => A.equalize(vaultId)),
      "split.maximize": (args, ctx) => onGroup(ctx, () => A.maximize(vaultId, axisOf(args))),
      "split.resize": (args, ctx) => onGroup(ctx, () => A.resize(vaultId, axisOf(args), typeof args?.by === "number" ? args.by : 1)),
      "split.exchange": (_a, ctx) => onGroup(ctx, () => A.exchange(vaultId)),
      "split.rotate": (args, ctx) => onGroup(ctx, () => A.rotate(vaultId, args?.delta === -1 ? -1 : 1)),
      "split.moveToEdge": (args, ctx) => onGroup(ctx, () => A.moveToEdge(vaultId, (args?.edge as GroupEdge) ?? "left")),
      "focus.previous": (_a, ctx) => {
        if (!groupFor(ctx)) return false;
        const target = previousGroup(live.current.ws);
        if (target) A.focusGroup(vaultId, target);
        return !!target;
      },
      "focus.cycle": (args, ctx) => {
        const g = groupFor(ctx);
        if (!g) return false;
        A.focusGroup(vaultId, g);
        const w = live.current.ws;
        const target = args?.to === "first" ? w.groups[0].id : args?.to === "last" ? w.groups[w.groups.length - 1].id : cycleGroup(w, args?.delta === -1 ? -1 : 1);
        if (target) A.focusGroup(vaultId, target);
        return !!target;
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
    const w = live.current.ws;
    const group = activeGroup(w);
    if (!surfaceHasFocus()) return false;
    // An empty group in a split closes, as in Zed; the last one leaves the
    // press to the app.
    if (!group.active) {
      if (w.groups.length < 2) return false;
      A.closeGroup(vaultId, group.id);
      return true;
    }
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
    return !!group.active && split(group.id, group.active, "right");
  });

  // ── render ────────────────────────────────────────────────────────────────

  // A tab's menu runs the same commands the palette and the keys do, on the
  // tab it was opened on.
  const onMenu = useCallback(
    (groupId: string, action: TabMenuAction, path: string) => {
      const [id, extra] = TAB_MENU_COMMANDS[action];
      runCodeCommand(id, { ...extra, group: `${instance}:${groupId}`, path }, { source: "menu" });
    },
    [instance],
  );
  const handlers = useMemo(
    () => ({
      onFocusGroup: (g: string) => A.focusGroup(vaultId, g),
      onActivate: (g: string, p: string) => A.activate(vaultId, g, p),
      onClose: (g: string, p: string) => A.close(vaultId, g, p),
      onKeep: (g: string, p: string) => A.keepOpen(vaultId, g, p),
      onOpen: (g: string, p: string) => A.open(vaultId, p, { groupId: g, preview: true }),
      onMove: (from: string, p: string, to: string, i: number) => A.move(vaultId, from, p, to, i),
      onSplit: (g: string) => {
        const group = groupById(live.current.ws, g);
        if (group?.active) split(g, group.active, "right");
      },
      onListTabs: (g: string) => setOverlay({ kind: "groupTabs", groupId: g }),
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

  const closeOverlay = useCallback(() => setOverlay(null), []);

  // Focus that was in the workspace stays in it when what held it goes away:
  // a tab or a group closing by any route (Cmd-W, :q, the close button, a
  // file deleted on disk), or a dialog closing. It lands on the focused
  // group's editor, else on the group's body, never on <body>, where the
  // next Cmd-W would close the app tab.
  const lastFocus = useRef<Element | null>(null);
  useMountEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onIn = (e: FocusEvent) => void (lastFocus.current = e.target as Element);
    // Focus the person moved out (a click elsewhere) is theirs; only focus
    // whose element was removed comes back.
    const onOut = (e: FocusEvent) => {
      const el = e.target as Element;
      queueMicrotask(() => {
        if (el.isConnected && lastFocus.current === el && !root.contains(document.activeElement)) lastFocus.current = null;
      });
    };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    return () => {
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut);
    };
  });
  useWatchEffect(() => {
    const raf = requestAnimationFrame(() => {
      const was = lastFocus.current;
      const now = document.activeElement;
      if (!was || was.isConnected || (now && now !== document.body)) return;
      focusGroup(`${instance}:${live.current.ws.activeGroup}`);
    });
    return () => cancelAnimationFrame(raf);
  }, [ws, overlay]);

  const horizontal = ws.orientation === "horizontal";
  const groups = ws.groups;
  const multi = groups.length > 1;
  const lanes = lanesOf(ws);
  const blocks = useMemo(() => laneGroups(ws), [ws]);
  const rects = useMemo(() => groupRects(ws), [ws]);
  // Each split's minimum share: its pixel floor over its own length. Lanes
  // run along the outer axis; the groups in a lane across it.
  const outerPx = horizontal ? size.w : size.h;
  const innerPx = horizontal ? size.h : size.w;
  const outerFloor = horizontal ? MIN_GROUP_PX.width : MIN_GROUP_PX.height;
  const innerFloor = horizontal ? MIN_GROUP_PX.height : MIN_GROUP_PX.width;
  const outerOrientation = horizontal ? "horizontal" : "vertical";
  const innerOrientation = horizontal ? "vertical" : "horizontal";

  const renderGroup = (g: WsGroup) => {
    const r = rects.get(g.id);
    const top = !r || r.y < 1e-6;
    return (
      <EditorGroup
        instance={instance}
        vaultId={vaultId}
        group={g}
        focused={multi ? g.id === ws.activeGroup : true}
        leftInset={!treeOpen && top && (!r || r.x < 1e-6)}
        rightInset={top && (!r || r.x + r.w > 1 - 1e-6)}
        canSplit={roomToSplit(ws, g.id, "right", size)}
        groupNumber={groupNumbers?.get(g.id)}
        recent={g.tabs.length ? NO_RECENT : recent}
        deepLinking={!!props.deepLinking}
        renderNote={renderNote}
        onMenu={onMenu}
        {...handlers}
      />
    );
  };

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
      <SplitRun
        key={outerOrientation}
        orientation={outerOrientation}
        ids={blocks.map((b) => `lane:${b[0].id}`)}
        sizes={ws.sizes}
        minSize={minShare(outerPx, blocks.length, outerFloor)}
        onSizes={(sizes) => A.sizes(vaultId, null, sizes)}
      >
        {(laneId, li) => (
          <SplitRun
            orientation={innerOrientation}
            ids={blocks[li].map((g) => g.id)}
            sizes={lanes[li]?.sizes ?? null}
            minSize={minShare(innerPx, blocks[li].length, innerFloor)}
            onSizes={(sizes) => A.sizes(vaultId, li, sizes)}
          >
            {(_id, gi) => renderGroup(blocks[li][gi])}
          </SplitRun>
        )}
      </SplitRun>
      {overlay?.kind === "quickOpen" && (
        <QuickOpen
          vaultId={vaultId}
          root={props.vaultRoot}
          activePath={activeOf(ws)}
          initialQuery={overlay.query}
          recent={recent}
          onClose={closeOverlay}
          onGotoLine={(at) => {
            const group = activeGroup(live.current.ws);
            setOverlay(null);
            if (group.active) A.activate(vaultId, group.id, group.active, at);
          }}
          onOpen={(path, at, toSide) => {
            setOverlay(null);
            const group = activeGroup(live.current.ws);
            // No room beside it: the file opens here.
            if (!(toSide && split(group.id, path, "right", { at, preview: true }))) A.open(vaultId, path, { preview: true, at });
          }}
          onSymbols={(scope, query) => {
            setOverlay(null);
            // Once the dialog is gone and focus is back in the editor (contract 9).
            setTimeout(() => runCodeCommand(scope === "file" ? "goto.symbol" : "goto.workspaceSymbol", { query }, { source: "palette" }), 0);
          }}
          onOpenLocal={(localPath, at) => {
            setOverlay(null);
            navigateToFiles(filesHref({ localPath, line: at }));
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
      {overlay?.kind === "groupTabs" && (
        <GroupTabList
          vaultId={vaultId}
          group={groupById(ws, overlay.groupId)}
          onClose={closeOverlay}
          onPick={(e) => {
            setOverlay(null);
            A.activate(vaultId, e.groupId, e.path);
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

/** One group's tabs, in strip order, from its overflow count. */
function GroupTabList({ vaultId, group, onPick, onClose }: { vaultId: string; group: WsGroup | undefined; onPick(e: MruEntry): void; onClose(): void }) {
  const entries = useMemo(() => (group ? group.tabs.map((t) => ({ groupId: group.id, path: t.path })) : []), [group]);
  const pinned = useMemo(() => new Set(group?.tabs.filter((t) => t.pinned).map((t) => t.path)), [group]);
  if (!group || !entries.length) return null;
  return (
    <TabSwitcher
      vaultId={vaultId}
      entries={entries}
      groupNumbers={null}
      held={false}
      initial={Math.max(0, entries.findIndex((e) => e.path === group.active))}
      pinned={pinned}
      onClose={onClose}
      onPick={onPick}
    />
  );
}

export default CodeWorkspace;

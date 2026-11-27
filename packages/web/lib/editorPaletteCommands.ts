// The editor commands the command palette offers while the Files workspace
// has the stage. Each runs through the code command registry
// (lib/code/commands), the same path vim's ex adapters and the editor's keys
// take, so the palette's "Diff vs HEAD" and `:Gdiffsplit` are one code path.

import type { ComponentType } from "react";
import {
  AlignLeft,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpToLine,
  ChevronsRight,
  CircleAlert,
  Copy,
  FolderSearch,
  GitMerge,
  Lightbulb,
  Pin,
  Replace,
  Save,
  SaveAll,
  Columns2,
  CornerDownRight,
  Eye,
  FileSearch,
  GitCompare,
  GitCompareArrows,
  Hash,
  ListTree,
  Undo2,
  Link2,
  MessageSquareCode,
  PencilLine,
  Quote,
  Rows2,
  Search,
  Settings2,
  SquareFunction,
  SquarePlus,
  SquareTerminal,
  SquareX,
  UserSquare2,
  Waypoints,
  X,
} from "lucide-react";
import { codeCommandLabel, runCodeCommand, type CodeCommandId } from "./code/commands";
import type { ShortcutAction } from "../shortcuts/registry";
import { useInboxStore } from "../store/inboxStore";
import { queryNamesPage } from "./navPages";
import { isMac } from "../shortcuts";

export interface EditorPaletteCommand {
  /** Several entries may run one command with different `args`. */
  id: CodeCommandId;
  label: string;
  /** Extra words the palette matches on. */
  keywords: string;
  icon: ComponentType<{ className?: string }>;
  shortcut?: ShortcutAction;
  /** A key the editor itself claims (not an app shortcut), as an Electron
   *  accelerator ("CommandOrControl+L"). */
  editorKey?: string;
  args?: Record<string, unknown>;
}

/** A key unique among the entries (an id can repeat with other args). */
export function editorPaletteKey(cmd: EditorPaletteCommand): string {
  return cmd.args ? `${cmd.id} ${JSON.stringify(cmd.args)}` : cmd.id;
}

/** The name a command shows now: its state-aware name once the editor has
 *  registered one ("Vim: turn on"), else the fixed one. */
export function editorPaletteLabel(cmd: EditorPaletteCommand): string {
  // An entry with its own args names its own variant.
  return (cmd.args ? undefined : codeCommandLabel(cmd.id)) ?? cmd.label;
}

/** With Files focused, the Editor group paints first when the query starts
 *  one of its commands' names ("split", "close", "search", "quote"), above the
 *  app's pane and page commands that share the word. */
export function editorCommandsLead(query: string): boolean {
  return queryNamesPage(EDITOR_PALETTE_COMMANDS.map((c) => ({ page: {}, label: c.label })), query, 4);
}

export const EDITOR_PALETTE_COMMANDS: readonly EditorPaletteCommand[] = [
  { id: "quickOpen", label: "Go to file", keywords: "quick open find file ctrlp fzf", icon: FileSearch, shortcut: "code.quickOpen" },
  { id: "search.project", label: "Search in project", keywords: "grep find text ripgrep", icon: Search, shortcut: "vault.search" },
  { id: "search.project", label: "Replace in project", keywords: "grep find substitute sed", icon: Replace, editorKey: "CommandOrControl+Shift+H", args: { replace: true } },
  { id: "search.next", label: "Next search result", keywords: "match find", icon: ArrowDown, editorKey: "F4" },
  { id: "search.prev", label: "Previous search result", keywords: "match find", icon: ArrowUp, editorKey: "Shift+F4" },
  { id: "goto.symbol", label: "Go to symbol in file", keywords: "outline function class method @ ctags", icon: ListTree, editorKey: "CommandOrControl+Shift+O" },
  { id: "goto.workspaceSymbol", label: "Go to symbol in project", keywords: "workspace symbol function class # find", icon: SquareFunction, editorKey: "CommandOrControl+Alt+O" },
  { id: "lsp.definition", label: "Go to definition", keywords: "jump declaration gd lsp", icon: CornerDownRight, editorKey: "F12" },
  { id: "lsp.references", label: "Find references", keywords: "usages callers gr lsp", icon: Waypoints, editorKey: "Shift+F12" },
  { id: "lsp.rename", label: "Rename symbol", keywords: "refactor lsp", icon: PencilLine, editorKey: "F2" },
  { id: "lsp.codeAction", label: "Code actions", keywords: "quick fix refactor lightbulb lsp", icon: Lightbulb, editorKey: "CommandOrControl+." },
  { id: "lsp.format", label: "Format document", keywords: "prettier formatter lsp", icon: AlignLeft, editorKey: "Shift+Alt+F" },
  { id: "diagnostic.next", label: "Next problem", keywords: "error warning diagnostic lsp", icon: CircleAlert, editorKey: "F8" },
  { id: "diagnostic.prev", label: "Previous problem", keywords: "error warning diagnostic lsp", icon: CircleAlert, editorKey: "Shift+F8" },
  { id: "goto.line", label: "Go to line", keywords: "jump number :", icon: Hash, editorKey: "Control+G" },
  { id: "tabs.goto", label: "Go to first tab", keywords: "tab number 1", icon: ArrowLeftToLine, editorKey: "CommandOrControl+1", args: { index: 0 } },
  { id: "tabs.goto", label: "Go to last tab", keywords: "tab number 9 end", icon: ArrowRightToLine, editorKey: "CommandOrControl+9", args: { index: Number.MAX_SAFE_INTEGER } },
  { id: "breadcrumbs.focus", label: "Focus breadcrumbs", keywords: "path folders crumbs navigate", icon: ChevronsRight, editorKey: "CommandOrControl+Shift+." },
  { id: "nav.back", label: "Go back", keywords: "history previous location jump ctrl-o", icon: ArrowLeft, editorKey: isMac ? "Control+-" : "Alt+Left" },
  { id: "nav.forward", label: "Go forward", keywords: "history next location jump ctrl-i", icon: ArrowRight, editorKey: isMac ? "Control+Shift+-" : "Alt+Right" },
  { id: "git.diffHead", label: "Diff vs HEAD", keywords: "git changes review compare", icon: GitCompare },
  { id: "git.diffHead", label: "Diff against…", keywords: "git compare ref branch sha session base merge", icon: GitCompareArrows, args: { pick: true } },
  { id: "git.diffHead", label: "Diff side by side", keywords: "git compare split two pane", icon: Columns2, args: { layout: "split" } },
  { id: "git.nextHunk", label: "Next change", keywords: "git hunk ]c", icon: ArrowDownToLine, editorKey: "Alt+F5" },
  { id: "git.prevHunk", label: "Previous change", keywords: "git hunk [c", icon: ArrowUpToLine, editorKey: "Shift+Alt+F5" },
  { id: "git.peekHunk", label: "Peek change", keywords: "git hunk old lines show", icon: Eye, editorKey: "CommandOrControl+'" },
  { id: "git.revertHunk", label: "Revert change", keywords: "git hunk undo restore old lines", icon: Undo2 },
  { id: "blame.toggle", label: "Toggle session blame", keywords: "git blame who wrote", icon: UserSquare2 },
  { id: "agent.quoteSelection", label: "Quote selection to session", keywords: "agent ask send composer cmd-l", icon: Quote, editorKey: "CommandOrControl+L" },
  { id: "agent.inlineInstruction", label: "Instruct session here", keywords: "agent edit change prompt cmd-k inline", icon: MessageSquareCode, editorKey: "CommandOrControl+K" },
  { id: "agent.nextEdit", label: "Next agent edit", keywords: "agent change wrote ]a", icon: ArrowDownToLine, editorKey: "Alt+F6" },
  { id: "agent.prevEdit", label: "Previous agent edit", keywords: "agent change wrote [a", icon: ArrowUpToLine, editorKey: "Shift+Alt+F6" },
  { id: "agent.pickSession", label: "Link session", keywords: "agent conversation folder linked choose", icon: Link2 },
  { id: "agent.newSession", label: "New session here", keywords: "agent start conversation folder", icon: SquarePlus },
  { id: "split.right", label: "Split editor right", keywords: "split group side", icon: Columns2, shortcut: "code.splitRight" },
  { id: "split.down", label: "Split editor down", keywords: "split group below", icon: Rows2 },
  { id: "file.save", label: "Save", keywords: "write :w", icon: Save, editorKey: "CommandOrControl+S" },
  { id: "file.saveAll", label: "Save all", keywords: "write every :wa", icon: SaveAll, editorKey: "CommandOrControl+Alt+S" },
  { id: "file.close", label: "Close file", keywords: "close tab buffer", icon: X, shortcut: "code.closeTab" },
  { id: "file.closeOthers", label: "Close other tabs", keywords: "close tab buffer only", icon: X },
  { id: "tabs.closeRight", label: "Close tabs to the right", keywords: "close tab buffer", icon: X },
  { id: "tabs.pin", label: "Pin or unpin tab", keywords: "tab keep sticky", icon: Pin },
  { id: "tabs.keep", label: "Keep tab open", keywords: "preview tab", icon: Pin },
  { id: "file.copyPath", label: "Copy path", keywords: "absolute file clipboard", icon: Copy },
  { id: "file.copyPath", label: "Copy relative path", keywords: "file clipboard", icon: Copy, args: { relative: true } },
  { id: "file.reveal", label: "Reveal in file tree", keywords: "explorer sidebar locate", icon: FolderSearch },
  { id: "focus.left", label: "Focus group left", keywords: "split pane window", icon: ArrowLeft, editorKey: "CommandOrControl+Alt+ArrowLeft" },
  { id: "focus.right", label: "Focus group right", keywords: "split pane window", icon: ArrowRight, editorKey: "CommandOrControl+Alt+ArrowRight" },
  { id: "focus.up", label: "Focus group above", keywords: "split pane window", icon: ArrowUp, editorKey: "CommandOrControl+Alt+ArrowUp" },
  { id: "focus.down", label: "Focus group below", keywords: "split pane window", icon: ArrowDown, editorKey: "CommandOrControl+Alt+ArrowDown" },
  { id: "split.close", label: "Close split", keywords: "close group pane", icon: SquareX },
  { id: "merge.withDisk", label: "Merge with disk", keywords: "conflict changed on disk three way", icon: GitMerge },
  { id: "merge.takeDisk", label: "Take disk version", keywords: "conflict changed on disk discard", icon: GitMerge },
  { id: "merge.keepMine", label: "Keep my version", keywords: "conflict changed on disk overwrite", icon: GitMerge },
  { id: "merge.next", label: "Next conflict", keywords: "merge difference", icon: ArrowDownToLine, editorKey: "Alt+F5" },
  { id: "merge.prev", label: "Previous conflict", keywords: "merge difference", icon: ArrowUpToLine, editorKey: "Shift+Alt+F5" },
  { id: "vim.toggle", label: "Vim: turn on or off", keywords: "vim mode keys modal", icon: SquareTerminal },
  { id: "settings.open", label: "Editor settings", keywords: "preferences vimrc options language servers", icon: Settings2 },
];

/**
 * Run a palette command once the palette has closed and focus is back in the
 * workspace: a handler reads the focused group, and the palette's input held
 * focus while it was open. Editor settings opens even before the editor chunk
 * has registered its handler.
 */
export function runEditorPaletteCommand(cmd: EditorPaletteCommand): void {
  setTimeout(() => {
    const ran = runCodeCommand(cmd.id, cmd.args, { source: "palette" });
    if (!ran && cmd.id === "settings.open") useInboxStore.getState().openSettingsModal("editor");
  }, 0);
}

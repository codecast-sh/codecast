// The editor commands the command palette offers while the Files workspace
// has the stage. Each runs through the code command registry
// (lib/code/commands), the same path vim's ex adapters and the editor's keys
// take, so the palette's "Diff vs HEAD" and `:Gdiffsplit` are one code path.

import type { ComponentType } from "react";
import { Columns2, FileSearch, GitCompare, Search, Settings2, SquareTerminal, UserSquare2 } from "lucide-react";
import { runCodeCommand, type CodeCommandId } from "./code/commands";
import type { ShortcutAction } from "../shortcuts/registry";
import { useInboxStore } from "../store/inboxStore";

export interface EditorPaletteCommand {
  id: CodeCommandId;
  label: string;
  /** Extra words the palette matches on. */
  keywords: string;
  icon: ComponentType<{ className?: string }>;
  shortcut?: ShortcutAction;
  args?: Record<string, unknown>;
}

export const EDITOR_PALETTE_COMMANDS: readonly EditorPaletteCommand[] = [
  { id: "quickOpen", label: "Go to file", keywords: "quick open find file ctrlp fzf", icon: FileSearch, shortcut: "code.quickOpen" },
  { id: "search.project", label: "Search in project", keywords: "grep find text ripgrep", icon: Search, shortcut: "vault.search" },
  { id: "git.diffHead", label: "Diff vs HEAD", keywords: "git changes review compare", icon: GitCompare },
  { id: "blame.toggle", label: "Toggle session blame", keywords: "git blame who wrote", icon: UserSquare2 },
  { id: "split.right", label: "Split editor right", keywords: "split group side", icon: Columns2, shortcut: "code.splitRight" },
  { id: "vim.toggle", label: "Toggle vim", keywords: "vim mode keys modal", icon: SquareTerminal },
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

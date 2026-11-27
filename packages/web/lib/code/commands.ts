// The code workspace's command registry: one id per thing a person can ask the
// editor to do. Vim ex adapters (lib/code/vim), the command palette, editor
// keymaps and shortcut handlers all run commands through here, so `:w`, Cmd-S
// and the palette's "Save" are one code path.
//
// The workspace shell registers handlers while it is mounted; a command with no
// handler is a no-op that reports false, so a vim map pointing at a feature that
// is not mounted (no project search on a remote vault, say) degrades quietly.
// No React and no store here: this module must load inside the editor chunk.

import type { EditorView } from "@codemirror/view";

export const CODE_COMMAND_IDS = [
  // files
  "file.save",
  "file.saveAll",
  "file.saveAndClose", // vim's :wq / :x; close only once the write lands. Unhandled: vim runs file.save then file.close
  // The tab verbs take args?: { group?: "<workspace>:<group id>"; path?: string }
  // (a tab's menu names its tab); without them, the active tab of the
  // command's group.
  "file.close",
  "file.closeOthers",
  "file.reopenClosed",
  "file.open", // args: { path: string; line?: number; column?: number; split?: "right" | "down" }
  "file.revert",
  "file.overwrite", // vim's :w!: write a file its mode refuses (0444), after the confirm
  "file.copyPath", // args?: { relative?: boolean }
  "file.reveal",
  "tabs.pin", // pins, or unpins a pinned tab
  "tabs.closeRight",
  "tabs.keep", // a preview tab stays open
  // a file changed on disk under unsaved edits (the conflict strip's verbs)
  "merge.withDisk",
  "merge.takeDisk",
  "merge.keepMine",
  "merge.next",
  "merge.prev",
  "breadcrumbs.focus",
  // navigation
  "quickOpen", // args?: { query?: string }
  "tabs.switcher",
  "tabs.next",
  "tabs.prev",
  "tabs.goto", // args: { index: number }
  "tabs.alternate", // vim's :b# and <C-^>: the tab used before this one
  "goto.line", // args?: { line?: number }
  "goto.symbol", // args?: { query?: string; container?: string | null; current?: string }
  "goto.workspaceSymbol", // args?: { query?: string }
  "nav.back",
  "nav.forward",
  // layout
  "split.right",
  "split.down",
  "split.close",
  "split.only",
  "split.equalize",
  "split.maximize", // args: { axis: "width" | "height" }
  "split.resize", // args: { axis: "width" | "height"; by: number (percent, negative shrinks) }
  "split.exchange",
  "split.rotate", // args?: { delta: 1 | -1 }
  "split.moveToEdge", // args: { edge: "left" | "right" | "top" | "bottom" }
  "focus.left",
  "focus.right",
  "focus.up",
  "focus.down",
  "focus.previous", // vim's <C-w>p: the group focused before this one
  "focus.cycle", // args: { delta: 1 | -1 } in layout order, wrapping; or { to: "first" | "last" }
  "tree.toggle",
  "tree.reveal",
  "terminal.toggle",
  // search
  "search.project", // args?: { query?: string; regex?: boolean; replace?: boolean }
  "search.openEditor", // the results as an editable multibuffer, in a workspace tab
  "search.next",
  "search.prev",
  // git and review
  "git.diffHead",
  "git.diffAgainst", // args: { ref: string; label?: string; layout?: "split" | "unified" }
  "git.nextHunk",
  "git.prevHunk",
  "git.revertHunk",
  "git.peekHunk",
  "blame.toggle",
  // language
  "lsp.definition",
  "lsp.references",
  "lsp.hover",
  "lsp.rename",
  "lsp.format",
  "lsp.codeAction",
  "diagnostic.next",
  "diagnostic.prev",
  // agents
  "agent.quoteSelection",
  "agent.inlineInstruction",
  "agent.newSession",
  "agent.nextEdit", // ]a: the next range an agent wrote while the file was open
  "agent.prevEdit", // [a
  "agent.dismissEdits",
  "agent.pickSession", // the linked-session picker for this folder
  // editor settings
  "vim.toggle",
  "vim.reloadConfig",
  "settings.open",
] as const;

export type CodeCommandId = (typeof CODE_COMMAND_IDS)[number];

/** What a handler is told about where the command came from. */
export interface CodeCommandContext {
  /** The editor the command was issued in, when there is one. */
  view?: EditorView;
  source: "vim" | "keymap" | "palette" | "shortcut" | "menu" | "api";
}

export type CodeCommandHandler = (args: Record<string, unknown> | undefined, ctx: CodeCommandContext) => boolean | void | Promise<unknown>;

const handlers = new Map<CodeCommandId, CodeCommandHandler[]>();

/** Register a handler; returns the unregister function. The most recently
 *  registered handler wins, so a focused split group can shadow the shell's
 *  default for as long as it is mounted. */
export function registerCodeCommand(id: CodeCommandId, handler: CodeCommandHandler): () => void {
  const list = handlers.get(id) ?? [];
  list.push(handler);
  handlers.set(id, list);
  return () => {
    const current = handlers.get(id);
    if (!current) return;
    const i = current.lastIndexOf(handler);
    if (i >= 0) current.splice(i, 1);
    if (current.length === 0) handlers.delete(id);
  };
}

/** Register several at once; returns one function that unregisters them all. */
export function registerCodeCommands(map: Partial<Record<CodeCommandId, CodeCommandHandler>>): () => void {
  const offs = (Object.entries(map) as [CodeCommandId, CodeCommandHandler][]).map(([id, h]) => registerCodeCommand(id, h));
  return () => offs.forEach((off) => off());
}

/** Run a command. True when a handler took it (a handler returning `false`
 *  declines and lets an older handler try). */
export function runCodeCommand(id: CodeCommandId, args?: Record<string, unknown>, ctx: CodeCommandContext = { source: "api" }): boolean {
  const list = handlers.get(id);
  if (!list) return false;
  for (let i = list.length - 1; i >= 0; i--) {
    const result = list[i](args, ctx);
    if (result !== false) return true;
  }
  return false;
}

export function hasCodeCommand(id: CodeCommandId): boolean {
  return (handlers.get(id)?.length ?? 0) > 0;
}

const labels = new Map<CodeCommandId, () => string>();

/** A command whose name depends on state (vim on or off) says what running it
 *  would do now; menus read it through codeCommandLabel when they draw. */
export function registerCodeCommandLabel(id: CodeCommandId, label: () => string): void {
  labels.set(id, label);
}

export function codeCommandLabel(id: CodeCommandId): string | undefined {
  return labels.get(id)?.();
}

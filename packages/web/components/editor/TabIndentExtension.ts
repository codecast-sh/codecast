import { Extension, type Editor } from "@tiptap/core";

/**
 * Tiptap tries keyboard bindings in descending priority, stopping at the first
 * handler that returns true, so anything below the default priority (100) runs
 * only as a fallback. ListItem/TaskItem/CodeBlock bind Tab at the default
 * priority — we stay under them so list indentation still wins in its own
 * context. (The relationship is guarded by TabIndentExtension.test.ts.)
 */
export const TAB_INDENT_PRIORITY = 10;

/** Tab: insert a real tab character. Returns true to swallow the browser
 *  default, which would otherwise move focus out of the editor. */
export function handleTab(editor: Editor): boolean {
  return editor.commands.insertContent("\t");
}

/** Shift-Tab: remove a preceding tab (outdent) if there is one; otherwise
 *  swallow the event so focus doesn't jump backward out of the editor. */
export function handleShiftTab(editor: Editor): boolean {
  const { from, empty } = editor.state.selection;
  if (empty && from > 0 && editor.state.doc.textBetween(from - 1, from) === "\t") {
    return editor.commands.deleteRange({ from: from - 1, to: from });
  }
  return true;
}

/**
 * Keeps the Tab key inside the editor.
 *
 * Without this, pressing Tab in a plain paragraph or heading does nothing in
 * ProseMirror, so the browser's default kicks in and moves focus to the next
 * focusable element — the chat input below the doc. This binds Tab as a
 * low-priority fallback (see {@link TAB_INDENT_PRIORITY}): list items, task
 * items, code blocks, and open mention/slash popups all get Tab first and only
 * fall through to here when the cursor isn't in their context.
 */
export const TabIndentExtension = Extension.create({
  name: "tabIndent",
  priority: TAB_INDENT_PRIORITY,
  addKeyboardShortcuts() {
    return {
      Tab: () => handleTab(this.editor),
      "Shift-Tab": () => handleShiftTab(this.editor),
    };
  },
});

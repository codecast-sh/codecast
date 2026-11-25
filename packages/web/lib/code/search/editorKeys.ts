// Project search keys inside every code editor: Cmd-Shift-H opens search with
// replace, F4 and Shift-F4 walk the results (VS Code's keys). Registered as an
// editor feature, so it rides the editor chunk and reaches every buffer.
// Cmd-Shift-F needs nothing here: it is an app chord the editor lets through
// (keyOwnership), and the Files page answers it.

import { keymap, type EditorView } from "@codemirror/view";
import { runCodeCommand, type CodeCommandId } from "../commands";
import { registerEditorFeature } from "../features";

const run = (id: CodeCommandId, args?: Record<string, unknown>) => (view: EditorView) => runCodeCommand(id, args, { view, source: "keymap" });

let registered = false;

export function registerSearchEditorKeys(): void {
  if (registered) return;
  registered = true;
  registerEditorFeature("search.keys", () =>
    keymap.of([
      { key: "Mod-Shift-h", preventDefault: true, run: run("search.project", { replace: true }) },
      { key: "F4", run: run("search.next") },
      { key: "Shift-F4", run: run("search.prev") },
    ]),
  );
}

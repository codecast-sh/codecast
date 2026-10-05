// The Edit menu's Undo and Redo.
//
// macOS hands a key equivalent to the menu bar before the page: with the
// stock `{ role: "undo" }` item, ⌘Z never reached the renderer's keydown, so
// the web app's own undo (docs/architecture/undo-history.md) was unreachable
// by keyboard in the desktop app, while ⌘J (no menu item) arrived as usual.
// These items keep the accelerators and decide per press where it goes:
//
//   - a focused text field (input, textarea, contenteditable, or a frame)
//     keeps its own text undo: webContents.undo() / redo(), what the role did;
//   - anything else is app undo: the renderer gets "app-edit-command", which
//     the web app runs as performUndo / performRedo;
//   - a page that is not one of ours (a browser pane) always gets the native
//     command.
//
// Holding ⌘Z repeats the key equivalent, and the menu has no repeat flag, so
// the last ⌘Z/⌘Y keydown per webContents is read from `before-input-event`,
// which Electron emits before menu shortcuts. A repeated press is one app
// undo, as in the browser (noRepeat in @platform/keys). Text undo still
// repeats, as it does natively.
//
// Policy only, so it tests without an Electron app: main.js hands it the
// focused-contents lookup and the trust check.

const APP_EDIT_COMMAND = "app-edit-command";

// Runs in the page: is focus somewhere that owns its own undo? The same rule
// as the web's isTextEditingControl (packages/web/lib/undoWalk.ts); the web's
// undoWalk.test runs this probe against that predicate, so they cannot drift.
const EDITABLE_PROBE = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body) return false;
  if (el.isContentEditable || el.tagName === "IFRAME") return true;
  if (el.tagName === "TEXTAREA") return !el.readOnly && !el.disabled;
  if (el.tagName === "INPUT") {
    return !el.readOnly && !el.disabled &&
      !/^(button|checkbox|radio|submit|reset|range|color|file|image|hidden|date|time|datetime-local|month|week)$/i.test(el.type || "");
  }
  return false;
})()`;

const isEditKey = (input) => {
  const key = String(input.key || "").toLowerCase();
  return input.type === "keyDown" && (input.meta || input.control) && (key === "z" || key === "y");
};

/**
 * @param {{
 *   focusedContents: () => (Electron.WebContents | null | undefined),
 *   isShell: (contents: Electron.WebContents) => boolean,
 * }} deps
 */
function createEditUndo({ focusedContents, isShell }) {
  const repeating = new WeakMap();

  /** Watch one webContents' keys for auto-repeat (web-contents-created). */
  function observe(contents) {
    contents.on("before-input-event", (_event, input) => {
      if (isEditKey(input)) repeating.set(contents, input.isAutoRepeat === true);
    });
  }

  /** @param {"undo" | "redo"} command @param {boolean} viaKey */
  async function run(command, viaKey) {
    const contents = focusedContents();
    if (!contents || contents.isDestroyed()) return "none";
    if (!isShell(contents)) {
      contents[command]();
      return "native";
    }
    let editable = true;
    try {
      editable = (await contents.executeJavaScript(EDITABLE_PROBE)) === true;
    } catch {
      // A page that cannot answer keeps the stock behaviour.
    }
    if (contents.isDestroyed()) return "none";
    if (editable) {
      contents[command]();
      return "native";
    }
    if (viaKey && repeating.get(contents)) return "repeat";
    contents.send(APP_EDIT_COMMAND, command);
    return "app";
  }

  /** The two Edit menu items that replace `{ role: "undo" }` / `{ role: "redo" }`. */
  function menuItems() {
    return [
      { label: "Undo", accelerator: "CmdOrCtrl+Z", click: (_item, _win, event) => { void run("undo", !!event?.triggeredByAccelerator); } },
      { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: (_item, _win, event) => { void run("redo", !!event?.triggeredByAccelerator); } },
    ];
  }

  return { observe, run, menuItems };
}

module.exports = { createEditUndo, APP_EDIT_COMMAND, EDITABLE_PROBE };

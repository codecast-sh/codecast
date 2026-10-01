// The right-click menu Chromium leaves to the embedder.
//
// Electron draws the red underline under a misspelled word but shows no menu
// at all, so the suggestions it already computed were unreachable and the
// underline was a dead end. Neither does macOS "Correct spelling
// automatically" reach a Chromium text field: that switch lives in Cocoa's
// text views. This menu is the only way to act on an underline.
//
// The web app opens its own menu on rows and cards and stands down on
// editable fields, links and live selections so this one answers there
// (components/ui/context-menu.tsx). A page that cancels `contextmenu` never
// reaches here, so the two never stack.
//
// Policy only, so it tests without an Electron app: main.js hands it the
// event's params and two actions, and pops what it returns.

const MAX_SUGGESTIONS = 5;

/**
 * @param {Electron.ContextMenuParams} params
 * @param {{ replace: (word: string) => void, learn: (word: string) => void }} act
 * @returns {Electron.MenuItemConstructorOptions[] | null} null shows nothing
 */
function contextMenuTemplate(params, act) {
  const { isEditable, misspelledWord, dictionarySuggestions = [], selectionText = "", editFlags = {} } = params;
  const hasSelection = selectionText.trim().length > 0;
  if (!isEditable && !hasSelection) return null;

  const items = [];
  if (isEditable && misspelledWord) {
    const guesses = dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    if (guesses.length === 0) items.push({ label: "No Guesses Found", enabled: false });
    for (const word of guesses) items.push({ label: word, click: () => act.replace(word) });
    items.push({ label: "Learn Spelling", click: () => act.learn(misspelledWord) });
    items.push({ type: "separator" });
  }
  if (isEditable) {
    items.push(
      { role: "cut", enabled: editFlags.canCut !== false },
      { role: "copy", enabled: editFlags.canCopy !== false },
      { role: "paste", enabled: editFlags.canPaste !== false },
      { type: "separator" },
      { role: "selectAll", enabled: editFlags.canSelectAll !== false },
    );
  } else {
    items.push({ role: "copy" });
  }
  return items;
}

/** Give one webContents the menu. */
function attachSpellMenu(contents, Menu) {
  contents.on("context-menu", (_event, params) => {
    const template = contextMenuTemplate(params, {
      replace: (word) => contents.replaceMisspelling(word),
      learn: (word) => contents.session.addWordToSpellCheckerDictionary(word),
    });
    if (template) Menu.buildFromTemplate(template).popup();
  });
}

module.exports = { contextMenuTemplate, attachSpellMenu, MAX_SUGGESTIONS };

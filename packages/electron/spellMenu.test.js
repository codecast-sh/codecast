// Run: node --test packages/electron/spellMenu.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { contextMenuTemplate, MAX_SUGGESTIONS } = require("./spellMenu");

function recorder() {
  const calls = [];
  return { calls, act: { replace: (w) => calls.push(["replace", w]), learn: (w) => calls.push(["learn", w]) } };
}
const labels = (items) => items.map((i) => i.label ?? i.role ?? i.type);

test("a misspelled word offers its suggestions first, and picking one replaces it", () => {
  const { calls, act } = recorder();
  const items = contextMenuTemplate(
    { isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "tech"], editFlags: {} },
    act,
  );
  assert.deepEqual(labels(items), ["the", "tech", "Learn Spelling", "separator", "cut", "copy", "paste", "separator", "selectAll"]);
  items[0].click();
  items[2].click();
  assert.deepEqual(calls, [["replace", "the"], ["learn", "teh"]]);
});

test("suggestions are capped and an empty guess list says so", () => {
  const many = contextMenuTemplate(
    { isEditable: true, misspelledWord: "x", dictionarySuggestions: ["a", "b", "c", "d", "e", "f", "g"] },
    recorder().act,
  );
  assert.equal(many.filter((i) => i.click && i.label !== "Learn Spelling").length, MAX_SUGGESTIONS);
  const none = contextMenuTemplate({ isEditable: true, misspelledWord: "qzx", dictionarySuggestions: [] }, recorder().act);
  assert.deepEqual(none[0], { label: "No Guesses Found", enabled: false });
});

test("a correctly spelled field gets edit actions only, honouring the edit flags", () => {
  const items = contextMenuTemplate({ isEditable: true, misspelledWord: "", editFlags: { canCut: false, canPaste: true } }, recorder().act);
  assert.deepEqual(labels(items), ["cut", "copy", "paste", "separator", "selectAll"]);
  assert.equal(items[0].enabled, false);
  assert.equal(items[2].enabled, true);
});

test("a selection outside a field offers Copy; plain page shows nothing", () => {
  assert.deepEqual(labels(contextMenuTemplate({ isEditable: false, selectionText: "hello" }, recorder().act)), ["copy"]);
  assert.equal(contextMenuTemplate({ isEditable: false, selectionText: "  " }, recorder().act), null);
});

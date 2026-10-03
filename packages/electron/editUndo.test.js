// Run: node --test packages/electron/editUndo.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createEditUndo, APP_EDIT_COMMAND } = require("./editUndo");

function fakeContents({ editable = false, shell = true, probeThrows = false } = {}) {
  const wc = new EventEmitter();
  wc.calls = [];
  wc.shell = shell;
  wc.isDestroyed = () => false;
  wc.undo = () => wc.calls.push("native:undo");
  wc.redo = () => wc.calls.push("native:redo");
  wc.send = (channel, cmd) => wc.calls.push(`${channel}:${cmd}`);
  wc.executeJavaScript = async () => {
    if (probeThrows) throw new Error("no frame");
    return editable;
  };
  return wc;
}

function setup(wc) {
  const edit = createEditUndo({ focusedContents: () => wc, isShell: (c) => c.shell });
  edit.observe(wc);
  return edit;
}

const key = (wc, { repeat = false, key = "z", meta = true } = {}) =>
  wc.emit("before-input-event", {}, { type: "keyDown", key, meta, control: false, isAutoRepeat: repeat });

test("outside a text field, Undo and Redo go to the web app", async () => {
  const wc = fakeContents();
  const edit = setup(wc);
  assert.equal(await edit.run("undo", true), "app");
  assert.equal(await edit.run("redo", true), "app");
  assert.deepEqual(wc.calls, [`${APP_EDIT_COMMAND}:undo`, `${APP_EDIT_COMMAND}:redo`]);
});

test("a focused text field keeps its own undo", async () => {
  const wc = fakeContents({ editable: true });
  const edit = setup(wc);
  assert.equal(await edit.run("undo", true), "native");
  assert.equal(await edit.run("redo", false), "native");
  assert.deepEqual(wc.calls, ["native:undo", "native:redo"]);
});

test("a page that is not ours always gets the native command", async () => {
  const wc = fakeContents({ shell: false });
  const edit = setup(wc);
  await edit.run("undo", true);
  assert.deepEqual(wc.calls, ["native:undo"]);
});

test("a page that cannot answer the probe keeps the stock behaviour", async () => {
  const wc = fakeContents({ probeThrows: true });
  const edit = setup(wc);
  await edit.run("undo", true);
  assert.deepEqual(wc.calls, ["native:undo"]);
});

test("holding the key is one app undo, while text undo still repeats", async () => {
  const wc = fakeContents();
  const edit = setup(wc);
  key(wc);
  assert.equal(await edit.run("undo", true), "app");
  key(wc, { repeat: true });
  assert.equal(await edit.run("undo", true), "repeat");
  assert.equal(await edit.run("undo", true), "repeat");
  // A click from the menu bar is never a repeat.
  assert.equal(await edit.run("undo", false), "app");
  // A fresh press steps again.
  key(wc);
  assert.equal(await edit.run("undo", true), "app");
  assert.equal(wc.calls.filter((c) => c.startsWith(APP_EDIT_COMMAND)).length, 3);

  const field = fakeContents({ editable: true });
  const fieldEdit = setup(field);
  key(field, { repeat: true });
  assert.equal(await fieldEdit.run("undo", true), "native");
});

test("the repeat flag only follows the edit chords", async () => {
  const wc = fakeContents();
  const edit = setup(wc);
  key(wc, { repeat: true });
  key(wc, { key: "j", repeat: false });
  assert.equal(await edit.run("undo", true), "repeat");
  key(wc, { key: "y", meta: false, repeat: false });
  // Ctrl+Y counts too (off mac it is redo).
  wc.emit("before-input-event", {}, { type: "keyDown", key: "y", meta: false, control: true, isAutoRepeat: false });
  assert.equal(await edit.run("redo", true), "app");
});

test("the menu items carry the accelerators and route through run", async () => {
  const wc = fakeContents();
  const edit = setup(wc);
  const [undo, redo] = edit.menuItems();
  assert.equal(undo.accelerator, "CmdOrCtrl+Z");
  assert.equal(redo.accelerator, "Shift+CmdOrCtrl+Z");
  assert.equal(undo.role, undefined);
  undo.click({}, null, { triggeredByAccelerator: true });
  redo.click({}, null, {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(wc.calls, [`${APP_EDIT_COMMAND}:undo`, `${APP_EDIT_COMMAND}:redo`]);
});

test("nothing focused does nothing", async () => {
  const edit = createEditUndo({ focusedContents: () => null, isShell: () => true });
  assert.equal(await edit.run("undo", true), "none");
});

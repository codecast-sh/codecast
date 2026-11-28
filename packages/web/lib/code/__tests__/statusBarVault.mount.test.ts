// A status item that reads the vault through the daemon is never mounted for
// an editor on a pseudo vault (the vimrc overlay), declared once with
// `needsVault`, and comes back when the same view shows a real file.
import { installEditorDom } from "../../../components/code/__tests__/editorDom";

installEditorDom();

const { expect, it } = await import("bun:test");
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { featureBase, registerStatusItem } = await import("../features");
const { statusBar } = await import("../statusBar");
const { bufferFields } = await import("../buffers");
const fields = () => bufferFields({ lineSeparator: "\n", bom: false, lossy: false } as never);

it("needsVault items skip a pseudo vault and mount for a real one", () => {
  const created: string[] = [];
  const item = (id: string, needsVault: boolean) =>
    registerStatusItem({
      id,
      side: "right",
      order: 50,
      needsVault,
      create: () => {
        created.push(id);
        const dom = document.createElement("span");
        dom.dataset.item = id;
        return { dom };
      },
    });
  const offs = [item("t.vault", true), item("t.plain", false)];
  const ctx = (isRealVault?: boolean) => ({ vaultId: "v", path: "a.ts", languageId: "typescript", languageName: "TypeScript", sizeBytes: 1, largeFile: false, ...(isRealVault === false ? { isRealVault } : {}) });
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: "x", extensions: [fields(), featureBase(ctx(false)), statusBar()] }) });
  const items = () => [...view.dom.querySelectorAll("[data-item]")].map((e) => (e as HTMLElement).dataset.item);
  expect(items()).toEqual(["t.plain"]);
  expect(created).not.toContain("t.vault");

  view.setState(EditorState.create({ doc: "y", extensions: [fields(), featureBase(ctx()), statusBar()] }));
  expect(items()).toEqual(["t.vault", "t.plain"]);
  view.destroy();
  parent.remove();
  offs.forEach((off) => off());
});

it("the cursor segment holds the widest label its document can show, so cursor moves never shift the bar", () => {
  const { cursorWidthCh } = require("../statusBar") as typeof import("../statusBar");
  const parent = document.createElement("div");
  document.body.append(parent);
  const doc = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [fields(), statusBar()] }) });
  const cursor = view.dom.querySelector(".cm-code-status-cursor") as HTMLElement;
  expect(cursor.style.minWidth).toBe(`${cursorWidthCh(120)}ch`);
  view.dispatch({ selection: { anchor: doc.length } });
  expect(cursor.textContent).toBe("Ln 120, Col 9");
  expect(cursor.style.minWidth).toBe(`${cursorWidthCh(120)}ch`);
  // The line count gaining a digit widens it.
  view.dispatch({ changes: { from: 0, insert: "\n".repeat(900) } });
  expect(cursor.style.minWidth).toBe(`${cursorWidthCh(1020)}ch`);
  view.destroy();
  parent.remove();
});

it("the lock names why the file cannot be written, and a mode lock offers the overwrite", () => {
  const { setDiskLock } = require("../buffers") as typeof import("../buffers");
  const { registerCodeCommands } = require("../commands") as typeof import("../commands");
  const ctx = { vaultId: "v-lock", path: "gen.ts", languageId: "typescript", languageName: "TypeScript", sizeBytes: 1, largeFile: false };
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: "x", extensions: [fields(), featureBase(ctx), statusBar()] }) });
  const lock = () => view.dom.querySelector(".cm-code-status-lock") as HTMLButtonElement;
  expect(lock().hidden).toBe(true);
  // A 0444 file: editable, the mode on the lock, a press asks to overwrite.
  view.dispatch({ effects: setDiskLock.of("0444") });
  expect(lock().hidden).toBe(false);
  expect(lock().textContent).toBe("0444");
  let asked = 0;
  const off = registerCodeCommands({ "file.overwrite": () => void asked++ });
  lock().click();
  expect(asked).toBe(1);
  off();
  // Read-only with no buffer behind it: the held text shown while the daemon reconnects.
  view.setState(EditorState.create({ doc: "x", extensions: [fields(), featureBase(ctx), statusBar(), EditorState.readOnly.of(true)] }));
  expect(lock().textContent).toBe("Read-onlyoffline");
  expect(lock().getAttribute("aria-label")).toBe("Read-only, offline");
  view.destroy();
  parent.remove();
});

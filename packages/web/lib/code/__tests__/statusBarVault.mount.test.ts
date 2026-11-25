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

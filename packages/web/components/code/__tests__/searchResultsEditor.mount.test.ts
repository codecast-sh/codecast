// The results editor as a real view: built from file texts, edited the way a
// person edits (including a change that reaches into a header), saved through
// the write-back path against a fake disk, with a conflict on one file.
import { installEditorDom } from "./editorDom";

installEditorDom();

const { describe, expect, test } = await import("bun:test");
const { EditorView } = await import("@codemirror/view");
const { VaultWriteConflict } = await import("../../../lib/vault/client");
const { multibufferDirty, multibufferState, saveMultibuffer, locationAt } = await import("../../../lib/code/search/multibuffer");
type WriteBackIO = import("../../../lib/code/search/writeBack").WriteBackIO;

const disk = new Map<string, { content: string; etag: string }>();
let n = 0;
const put = (p: string, content: string) => disk.set(p, { content, etag: `e${++n}` });

const io: WriteBackIO = {
  buffer: () => undefined,
  read: async (p) => {
    const f = disk.get(p);
    return f ? { content: f.content, etag: f.etag, mtime: 1 } : null;
  },
  write: async (p, content, etag) => {
    const f = disk.get(p)!;
    if (f.etag !== etag) throw new VaultWriteConflict({ content: f.content, etag: f.etag, mtime: 1, size: 0 });
    put(p, content);
    return { etag: disk.get(p)!.etag, mtime: 1, size: content.length };
  },
  adopt: () => {},
  save: async () => "saved",
};


function mount() {
  put("a.ts", "one\ntwo needle\nthree\n");
  put("b.ts", "needle b\r\nsecond\r\n");
  const opened: unknown[] = [];
  const state = multibufferState(
    [
      { path: "a.ts", text: disk.get("a.ts")!.content, lines: [2] },
      { path: "b.ts", text: disk.get("b.ts")!.content, lines: [1] },
    ],
    { vaultId: "v", matcher: /needle/g, onOpen: (loc) => opened.push(loc) },
  );
  document.body.replaceChildren();
  const view = new EditorView({ state, parent: document.body });
  return { view, opened };
}

const lineOf = (view: InstanceType<typeof EditorView>, text: string) => {
  for (let i = 1; i <= view.state.doc.lines; i++) if (view.state.doc.line(i).text === text) return view.state.doc.line(i);
  throw new Error(`no line ${text}`);
};

describe("the results editor", () => {
  test("shows headers and excerpts, highlights matches, numbers lines by the file", () => {
    const { view } = mount();
    // A final newline adds no empty row past the end of a file.
    expect(view.state.doc.toString()).toBe("a.ts\none\ntwo needle\nthree\nb.ts\nneedle b\nsecond");
    expect(view.dom.querySelectorAll(".cm-mb-header").length).toBe(2);
    expect(view.dom.querySelectorAll(".cm-mb-match").length).toBe(2);
    expect(locationAt(view.state, lineOf(view, "two needle").from + 4)).toEqual({ path: "a.ts", line: 2, column: 5 });
  });

  test("edits save to each file with compare-and-swap; a header stays put", async () => {
    const { view } = mount();
    const two = lineOf(view, "two needle");
    view.dispatch({ changes: { from: two.from + 4, to: two.to, insert: "pin" } });
    // A delete from the end of a.ts's excerpt into b.ts's header: only a.ts's part lands.
    const header = lineOf(view, "b.ts");
    view.dispatch({ changes: { from: header.from - 1, to: header.to } });
    expect(lineOf(view, "b.ts")).toBeDefined();
    const nb = lineOf(view, "needle b");
    view.dispatch({ changes: { from: nb.from, to: nb.from + 6, insert: "pin" } });
    expect(multibufferDirty(view.state)).toBe(true);
    const { outcomes } = await saveMultibuffer(view, io);
    expect(outcomes.map((o) => o.status)).toEqual(["saved", "saved"]);
    expect(disk.get("a.ts")!.content).toBe("one\ntwo pin\nthree\n");
    expect(disk.get("b.ts")!.content).toBe("pin b\r\nsecond\r\n");
    expect(multibufferDirty(view.state)).toBe(false);

    // A second edit after the save writes on top of what was saved.
    const pinb = lineOf(view, "pin b");
    view.dispatch({ changes: { from: pinb.to, insert: "!" } });
    await saveMultibuffer(view, io);
    expect(disk.get("b.ts")!.content).toBe("pin b!\r\nsecond\r\n");
  });

  test("a file changed on disk under its excerpt is refused; the other still saves", async () => {
    const { view } = mount();
    const two = lineOf(view, "two needle");
    view.dispatch({ changes: { from: two.to, insert: "?" } });
    const nb = lineOf(view, "needle b");
    view.dispatch({ changes: { from: nb.to, insert: "?" } });
    put("a.ts", "one\ntwo needle, edited by an agent\nthree\n");
    const { outcomes } = await saveMultibuffer(view, io);
    expect(outcomes.map((o) => [o.path, o.status])).toEqual([
      ["a.ts", "changed"],
      ["b.ts", "saved"],
    ]);
    expect(disk.get("a.ts")!.content).toBe("one\ntwo needle, edited by an agent\nthree\n");
    expect(disk.get("b.ts")!.content).toBe("needle b?\r\nsecond\r\n");
    // a.ts is still unsaved; b.ts is not written twice.
    expect(multibufferDirty(view.state)).toBe(true);
    const again = await saveMultibuffer(view, io);
    expect(again.outcomes.map((o) => o.path)).toEqual(["a.ts"]);
  });

  test("a save writes to the vault the excerpts came from, never the one Files shows now", async () => {
    const { useVaultStore } = await import("../../../store/vaultStore");
    const prev = useVaultStore.getState();
    // Built in vault "v"; Files has moved to a sibling worktree.
    useVaultStore.setState({ endpoint: { port: 1, token: "t", deviceId: "d", tmux: false } as never, activeVaultId: "v-worktree", isRemote: false });
    try {
      const { view } = mount();
      const two = lineOf(view, "two needle");
      view.dispatch({ changes: { from: two.to, insert: "!" } });
      const { outcomes, written } = await saveMultibuffer(view);
      expect(written).toBe(0);
      expect(outcomes.map((o) => [o.path, o.status])).toEqual([["a.ts", "error"]]);
      expect(disk.get("a.ts")!.content).toBe("one\ntwo needle\nthree\n");
      expect(multibufferDirty(view.state)).toBe(true);
    } finally {
      useVaultStore.setState({ endpoint: prev.endpoint, activeVaultId: prev.activeVaultId, isRemote: prev.isRemote });
    }
  });
});

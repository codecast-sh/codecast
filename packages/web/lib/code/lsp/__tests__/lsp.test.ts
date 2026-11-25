import { describe, expect, it } from "bun:test";
import { EditorState } from "@codemirror/state";
import { describeLanguage, loadLanguage } from "../../languages";
import { displayPath, resolveUri, uriKey, vaultFileUri } from "../uri";
import { applyWorkspaceEdit, collectEdits, editFileText } from "../edits";
import { applyProgress, chipDetail, chipStatus, type ProgressTasks } from "../progress";
import { flattenLspSymbols, lezerSymbols } from "../symbols";
import { routeServerRequests, baseServerHandlers } from "../router";
import { toCmDiagnostic } from "../diagnostics";
import { lspToSnippet } from "../completion";

// Through the editor's own language table, as a buffer gets them.
const typescript = (await loadLanguage(describeLanguage("a.ts")))!;
const python = (await loadLanguage(describeLanguage("a.py")))!;

const ROOT = "/Users/ada/src/my app";

describe("URI mapping", () => {
  it("maps a URI inside the vault to its relative path, whatever its encoding", () => {
    expect(resolveUri(ROOT, "file:///Users/ada/src/my%20app/node_modules/%40types/a.d.ts")).toEqual({
      inside: true,
      path: "node_modules/@types/a.d.ts",
      absPath: "/Users/ada/src/my app/node_modules/@types/a.d.ts",
    });
    expect(resolveUri(ROOT + "/", "file:///Users/ada/src/my app/x.ts")).toMatchObject({ inside: true, path: "x.ts" });
  });

  it("keeps a URI outside the vault as an absolute path, and a sibling with the same prefix outside", () => {
    expect(resolveUri(ROOT, "file:///usr/lib/node/lib.d.ts")).toEqual({ inside: false, absPath: "/usr/lib/node/lib.d.ts" });
    expect(resolveUri(ROOT, "file:///Users/ada/src/my%20app2/x.ts").inside).toBe(false);
    expect(resolveUri(ROOT, "untitled:1")).toEqual({ inside: false, absPath: null });
  });

  it("builds URIs that round-trip, and keys equal across encodings", () => {
    const uri = vaultFileUri(ROOT, "src/@x/a b#c.ts");
    expect(uri).toBe("file:///Users/ada/src/my%20app/src/%40x/a%20b%23c.ts");
    expect(resolveUri(ROOT, uri)).toMatchObject({ inside: true, path: "src/@x/a b#c.ts" });
    expect(uriKey(uri)).toBe(uriKey("file:///Users/ada/src/my app/src/@x/a b%23c.ts"));
  });

  it("shows paths relative to the vault, or under home", () => {
    expect(displayPath(ROOT, vaultFileUri(ROOT, "a.ts"))).toBe("a.ts");
    expect(displayPath(ROOT, "file:///Users/ada/.cargo/registry/x.rs", "/Users/ada")).toBe("~/.cargo/registry/x.rs");
  });
});

describe("workspace edits", () => {
  const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });

  it("rewrites a closed file keeping CRLF and BOM", () => {
    const out = editFileText("\uFEFFlet foo = 1;\r\nfoo++;\r\n", [
      { range: range(1, 0, 1, 3), newText: "bar" },
      { range: range(0, 4, 0, 7), newText: "bar" },
    ]);
    expect(out).toBe("\uFEFFlet bar = 1;\r\nbar++;\r\n");
  });

  it("collects documentChanges and reports file operations it cannot do", () => {
    const { byUri, fileOps } = collectEdits({
      documentChanges: [
        { textDocument: { uri: "file:///a", version: 1 }, edits: [{ range: range(0, 0, 0, 0), newText: "x" }] },
        { kind: "rename", oldUri: "file:///a", newUri: "file:///b" },
      ],
    });
    expect([...byUri.keys()]).toEqual(["file:///a"]);
    expect(fileOps).toEqual(["rename file:///b"]);
  });

  it("writes closed files with the etag it read, and reports a moved file as a conflict", async () => {
    const disk: Record<string, { content: string; etag: string }> = {
      "a.ts": { content: "foo\n", etag: "e1" },
      "b.ts": { content: "foo\n", etag: "e2" },
    };
    const writes: [string, string, string][] = [];
    const report = await applyWorkspaceEdit(
      {
        changes: {
          [vaultFileUri(ROOT, "a.ts")]: [{ range: range(0, 0, 0, 3), newText: "bar" }],
          [vaultFileUri(ROOT, "b.ts")]: [{ range: range(0, 0, 0, 3), newText: "bar" }],
          "file:///elsewhere/c.ts": [{ range: range(0, 0, 0, 3), newText: "bar" }],
        },
      },
      {
        rootPath: ROOT,
        buffer: () => undefined,
        applyToBuffer: () => {
          throw new Error("no buffers here");
        },
        read: async (p) => disk[p] ?? null,
        write: async (p, content, etag) => {
          if (p === "b.ts") {
            const err = new Error("vault file changed on disk");
            err.name = "VaultWriteConflict";
            throw err;
          }
          writes.push([p, content, etag]);
        },
      },
    );
    expect(writes).toEqual([["a.ts", "bar\n", "e1"]]);
    expect(report.written).toEqual(["a.ts"]);
    expect(report.conflicts).toEqual(["b.ts"]);
    expect(report.skipped).toEqual([{ path: "/elsewhere/c.ts", reason: "outside this folder" }]);
  });
});

describe("server status", () => {
  it("reads progress begin, report and end into the chip", () => {
    let tasks: ProgressTasks = new Map();
    expect(chipStatus("ready", tasks)).toBe("ready");
    expect(chipStatus("ready", tasks, true)).toBe("unresponsive");
    expect(chipDetail("unresponsive", tasks)).toBe("not responding");
    tasks = applyProgress(tasks, { token: "t1", value: { kind: "begin", title: "Indexing" } });
    expect(chipStatus("ready", tasks)).toBe("indexing");
    expect(chipDetail("indexing", tasks)).toBe("indexing");
    tasks = applyProgress(tasks, { token: "t1", value: { kind: "report", percentage: 41.6 } });
    expect(chipDetail("indexing", tasks)).toBe("42%");
    const same = applyProgress(tasks, { token: "nope", value: { kind: "end" } });
    expect(same).toBe(tasks);
    tasks = applyProgress(tasks, { token: "t1", value: { kind: "end" } });
    expect(chipStatus("ready", tasks)).toBe("ready");
  });

  it("passes connection states through and never shows indexing before ready", () => {
    const busy = applyProgress(new Map(), { token: 1, value: { kind: "begin", title: "x" } });
    for (const s of ["starting", "restarting", "unavailable", "crashed", "offline", "idle"] as const) expect(chipStatus(s, busy)).toBe(s);
    expect(chipDetail("crashed", busy)).toBe("crashed");
    expect(chipDetail("unavailable", busy)).toBe("not installed");
  });
});

describe("document symbols", () => {
  it("reads an outline from the TypeScript syntax tree without a server", () => {
    const doc = [
      "export interface Shape { area(): number }",
      "type Id = string;",
      "export function make(n: number) {",
      "  const local = n * 2;",
      "  return local;",
      "}",
      "class Circle {",
      "  radius = 1;",
      "  area() { const inner = 1; return inner; }",
      "}",
      "const top = () => 1;",
    ].join("\n");
    const state = EditorState.create({ doc, extensions: typescript });
    const syms = lezerSymbols(state, 1000).map((s) => [s.name, s.kind, s.container ?? null]);
    expect(syms).toEqual([
      ["Shape", "interface", null],
      ["Id", "type", null],
      ["make", "function", null],
      ["Circle", "class", null],
      ["radius", "property", "Circle"],
      ["area", "method", "Circle"],
      ["top", "variable", null],
    ]);
  });

  it("reads Python too", () => {
    const state = EditorState.create({ doc: "X = 1\nclass A:\n    def m(self):\n        y = 2\ndef f():\n    pass\n", extensions: python });
    expect(lezerSymbols(state, 1000).map((s) => [s.name, s.kind, s.container ?? null])).toEqual([
      ["X", "variable", null],
      ["A", "class", null],
      ["m", "function", "A"],
      ["f", "function", null],
    ]);
  });

  it("flattens nested documentSymbol answers in document order", () => {
    const state = EditorState.create({ doc: "class A {\n  m() {}\n}\n" });
    const r = (l: number, c: number) => ({ start: { line: l, character: c }, end: { line: l, character: c + 1 } });
    const out = flattenLspSymbols([{ name: "A", kind: 5, range: r(0, 0), selectionRange: r(0, 6), children: [{ name: "m", kind: 6, range: r(1, 2), selectionRange: r(1, 2) }] }], state);
    expect(out.map((s) => [s.name, s.kind, s.container ?? null, s.nameFrom])).toEqual([
      ["A", "class", null, 6],
      ["m", "method", "A", 12],
    ]);
  });
});

describe("server requests", () => {
  it("answers requests the client would refuse and passes the rest on", async () => {
    let handler: ((m: string) => void) | null = null;
    const sent: any[] = [];
    const routed = routeServerRequests(
      { send: (m) => sent.push(JSON.parse(m)), subscribe: (h) => (handler = h), unsubscribe: () => (handler = null) },
      baseServerHandlers(() => "file:///r/proj"),
    );
    const seen: string[] = [];
    routed.subscribe((m) => seen.push(m));
    handler!(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "window/workDoneProgress/create", params: { token: "x" } }));
    handler!(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "workspace/configuration", params: { items: [{}, {}] } }));
    handler!(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "workspace/workspaceFolders" }));
    handler!(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "custom/thing" }));
    handler!(JSON.stringify({ jsonrpc: "2.0", id: 9, result: { ok: true } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 1, result: null },
      { jsonrpc: "2.0", id: 2, result: [null, null] },
      { jsonrpc: "2.0", id: 3, result: [{ uri: "file:///r/proj", name: "proj" }] },
    ]);
    expect(seen.map((m) => JSON.parse(m).id)).toEqual([4, 9]);
  });
});

describe("conversions", () => {
  it("maps an LSP diagnostic with source, code and the unnecessary tag", () => {
    const state = EditorState.create({ doc: "let unused = 1;\n" });
    const d = toCmDiagnostic({ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } }, message: "never read", severity: 4, source: "ts", code: 6133, tags: [1] }, state.doc);
    expect(d).toEqual({ from: 4, to: 10, severity: "hint", message: "never read", source: "ts 6133", markClass: "cm-lsp-unnecessary" });
  });

  it("converts LSP snippets to CodeMirror's syntax", () => {
    expect(lspToSnippet("foo($1, ${2:bar})$0 \\$x")).toBe("foo(${1}, ${2:bar})${0} $x");
  });
});

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { installDom } from "./dom";

installDom();
const { mount, recordCommands, useHarness } = await import("./harness");
useHarness();

const { parseVimrc } = await import("../parse");
const { applyVimConfig } = await import("../apply");
const { onVimModeChange } = await import("../mode");
const { flushPendingKeys, hasPendingKeys } = await import("../keyLayer");
const { offerClipboardText } = await import("../clipboard");
const { vimOptionsExtension, readVimEditorOptions } = await import("../editorOptions");
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { indentUnit } = await import("@codemirror/language");
const { CODE_CURSOR_TEXT_VAR } = await import("../../theme");

const fixture = (name: string) => readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8");
const mac = { platform: "mac" } as const;
const apply = (...contents: string[]) => applyVimConfig(parseVimrc(contents.map((content, i) => ({ path: `/home/me/vimrc${i}`, content })), mac));

const ALL = [
  "file.save",
  "file.saveAll",
  "file.close",
  "tree.toggle",
  "tree.reveal",
  "quickOpen",
  "tabs.switcher",
  "search.project",
  "search.next",
  "git.diffHead",
  "blame.toggle",
  "focus.left",
  "focus.down",
  "split.right",
  "lsp.definition",
  "lsp.references",
  "lsp.hover",
  "lsp.rename",
  "diagnostic.next",
  "diagnostic.prev",
  "settings.open",
] as const;

describe("a vimrc's maps drive the editor", () => {
  it("runs leader maps, with a leader whose key is also a motion", () => {
    apply(fixture("vimrc.vim"));
    const calls = recordCommands([...ALL]);
    const e = mount("alpha beta\ngamma\n");
    e.keys("'w");
    e.keys("'n");
    e.keys("'f");
    e.keys("<C-p>");
    e.keys("π");
    e.keys("'gd");
    e.keys("'gb");
    e.keys("]q");
    e.keys("'e");
    expect(calls.map((c) => c.id)).toEqual([
      "file.save",
      "tree.toggle",
      "tree.reveal",
      "quickOpen",
      "tabs.switcher",
      "git.diffHead",
      "blame.toggle",
      "search.next",
      "settings.open",
    ]);
    expect(e.doc).toBe("alpha beta\ngamma\n");
  });

  it("passes the word under the cursor to project search", () => {
    apply(fixture("vimrc.vim"));
    const calls = recordCommands(["search.project"]);
    const e = mount("const needle = 1;\n");
    e.cursorTo(8);
    e.keys("'g");
    e.keys("'*");
    expect(calls.map((c) => c.args)).toEqual([
      { query: "needle", regex: true },
      { query: "needle", regex: true },
    ]);
  });

  it("maps macOS option-key glyphs as the characters they are", () => {
    apply(fixture("vimrc.vim"));
    const calls = recordCommands(["focus.left", "focus.down"]);
    const e = mount("x\n");
    e.keys("˙∆");
    expect(calls.map((c) => c.id)).toEqual(["focus.left", "focus.down"]);
  });

  it("maps <localleader> to Space without losing the Space motion", () => {
    apply(fixture("vimrc.vim"));
    const e = mount("one\ntwo\nthree\n");
    e.keys("2G<Space>x");
    expect(e.doc).toBe("one\nthree\n");
    // A lone Space waits for 'timeoutlen', then moves right.
    e.keys("<Space>");
    expect(e.head).toBe(4);
    flushPendingKeys(e.cm as never);
    expect(e.head).toBe(5);
  });

  it("runs <C-w> window moves and maps onto them under noremap", () => {
    apply(fixture("vimrc.vim"));
    const calls = recordCommands(["focus.left", "split.right"]);
    const e = mount("x\n");
    e.keys("<C-w>h");
    e.keys("'v");
    expect(calls.map((c) => c.id)).toEqual(["focus.left", "split.right"]);
  });

  it("composes <Plug> commentary maps", () => {
    apply(fixture("vimrc.vim"));
    const e = mount("a\nb\n");
    e.keys("'cc");
    expect(e.doc).toBe("// a\nb\n");
    e.keys("2GV'c");
    expect(e.doc).toBe("// a\n// b\n");
  });

  it("keeps the engine's own keys: Y, visual <, and plain motions", () => {
    apply(fixture("vimrc.vim"));
    const e = mount("    indented line\n");
    e.keys("wYP");
    expect(e.doc).toBe("    indented lineindented line\n");
  });

  it("runs ex aliases from cabbrev and :command", () => {
    apply(fixture("vimrc.vim"));
    const calls = recordCommands(["file.save", "search.project", "file.close"]);
    const e = mount("x\n");
    e.ex("W");
    e.ex("Grep foo bar");
    e.ex("Q");
    expect(calls).toEqual([
      { id: "file.save", args: undefined },
      { id: "search.project", args: { query: "foo bar", regex: true } },
      { id: "file.close", args: undefined },
    ]);
  });

  it("re-applying a changed config removes what the last one added and keeps defaults", () => {
    apply(fixture("vimrc.vim"));
    apply("let mapleader = ','\nnnoremap ,s :w<CR>\n");
    const calls = recordCommands(["file.save", "tree.toggle"]);
    const e = mount("one two\nthree\n");
    e.keys("'n"); // gone: ' is a mark jump again
    e.keys(",s");
    expect(calls.map((c) => c.id)).toEqual(["file.save"]);
    e.keys("ggdd");
    expect(e.doc).toBe("three\n");
    e.ex("W");
    expect(calls.length).toBe(1);
  });

  it("applies the overlay last", () => {
    apply(fixture("vimrc.vim"), fixture("overlay.vim"));
    const calls = recordCommands(["file.save", "file.saveAll"]);
    const e = mount("x\n");
    e.keys("'w");
    expect(calls.map((c) => c.id)).toEqual(["file.saveAll"]);
  });
});

describe("ex adapters typed in the command line", () => {
  it("run workspace commands", () => {
    apply("");
    const calls = recordCommands([...ALL, "file.open", "terminal.toggle", "tabs.next", "tabs.prev", "goto.symbol"]);
    const e = mount("word\n");
    for (const cmd of ["NERDTreeToggle", "Explore", "Telescope find_files", "Buffers", "BTags", "vimgrep /foo\\d/ **/*", "Gvdiffsplit", "bn", "bp", "vs src/a.ts", "terminal", "lua vim.lsp.buf.hover()"]) {
      e.ex(cmd);
    }
    expect(calls.map((c) => [c.id, c.args])).toEqual([
      ["tree.toggle", undefined],
      ["tree.reveal", undefined],
      ["quickOpen", undefined],
      ["tabs.switcher", undefined],
      ["goto.symbol", undefined],
      ["search.project", { query: "foo\\d", regex: true }],
      ["git.diffHead", undefined],
      ["tabs.next", undefined],
      ["tabs.prev", undefined],
      ["file.open", { path: "src/a.ts", split: "right" }],
      ["terminal.toggle", undefined],
      ["lsp.hover", undefined],
    ]);
  });

  it(":Gdiffsplit with a ref diffs against it; without one toggles the diff against HEAD", () => {
    apply("");
    const calls = recordCommands(["git.diffHead", "git.diffAgainst"]);
    const e = mount("x\n");
    for (const cmd of ["Gdiffsplit main", "Gvdiffsplit @merge-base", "Gdiffsplit", "Gdiffsplit HEAD:x"]) e.ex(cmd);
    expect(calls.map((c) => [c.id, c.args])).toEqual([
      ["git.diffAgainst", { ref: "main" }],
      ["git.diffAgainst", { ref: "@merge-base" }],
      ["git.diffHead", undefined],
    ]);
  });

  it(":e refuses a path outside the folder instead of making it a new file there", () => {
    apply("");
    const calls = recordCommands(["file.open"]);
    const e = mount("x\n");
    for (const cmd of ["e ~/notes.ts", "e ../x.ts", "e src/../../x.ts", "e /Users/me/repo/package.json", "e ./src/new.ts"]) e.ex(cmd);
    // The absolute path goes to file.open, which alone knows the root.
    expect(calls.map((c) => c.args?.path)).toEqual(["/Users/me/repo/package.json", "./src/new.ts"]);
    expect(e.view.dom.textContent).toContain("src/../../x.ts leaves this folder");
  });

  it(":wq saves then closes when the shell has no save-and-close", () => {
    apply("");
    const calls = recordCommands(["file.save", "file.close"]);
    mount("x\n").ex("wq");
    expect(calls.map((c) => c.id)).toEqual(["file.save", "file.close"]);
  });
});

describe("built-in plugins", () => {
  it("surround: ys, yss, cs, ds, visual S, tags", () => {
    apply("");
    const e = mount("foo bar\n");
    e.keys("ysiw)");
    expect(e.doc).toBe("(foo) bar\n");
    e.keys("cs)]");
    expect(e.doc).toBe("[foo] bar\n");
    e.keys("ds]");
    expect(e.doc).toBe("foo bar\n");
    e.keys("yss'");
    expect(e.doc).toBe("'foo bar'\n");
    e.keys("cs'");
    e.type("<em>");
    expect(e.doc).toBe("<em>foo bar</em>\n");
    e.keys("lllldst");
    expect(e.doc).toBe("foo bar\n");
    e.keys("0wviwS{");
    expect(e.doc).toBe("foo { bar }\n");
    e.keys("ds{");
    expect(e.doc).toBe("foo bar\n");
  });

  it("surround waits out ys without breaking y, c and d", () => {
    apply("");
    const e = mount("one two\nthree\n");
    e.keys("yiwP");
    expect(e.doc).toBe("oneone two\nthree\n");
    e.keys("0dw");
    expect(e.doc).toBe("two\nthree\n");
    e.keys("dd");
    expect(e.doc).toBe("three\n");
    e.keys("cw");
    e.insert("x");
    e.keys("<Esc>");
    expect(e.doc).toBe("x\n");
  });

  it("commentary: gcc, gc{motion}, visual gc", () => {
    apply("");
    const e = mount("a\nb\nc\n");
    e.keys("gcc");
    expect(e.doc).toBe("// a\nb\nc\n");
    e.keys("gcc");
    expect(e.doc).toBe("a\nb\nc\n");
    e.keys("gc2G");
    expect(e.doc).toBe("// a\n// b\nc\n");
    e.keys("ggV2Ggc");
    expect(e.doc).toBe("a\nb\nc\n");
  });

  it("text objects: ae/ie and ii/ai", () => {
    apply("");
    const e = mount("def f():\n    a = 1\n\n    b = 2\nprint()\n");
    e.keys("2Gdii");
    expect(e.doc).toBe("def f():\nprint()\n");
    const f = mount("\n\nx\ny\n\n");
    f.keys("yie");
    f.keys("G");
    expect(f.doc).toBe("\n\nx\ny\n\n");
    f.keys("dae");
    expect(f.doc).toBe("");
  });

  it("binds gd, gr, K, [d, ]d and <leader>rn unless the vimrc claims them", () => {
    apply("let mapleader = ' '\nnnoremap K :w<CR>\n");
    const calls = recordCommands(["lsp.definition", "lsp.references", "lsp.hover", "diagnostic.prev", "diagnostic.next", "lsp.rename", "file.save"]);
    const e = mount("x\n");
    e.keys("gdgrK[d]d<Space>rn");
    expect(calls.map((c) => c.id)).toEqual(["lsp.definition", "lsp.references", "file.save", "diagnostic.prev", "diagnostic.next", "lsp.rename"]);
  });

  it("runs a map from a cached config, whose translation never ran in this page", () => {
    // A cached parse is applied as is: nothing has named its command keys yet.
    applyVimConfig({
      sources: [{ path: "/home/me/vimrc", directives: [{ line: 1, text: "nmap ga <Plug>(x)", status: "applied", detail: "", effects: [{ kind: "map", context: "normal", lhs: "ga", rhs: "<CcAgentNewSession>", noremap: false, nowait: false }] }] }],
      options: { global: {}, byFiletype: {} },
      leader: "\\",
      localLeader: "\\",
    } as never);
    const calls = recordCommands(["agent.newSession"]);
    const e = mount("x\n");
    e.press("g");
    e.press("a");
    expect(calls.map((c) => c.id)).toEqual(["agent.newSession"]);
  });

  it("binds ]c and [c to hunks unless the vimrc claims them", () => {
    apply("");
    const calls = recordCommands(["git.nextHunk", "git.prevHunk"]);
    mount("x\n").keys("]c[c");
    expect(calls.map((c) => c.id)).toEqual(["git.nextHunk", "git.prevHunk"]);
  });

  it("gd without a language server jumps to the first use of the word", () => {
    apply("");
    const e = mount("let total = 0;\ntotal += 1;\n");
    e.keys("2Ggd");
    expect(e.head).toBe(4);
  });
});

describe("options and modes", () => {
  it("clipboard=unnamed writes yanks out and pastes newer clipboard text", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void written.push(t), readText: async () => "" } });
    apply("set clipboard=unnamedplus");
    const e = mount("first\nsecond\n");
    e.keys("yy");
    expect(written).toEqual(["first\n"]);
    offerClipboardText("pasted");
    e.keys("2Gp");
    expect(e.doc).toBe("first\nspastedecond\n");
  });

  it("clipboard=unnamed takes a copy from the state, not the rendered viewport", () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {}, readText: async () => "" } });
    apply("set clipboard=unnamed");
    const doc = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const e = mount(doc);
    e.view.dispatch({ selection: { anchor: 0, head: doc.length } });
    // The DOM selection covers only what is drawn, as it does past the viewport.
    document.getSelection()!.selectAllChildren(e.view.contentDOM.firstChild!);
    e.view.observer.readSelectionRange();
    const data = new Map<string, string>();
    const copy = new window.Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { clearData: () => data.clear(), setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? "" } });
    e.view.contentDOM.dispatchEvent(copy);
    expect(data.get("text/plain")).toBe(doc);
    e.view.dispatch({ changes: { from: 0, to: doc.length, insert: "x\n" }, selection: { anchor: 0 } });
    e.keys("<Esc>p");
    // Linewise, below the cursor line, every character intact.
    expect(e.doc).toBe(`x\n${doc}`);
  });

  it("reports the mode through every change", () => {
    apply("");
    const e = mount("abc\n");
    const modes: string[] = [];
    const off = onVimModeChange(e.view, (m) => modes.push(m));
    for (const key of ["i", "Escape", "v", "V"]) e.press(key);
    e.press("v", { ctrlKey: true });
    for (const key of ["Escape", "d", "Escape", "R", "Escape"]) e.press(key);
    off();
    expect(modes).toEqual(["normal", "insert", "normal", "visual", "visual line", "visual block", "normal", "op-pending", "normal", "replace", "normal"]);
  });

  it("keeps scrolloff out of the scroll margins, which would hide tooltips near the edges", async () => {
    const report = apply("set scrolloff=5 sidescrolloff=3");
    const base = mount("x\n").view.state.facet(EditorView.scrollMargins).length;
    const e = mount("x\n", [vimOptionsExtension(report)]);
    expect(e.view.state.facet(EditorView.scrollMargins).length).toBe(base);
    // The margin lands once the view is measured (jsdom has no height, so y is 0).
    e.view.measure();
    await Promise.resolve();
    expect(e.view.state.facet(EditorView.cursorScrollMargin)).toEqual({ x: 3 * e.view.defaultCharacterWidth, y: 0 });
  });

  it("gives CodeMirror the vimrc's tab size, indent and per-language overrides; :set changes them live", () => {
    const report = apply(fixture("vimrc.vim"));
    const py = EditorState.create({ extensions: vimOptionsExtension(report, "Python") });
    expect(py.tabSize).toBe(4);
    expect(py.facet(indentUnit)).toBe("    ");
    const go = EditorState.create({ extensions: vimOptionsExtension(report, "Go") });
    expect(go.tabSize).toBe(8);
    expect(go.facet(indentUnit)).toBe("\t");
    expect(readVimEditorOptions(go)?.colorColumns).toEqual([]);
    expect(readVimEditorOptions(py)?.colorColumns).toEqual([101]);

    const e = mount("x\n", [vimOptionsExtension(report, "TypeScript")]);
    expect(e.view.state.tabSize).toBe(2);
    e.ex("set ts=3 et sw=3");
    expect(e.view.state.tabSize).toBe(3);
    expect(e.view.state.facet(indentUnit)).toBe("   ");
    e.ex("set nornu");
    expect(readVimEditorOptions(e.view.state)?.lineNumbers).toBe("absolute");
  });
});

describe("review regressions", () => {
  it("a map whose right side starts with its left side runs that key as built in", () => {
    // The engine's recursion guard used to drop the inner O, leaving the rest
    // of the keys to run in normal mode, where they moved and deleted text.
    apply("map O Ox\n");
    const e = mount("one\ntwo\n");
    e.keys("G");
    e.keys("O");
    expect(e.cm.state.vim.insertMode).toBe(true);
    expect(e.doc).toBe("one\ntwo\nx\n");
  });

  it("dedents with V< at once while a <C-c> visual map and a Space leader are set", () => {
    apply('let mapleader = "\\<Space>"\nvnoremap <C-c> "+y\nnnoremap <leader>w :w<CR>\n');
    const e = mount("    foo\n");
    e.keys("V<");
    expect(hasPendingKeys(e.cm as never)).toBe(false);
    expect(e.doc).toBe("  foo\n");
  });

  it("drops held keys when the editor goes away", () => {
    apply("let mapleader = ' '\nnnoremap <leader>w :w<CR>\n");
    const e = mount("one two\n");
    e.keys("<Space>");
    expect(hasPendingKeys(e.cm as never)).toBe(true);
    e.view.destroy();
    expect(hasPendingKeys(e.cm as never)).toBe(false);
  });

  it("opens a command line with its literal < kept and the caret where <Left> put it", () => {
    apply("nnoremap <leader>s :%s/\\<<C-r><C-w>\\>//g<Left><Left>\n");
    const e = mount("foo bar\n");
    e.keys("\\s");
    const input = e.cm.state.dialog?.querySelector("input");
    expect(input?.value).toBe("%s/\\<foo\\>//g");
    expect(input?.selectionStart).toBe("%s/\\<foo\\>/".length);
    expect(input?.selectionEnd).toBe(input?.selectionStart);
  });

  it("an alias over an adapter gives the adapter back when a later config drops it", () => {
    apply("command! Files NERDTreeToggle\ncommand! Gblame Git blame\n");
    const calls = recordCommands(["tree.toggle", "quickOpen", "blame.toggle"]);
    const e = mount("x\n");
    e.ex("Files");
    apply("");
    e.ex("Files");
    e.ex("Gblame");
    expect(calls.map((c) => c.id)).toEqual(["tree.toggle", "quickOpen", "blame.toggle"]);
  });

  it(":w with a file name or a shell command doesn't save the current file", () => {
    const report = apply("nnoremap <leader>W :w !sudo tee % > /dev/null<CR>\n");
    expect(report.sources[0].directives[0]).toMatchObject({ status: "skipped", detail: "runs a shell command" });
    const calls = recordCommands(["file.save"]);
    const e = mount("x\n");
    e.ex("w! other.txt");
    e.ex("w !sudo tee > /dev/null %");
    e.ex("w");
    expect(calls.length).toBe(1);
  });

  it("gd falls back through words with regex characters from iskeyword", () => {
    const report = apply("set iskeyword+=*\n");
    const e = mount("(def *x* 1)\n(print *x*)\n", [vimOptionsExtension(report)]);
    e.cursorTo(20);
    e.keys("gd");
    expect(e.head).toBe(5);
  });

  it("surround skips brackets inside strings when the language has a parser", async () => {
    const { languages } = await import("@codemirror/language-data");
    const js = await languages.find((l) => l.name === "JavaScript")!.load();
    apply("");
    const e = mount('f(")", x);\n', [js]);
    // A person types long after the parser reached the cursor; a cold
    // parser on a busy test machine may not have.
    const { forceParsing } = await import("@codemirror/language");
    forceParsing(e.view, e.view.state.doc.length, 5000);
    e.cursorTo(7);
    e.keys("ds(");
    expect(e.doc).toBe('f")", x;\n');
  });

  it("clipboard=unnamed reads the clipboard on focus only once allowed, and asks at the first p", async () => {
    let reads = 0;
    const status = { state: "prompt" as PermissionState, onchange: null as null | (() => void) };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {}, readText: async () => (reads++, "outside") } });
    Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => status } });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    apply("set clipboard=unnamed");
    await tick();
    const e = mount("a\n");
    const focus = () => e.view.contentDOM.dispatchEvent(new window.FocusEvent("focus"));
    focus();
    await tick();
    expect(reads).toBe(0);
    e.keys("p");
    await tick();
    expect(reads).toBe(1);
    e.keys("p");
    expect(e.doc).toContain("outside");
    // Granted: focus picks up text copied elsewhere.
    status.state = "granted";
    status.onchange?.();
    focus();
    await tick();
    expect(reads).toBe(2);
  });
});

describe("the block cursor", () => {
  // jsdom has no layout, so vim draws no cell, and its CSSOM drops
  // !important from var() values. Put a cell in vim's own layer the way
  // Piece.adjust does, and read the !important colour rules that match it
  // from the stylesheet text the browser gets: those beat the inline colour.
  // The later matching rule is also the more specific one here.
  const importantColor = (el: Element) => {
    let color: string | undefined;
    const css = Array.from(document.querySelectorAll("style"), (s) => s.textContent).join("\n");
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const m = /(?:^|;)\s*color:\s*([^;]+?)\s*!important/.exec(body);
      if (m && el.matches(selector.trim())) color = m[1];
    }
    return color;
  };
  const cell = (view: { dom: HTMLElement }, inlineColor: string) => {
    const el = document.createElement("div");
    el.className = "cm-fat-cursor cm-cursor-primary";
    el.style.color = inlineColor;
    view.dom.querySelector(".cm-vimCursorLayer")!.appendChild(el);
    return el;
  };
  // CodeMirror notices a focus change on a short timer.
  const focusSettled = () => new Promise((r) => setTimeout(r, 30));

  it("draws the letter in the colour chosen against the cell over a string's syntax colour, and hides it on half cells", async () => {
    const e = mount('const s = "hi";\n');
    e.view.focus();
    await focusSettled();
    expect(e.view.dom.classList.contains("cm-focused")).toBe(true);
    // Strings are --sol-cyan, the block's own hue: the letter never takes it.
    expect(importantColor(cell(e.view, "rgb(42, 161, 152)"))).toBe(`var(${CODE_CURSOR_TEXT_VAR}, var(--sol-bg))`);
    expect(importantColor(cell(e.view, "transparent"))).toBe("transparent");
    e.view.contentDOM.blur();
    await focusSettled();
    expect(e.view.dom.classList.contains("cm-focused")).toBe(false);
    expect(importantColor(cell(e.view, "rgb(42, 161, 152)"))).toBe("transparent");
  });
});

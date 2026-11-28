// Built-in plugins: commentary, surround, entire/indent text objects, window
// moves, and workspace commands bound to keys.
//
// Commands live in the engine under keys no keyboard produces
// (`<CcLspDefinition>`, `<CcSurroundVisual>`). The bindings people type
// (`gd`, `<C-w>h`, visual `S`) are maps onto those keys, so a vimrc's
// `nnoremap gd ...` or `xmap <leader>s <Plug>VSurround` composes with them
// like any other map.

import { Vim } from "@replit/codemirror-vim";
import type { EditorView } from "@codemirror/view";
import { CharCategory, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree, matchBrackets, syntaxTree } from "@codemirror/language";
import { SearchCursor } from "@codemirror/search";
import { jumpTo } from "../jump";
import { toggleComment, toggleLineComment } from "@codemirror/commands";
import { CODE_COMMAND_IDS, runCodeCommand, type CodeCommandId } from "../commands";
import { addMap, holdPrefixKey, readKeys, type LayerMap } from "./keyLayer";
import { runResolution, windowCommand, windowEngineKey, WINDOW_KEYS } from "./exAdapters";
import { asVimCM, notify } from "./engine";
import type { VimMapContext } from "./types";

type Pos = { line: number; ch: number };
const viewOf = (cm: unknown) => asVimCM(cm).cm6;

// ── command keys ────────────────────────────────────────────────────────────

const registered = new Set<string>();

/** The engine key that runs a workspace command, e.g. `<CcFocusLeft>`. */
export function commandKeyName(id: CodeCommandId): string {
  return `<Cc${id
    .split(".")
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("")}>`;
}

/** Every command key, so a map read from a cached config (whose translation
 *  never ran in this page) still finds its command. */
let commandKeyIds: Map<string, CodeCommandId> | null = null;
const commandOfKey = (key: string) => (commandKeyIds ??= new Map(CODE_COMMAND_IDS.map((id) => [commandKeyName(id), id]))).get(key);

/** Register the engine command behind every command key `keys` mentions. */
export function ensureCommandKeys(keys: string): void {
  for (const key of keys.match(/<Cc\w+>/g) ?? []) {
    const id = commandOfKey(key);
    if (!id || registered.has(key)) continue;
    registered.add(key);
    Vim.mapCommand(key, "action", "codecastCommand", { command: id }, {});
  }
}

/** What a command key does when no handler is mounted. */
const FALLBACKS: Partial<Record<CodeCommandId, (view: EditorView) => void>> = {
  // gd without a language server: the first use of the word in the file, as gD.
  "lsp.definition": (view) => {
    const { state } = view;
    const word = state.wordAt(state.selection.main.head);
    if (!word) return;
    const category = state.charCategorizer(word.from);
    const wordAt = (pos: number) => pos >= 0 && pos < state.doc.length && category(state.sliceDoc(pos, pos + 1)) === CharCategory.Word;
    for (const cursor = new SearchCursor(state.doc, state.sliceDoc(word.from, word.to)); !cursor.next().done; ) {
      const { from, to } = cursor.value;
      if (wordAt(from - 1) || wordAt(to)) continue;
      jumpTo(view, from);
      return;
    }
  },
};

// ── text helpers ────────────────────────────────────────────────────────────

const PAIRS: Record<string, [string, string]> = {
  ")": ["(", ")"],
  b: ["(", ")"],
  "(": ["( ", " )"],
  "]": ["[", "]"],
  r: ["[", "]"],
  "[": ["[ ", " ]"],
  "}": ["{", "}"],
  B: ["{", "}"],
  "{": ["{ ", " }"],
  ">": ["<", ">"],
  a: ["<", ">"],
};

/** What surround puts around a target for a typed character, or null. */
export function surroundPair(spec: string): [string, string] | null {
  if (spec.startsWith("<") && spec.length > 1) {
    const name = /^<\s*([^\s>]+)/.exec(spec)?.[1];
    return name ? [spec.endsWith(">") ? spec : `${spec}>`, `</${name}>`] : null;
  }
  if (PAIRS[spec]) return PAIRS[spec];
  if (spec.length === 1 && !/[\w\s]/.test(spec)) return [spec, spec];
  return null;
}

interface Found {
  open: [number, number];
  close: [number, number];
}

const WINDOW = 200_000;

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** The innermost `open`...`close` pair around `pos` that the language's
 *  syntax tree knows, so brackets inside strings and comments don't count. */
function enclosingBracketsInTree(view: EditorView, pos: number, open: string, close: string): Found | null {
  const { state } = view;
  // A keypress can arrive before the parser reaches the cursor: finish it.
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + WINDOW), 50) ?? syntaxTree(state);
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    if (node.from > pos || state.sliceDoc(node.from, node.from + 1) !== open) continue;
    const m = matchBrackets(state, node.from, 1);
    if (m?.matched && m.end && m.end.from >= pos && state.sliceDoc(m.end.from, m.end.to) === close) {
      return { open: [m.start.from, m.start.to], close: [m.end.from, m.end.to] };
    }
  }
  return null;
}

function enclosingBrackets(view: EditorView, pos: number, open: string, close: string): Found | null {
  if (syntaxTree(view.state).length) {
    const found = enclosingBracketsInTree(view, pos, open, close);
    if (found) return found;
  }
  // No parser (plain text), or a pair the grammar doesn't model: count characters.
  const base = Math.max(0, pos - WINDOW);
  const text = view.state.sliceDoc(base, Math.min(view.state.doc.length, pos + WINDOW));
  const at = pos - base;
  let start = -1;
  if (text[at] === open) start = at;
  else {
    for (let i = at - (text[at] === close ? 1 : 0), depth = 0; i >= 0; i--) {
      if (text[i] === close) depth++;
      else if (text[i] === open && depth-- === 0) {
        start = i;
        break;
      }
    }
  }
  if (start < 0) return null;
  for (let i = start + 1, depth = 0; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && depth-- === 0) {
      return { open: [base + start, base + start + 1], close: [base + i, base + i + 1] };
    }
  }
  return null;
}

function enclosingQuotes(view: EditorView, pos: number, q: string): Found | null {
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from;
  const marks: number[] = [];
  for (let i = 0; i < line.text.length; i++) if (line.text[i] === q && line.text[i - 1] !== "\\") marks.push(i);
  for (let i = 0; i + 1 < marks.length; i += 2) {
    if (marks[i + 1] >= col) {
      const [a, b] = [marks[i], marks[i + 1]];
      return { open: [line.from + a, line.from + a + 1], close: [line.from + b, line.from + b + 1] };
    }
  }
  return null;
}

function enclosingTag(view: EditorView, pos: number): Found | null {
  const base = Math.max(0, pos - WINDOW);
  const text = view.state.sliceDoc(base, Math.min(view.state.doc.length, pos + WINDOW));
  const at = pos - base;
  const stack: { name: string; from: number; to: number }[] = [];
  let best: Found | null = null;
  const re = /<(\/?)([A-Za-z][\w:.-]*)\b[^<>]*?(\/?)>/g;
  for (let m; (m = re.exec(text)); ) {
    const [whole, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (!closing) {
      stack.push({ name, from: m.index, to: m.index + whole.length });
      continue;
    }
    let i = stack.length - 1;
    while (i >= 0 && stack[i].name !== name) i--;
    if (i < 0) continue;
    const open = stack[i];
    stack.length = i;
    const end = m.index + whole.length;
    if (open.from <= at && at < end && (!best || open.from + base >= best.open[0])) {
      best = { open: [base + open.from, base + open.to], close: [base + m.index, base + end] };
    }
  }
  return best;
}

/** The surrounding the person named with `target` around `pos`. */
export function findSurrounding(view: EditorView, pos: number, target: string): Found | null {
  if (target === "t") return enclosingTag(view, pos);
  const pair = PAIRS[target === "<" ? ">" : target];
  if (pair) {
    const found = enclosingBrackets(view, pos, pair[0][0], pair[1].trim());
    // An opening-bracket target also takes the whitespace inside the pair.
    if (found && "([{".includes(target)) {
      const doc = view.state.doc;
      while (found.open[1] < found.close[0] && /[ \t]/.test(doc.sliceString(found.open[1], found.open[1] + 1))) found.open[1]++;
      while (found.close[0] > found.open[1] && /[ \t]/.test(doc.sliceString(found.close[0] - 1, found.close[0]))) found.close[0]--;
    }
    return found;
  }
  if (target.length === 1 && !/[\w\s]/.test(target)) return enclosingQuotes(view, pos, target);
  return null;
}

/** Read a surround character, or `t`/`<` followed by a tag up to `>`. */
function readSurroundSpec(cm: unknown, done: (spec: string) => void): void {
  let tag: string | null = null;
  readKeys(asVimCM(cm), {
    key(key) {
      const ch = key === "<Space>" ? " " : key;
      if (tag === null) {
        if (ch === "t" || ch === "<") {
          tag = "<";
          return false;
        }
        if (ch.length === 1) done(ch);
        return true;
      }
      if (ch === ">" || ch === "<CR>") {
        if (tag.length > 1) done(`${tag}>`);
        return true;
      }
      if (ch === "<BS>") tag = tag.length > 1 ? tag.slice(0, -1) : tag;
      else if (ch.length === 1) tag += ch;
      return false;
    },
  });
}

function wrap(view: EditorView, from: number, to: number, pair: [string, string], linewise: boolean): void {
  const { state } = view;
  if (linewise) {
    const first = state.doc.lineAt(from);
    const last = state.doc.lineAt(Math.max(from, to - 1));
    const indent = /^\s*/.exec(first.text)![0];
    view.dispatch({
      changes: [
        { from: first.from, insert: `${indent}${pair[0].trimEnd()}\n` },
        { from: last.to, insert: `\n${indent}${pair[1].trimStart()}` },
      ],
      selection: { anchor: first.from + indent.length },
      userEvent: "input",
    });
    return;
  }
  const text = state.sliceDoc(from, to);
  const lead = /^\s*/.exec(text)![0].length;
  const trail = /\s*$/.exec(text)![0].length;
  const a = from + lead;
  const b = Math.max(a, to - trail);
  view.dispatch({ changes: [{ from: a, insert: pair[0] }, { from: b, insert: pair[1] }], selection: { anchor: a }, userEvent: "input" });
}

// ── engine definitions ──────────────────────────────────────────────────────

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.ch < b.ch);

function defineEngine(): void {
  Vim.defineAction("codecastCommand", (cm, args) => {
    const view = viewOf(cm);
    const id = (args as { command?: CodeCommandId }).command;
    if (id && !runCodeCommand(id, undefined, { view, source: "vim" })) FALLBACKS[id]?.(view);
  });

  Vim.defineAction("codecastWindow", (cm, args) => {
    const a = args as { key?: string; selectedCharacter?: string; repeat?: number; repeatIsExplicit?: boolean };
    const key = a.key ?? a.selectedCharacter;
    if (!key) return;
    const r = windowCommand(key, a.repeatIsExplicit ? a.repeat : undefined);
    if ("skip" in r) notify(cm, r.skip);
    else if (!runResolution(r, viewOf(cm))) notify(cm, r.declined ?? `<C-w>${key} isn't available in this view`);
  });

  // Commentary: line comments where the language has them, block otherwise.
  Vim.defineOperator("toggleComment", (cm, _args, ranges) => {
    toggleComment(viewOf(cm));
    const r = ranges[0];
    return before(r.anchor, r.head) ? r.anchor : r.head;
  });
  Vim.defineEx("Commentary", "Commentary", (cm, params) => {
    const view = viewOf(cm);
    const doc = view.state.doc;
    const a = params.line ?? params.selectionLine;
    const b = params.lineEnd ?? params.selectionLineEnd ?? a;
    const from = doc.line(Math.min(a, b) + 1).from;
    const to = doc.line(Math.max(a, b) + 1).to;
    view.dispatch({ selection: EditorSelection.range(from, to) });
    toggleLineComment(view);
  });

  Vim.defineOperator("codecastSurround", (cm, args, ranges) => {
    const c = asVimCM(cm);
    const r = ranges[0];
    const start = before(r.anchor, r.head) ? r.anchor : r.head;
    const from = c.indexFromPos(start);
    const to = c.indexFromPos(before(r.anchor, r.head) ? r.head : r.anchor);
    readSurroundSpec(cm, (spec) => {
      const pair = surroundPair(spec);
      if (pair) wrap(c.cm6, from, to, pair, !!args.linewise);
    });
    return start;
  });
  Vim.defineAction("codecastSurroundVisual", (cm) => {
    const view = viewOf(cm);
    const vim = asVimCM(cm).state.vim!;
    const linewise = !!vim.visualLine;
    const { from, to } = view.state.selection.main;
    Vim.exitVisualMode(cm as never, false);
    readSurroundSpec(cm, (spec) => {
      const pair = surroundPair(spec);
      if (pair) wrap(view, from, to, pair, linewise);
    });
  });
  // `s` after an operator is free in vim, so surround claims it there:
  // ds{c} and cs{c}{new} read their characters, ys starts the surround
  // operator, and the third s of yss takes the line. No key waits on a timeout.
  Vim.defineMotion("codecastSurroundMotion", (cm, _head, _args, vim, inputState) => {
    const view = viewOf(cm);
    const operator = inputState.operator;
    if (operator === "yank") {
      vim.inputState.operator = "codecastSurround";
      vim.inputState.operatorArgs = {};
    } else if (operator === "codecastSurround") {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      readSurroundSpec(cm, (spec) => {
        const pair = surroundPair(spec);
        if (pair) wrap(view, line.from, line.to, pair, false);
      });
    } else if (operator === "delete") {
      readKeys(asVimCM(cm), {
        key(target) {
          const found = findSurrounding(view, view.state.selection.main.head, target);
          if (found) {
            view.dispatch({
              changes: [
                { from: found.open[0], to: found.open[1] },
                { from: found.close[0], to: found.close[1] },
              ],
              selection: { anchor: found.open[0] },
              userEvent: "delete",
            });
          }
          return true;
        },
      });
    } else if (operator === "change") {
      readKeys(asVimCM(cm), {
        key(target) {
          const found = findSurrounding(view, view.state.selection.main.head, target);
          if (!found) return true;
          readSurroundSpec(cm, (spec) => {
            let pair = surroundPair(spec);
            if (!pair) return;
            // cs({ pads with spaces only because the new pair asks for it.
            if ("([{".includes(target) && !"([{".includes(spec)) pair = [pair[0].trim(), pair[1].trim()];
            view.dispatch({
              changes: [
                { from: found.open[0], to: found.open[1], insert: pair[0] },
                { from: found.close[0], to: found.close[1], insert: pair[1] },
              ],
              selection: { anchor: found.open[0] },
              userEvent: "input",
            });
          });
          return true;
        },
      });
    }
    return null;
  });

  // ae/ie: the whole buffer (ie without blank lines at either end).
  // ai/ii/aI/iI: lines at the cursor's indent or deeper; ai adds the line above,
  // aI the lines above and below.
  Vim.defineMotion("codecastTextObject", (cm, head, motionArgs, vim) => {
    const view = viewOf(cm);
    const doc = view.state.doc;
    const args = motionArgs as typeof motionArgs & { object: "entire" | "indent"; above?: boolean; below?: boolean };
    const blank = (n: number) => /^\s*$/.test(doc.line(n).text);
    let first: number;
    let last: number;
    if (args.object === "entire") {
      first = 1;
      last = doc.lines;
      if (args.textObjectInner) {
        while (first < last && blank(first)) first++;
        while (last > first && blank(last)) last--;
      }
    } else {
      const indentOf = (n: number) => /^\s*/.exec(doc.line(n).text)![0].replace(/\t/g, " ".repeat(view.state.tabSize)).length;
      let cur = head.line + 1;
      while (cur > 1 && blank(cur)) cur--;
      const level = indentOf(cur);
      first = last = cur;
      while (first > 1 && (blank(first - 1) || indentOf(first - 1) >= level)) first--;
      while (last < doc.lines && (blank(last + 1) || indentOf(last + 1) >= level)) last++;
      while (first < cur && blank(first)) first++;
      while (last > cur && blank(last)) last--;
      if (!args.textObjectInner && args.above && first > 1) first--;
      if (!args.textObjectInner && args.below && last < doc.lines) last++;
    }
    motionArgs.linewise = true;
    if (vim.visualMode) {
      vim.visualLine = true;
      return [{ line: first - 1, ch: 0 }, { line: last - 1, ch: doc.line(last).length }];
    }
    const opArgs = vim.inputState.operatorArgs;
    if (opArgs) opArgs.linewise = true;
    return [{ line: first - 1, ch: 0 }, { line: last - 1, ch: 0 }];
  });
}

// ── default bindings ────────────────────────────────────────────────────────

/** `<Plug>` names a vimrc may map, and the keys they stand for here. */
export const PLUG_KEYS: Record<string, string | CodeCommandId> = {
  Commentary: "gc",
  CommentaryLine: "gcc",
  "(comment_toggle_linewise)": "gc",
  "(comment_toggle_linewise_current)": "gcc",
  "(comment_toggle_linewise_visual)": "gc",
  Ysurround: "ys",
  YSurround: "ys",
  Yssurround: "yss",
  Csurround: "cs",
  Dsurround: "ds",
  VSurround: "<CcSurroundVisual>",
  "(coc-definition)": "lsp.definition",
  "(coc-declaration)": "lsp.definition",
  "(coc-references)": "lsp.references",
  "(coc-rename)": "lsp.rename",
  "(coc-format)": "lsp.format",
  "(coc-format-selected)": "lsp.format",
  "(coc-codeaction)": "lsp.codeAction",
  "(coc-codeaction-cursor)": "lsp.codeAction",
  "(coc-codeaction-source)": "lsp.codeAction",
  "(coc-codeaction-refactor)": "lsp.codeAction",
  "(coc-codeaction-refactor-selected)": "lsp.codeAction",
  "(coc-codeaction-selected)": "lsp.codeAction",
  "(coc-fix-current)": "lsp.codeAction",
  "(coc-diagnostic-next)": "diagnostic.next",
  "(coc-diagnostic-prev)": "diagnostic.prev",
  "(coc-diagnostic-next-error)": "diagnostic.next",
  "(coc-diagnostic-prev-error)": "diagnostic.prev",
  "(ale_next)": "diagnostic.next",
  "(ale_next_wrap)": "diagnostic.next",
  "(ale_previous)": "diagnostic.prev",
  "(ale_previous_wrap)": "diagnostic.prev",
  "(ale_go_to_definition)": "lsp.definition",
  "(ale_find_references)": "lsp.references",
  "(ale_hover)": "lsp.hover",
  "(ale_rename)": "lsp.rename",
  "(ale_fix)": "lsp.format",
  "(lsp-definition)": "lsp.definition",
  "(lsp-declaration)": "lsp.definition",
  "(lsp-references)": "lsp.references",
  "(lsp-hover)": "lsp.hover",
  "(lsp-rename)": "lsp.rename",
  "(lsp-document-format)": "lsp.format",
  "(lsp-code-action)": "lsp.codeAction",
  "(lsp-next-diagnostic)": "diagnostic.next",
  "(lsp-previous-diagnostic)": "diagnostic.prev",
  "(lsp-document-symbol-search)": "goto.symbol",
  "(GitGutterNextHunk)": "git.nextHunk",
  "(GitGutterPrevHunk)": "git.prevHunk",
  "(GitGutterUndoHunk)": "git.revertHunk",
  "(GitGutterPreviewHunk)": "git.peekHunk",
  "(signify-next-hunk)": "git.nextHunk",
  "(signify-prev-hunk)": "git.prevHunk",
};

/** The engine keys a `<Plug>` name runs, or null when we don't have it. */
export function plugKeys(name: string): string | null {
  const target = PLUG_KEYS[name];
  if (!target) return null;
  return target.includes(".") ? commandKeyName(target as CodeCommandId) : target;
}

/** Keys bound only when the vimrc leaves them alone. `<leader>` is filled in
 *  when the config is applied. */
export const DEFAULT_KEYS: Array<{ lhs: string; command: CodeCommandId; context?: "normal" | "visual" }> = [
  { lhs: "gd", command: "lsp.definition" },
  { lhs: "gr", command: "lsp.references" },
  { lhs: "K", command: "lsp.hover" },
  { lhs: "[d", command: "diagnostic.prev" },
  { lhs: "]d", command: "diagnostic.next" },
  { lhs: "<leader>rn", command: "lsp.rename" },
  { lhs: "]c", command: "git.nextHunk" },
  { lhs: "[c", command: "git.prevHunk" },
  { lhs: "]a", command: "agent.nextEdit" },
  { lhs: "[a", command: "agent.prevEdit" },
  { lhs: "ga", command: "agent.quoteSelection", context: "visual" },
  // Cmd-K and Cmd-L as leader keys, for a vimrc that gives Cmd its own maps.
  { lhs: "<leader>k", command: "agent.inlineInstruction" },
  { lhs: "<leader>k", command: "agent.inlineInstruction", context: "visual" },
  { lhs: "<leader>l", command: "agent.quoteSelection" },
  { lhs: "<leader>l", command: "agent.quoteSelection", context: "visual" },
];

let installed = false;
const builtinMaps: LayerMap[] = [];

export function installPlugins(): void {
  if (installed) return;
  installed = true;
  defineEngine();

  Vim.mapCommand("s", "motion", "codecastSurroundMotion", {}, { context: "operatorPending" });
  Vim.mapCommand("<CcSurroundVisual>", "action", "codecastSurroundVisual", {}, { context: "visual" });
  // Text objects need no map: their first key is never a whole command.
  for (const [keys, object, inner, extra] of [
    ["ae", "entire", false, {}],
    ["ie", "entire", true, {}],
    ["ai", "indent", false, { above: true }],
    ["ii", "indent", true, {}],
    ["aI", "indent", false, { above: true, below: true }],
    ["iI", "indent", true, {}],
  ] as const) {
    Vim.mapCommand(keys, "motion", "codecastTextObject", { object, textObjectInner: inner, ...extra }, {});
  }

  const bind = (lhs: string, rhs: string, context: VimMapContext) => {
    ensureCommandKeys(rhs);
    builtinMaps.push(addMap(lhs, rhs, context));
  };
  bind("S", "<CcSurroundVisual>", "visual");

  // Every key after <C-w> is a window command, so none falls through to the
  // engine as an ordinary one (`<C-w>x` deleting a character). The key layer
  // hands a typed pair over as one key: any single character meets
  // `<C-w><character>`, a special key its own entry (added after, so it
  // matches first). A map's right side plays each pair as its engine key.
  holdPrefixKey("<C-w>");
  Vim.mapCommand("<C-w><character>", "action", "codecastWindow", {}, { context: "normal" });
  for (const key of WINDOW_KEYS) {
    if (key.length > 1) Vim.mapCommand(`<C-w>${key}`, "action", "codecastWindow", { key }, { context: "normal" });
    // A right side's pair runs wherever the map does, as command keys do.
    Vim.mapCommand(windowEngineKey(key)!, "action", "codecastWindow", { key }, {});
  }
  // The alternate file: <C-^>, which the browser reports as Ctrl-6.
  for (const key of ["<C-6>", "<C-S-^>", "<C-^>"]) Vim.mapCommand(key, "action", "codecastCommand", { command: "tabs.alternate" }, { context: "normal" });
}

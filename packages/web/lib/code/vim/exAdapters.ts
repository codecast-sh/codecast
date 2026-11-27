// Ex commands that name editor or plugin features, run as codecast commands.
//
// One table serves two readers: the vimrc translator classifies a map's
// `:Foo<CR>` against it (applied / translated / skipped, with the reason),
// and `installExAdapters` registers every entry with Vim.defineEx so typing
// `:Rg foo` or `:NERDTreeToggle` in the command line does the same thing.

import { Vim } from "@replit/codemirror-vim";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { runCodeCommand, type CodeCommandId } from "../commands";
import { resolveVaultPath } from "../vaultPath";
import { asVimCM, notify } from "./engine";

/** `declined`: what to say when the command's handler turns it down. */
export type ExResolution = { command: CodeCommandId; args?: Record<string, unknown>; declined?: string } | { skip: string };

interface ExContext {
  /** The word under the cursor (Telescope grep_string and friends). */
  word(): string;
}

type Resolver = (arg: string, bang: boolean, ctx: ExContext) => ExResolution;

interface ExAdapter {
  name: string;
  prefix: string;
  resolve: Resolver;
  /** Acts on lines: a range typed or carried from visual mode (`:'<,'>Ask`)
   *  becomes the selection before the command runs. */
  ranged?: boolean;
}

const adapters: ExAdapter[] = [];
const run = (command: CodeCommandId, args?: Record<string, unknown>): ExResolution => ({ command, args });
const fixed = (command: CodeCommandId, args?: Record<string, unknown>): Resolver => () => run(command, args);
const skip = (reason: string): ExResolution => ({ skip: reason });
/** A split, and what vim says when the workspace has no room for it. */
const NO_ROOM = "E36: Not enough room";
const splitRun = (dir: "right" | "down"): ExResolution => ({ command: dir === "right" ? "split.right" : "split.down", declined: NO_ROOM });

function ex(names: string, resolve: Resolver, opts: { ranged?: boolean } = {}) {
  for (const n of names.split(" ")) {
    // "bn[ext]" names the full command and its shortest abbreviation.
    const m = /^([^[]+)(?:\[([^\]]+)\])?$/.exec(n)!;
    adapters.push({ name: m[1] + (m[2] ?? ""), prefix: m[1], resolve, ...opts });
  }
}

const unquote = (s: string) => s.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
const hasPath = (arg: string) => arg.trim().length > 0;

/** `:e $MYVIMRC` and friends mean "edit my vim config". */
const isVimrc = (arg: string) => /^(\$MYVIMRC|~\/\.vimrc|~\/\.vim\/vimrc|~\/\.config\/nvim\/init\.(vim|lua)|\$MYGVIMRC)$/.test(arg.trim());

/** `#`, vim's name for the alternate file. */
const isAlternate = (arg: string) => arg.trim() === "#";

function openFile(arg: string, split?: "right" | "down"): ExResolution {
  const path = arg.trim();
  if (isVimrc(path)) return run("settings.open", { section: "editor" });
  if (isAlternate(path) && !split) return run("tabs.alternate");
  if (/(^|[^\\])[%#<]/.test(path)) return skip("uses vim's filename expansion");
  const typed = path.replace(/\\ /g, " ");
  // A relative path is checked here; an absolute one only file.open can
  // check, against the vault's root.
  const absolute = typed.startsWith("/");
  const checked = resolveVaultPath(typed, null);
  if (!absolute && "refused" in checked) return skip(`${typed} ${checked.refused}`);
  const declined = absolute ? `${typed} is outside this folder` : split ? NO_ROOM : undefined;
  return { command: "file.open", args: { path: typed, ...(split ? { split } : {}) }, ...(declined ? { declined } : {}) };
}

/** The pattern a grep-like command was given, without its flags and paths. */
function grepQuery(arg: string, kind: "grep" | "vimgrep" | "rg"): string {
  const a = arg.trim();
  if (kind === "vimgrep") {
    const delim = /^([^\w\s])([\s\S]*?)\1[gjf]*(?:\s|$)/.exec(a);
    if (delim) return delim[2];
  }
  const words = a.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
  const terms = words.filter((w) => !/^-/.test(w));
  if (kind === "rg") {
    const q = a.match(/-query\s+(\S+)/);
    if (q) return unquote(q[1]);
    return terms.map(unquote).join(" ");
  }
  return unquote(terms[0] ?? "");
}

function search(query: string, regex = true): ExResolution {
  return run("search.project", query ? { query, regex } : undefined);
}

// ── files and windows ──────────────────────────────────────────────────────
// The engine leaves a space before `!` in `:w !sudo tee %` and none in `:w! file`.
ex("w[rite]", (arg, bang) => {
  const a = arg.trim();
  // `:w!` writes a file its mode refuses, as in vim, after the confirm.
  if (!a) return run(bang ? "file.overwrite" : "file.save");
  return skip(a.startsWith("!") ? "runs a shell command" : "saving under another name isn't supported");
});
ex("up[date]", fixed("file.save"));
ex("wa[ll]", fixed("file.saveAll"));
ex("q[uit]", fixed("file.close"));
ex("clo[se]", fixed("split.close"));
ex("wq x[it] exi[t]", fixed("file.saveAndClose"));
ex("wqa[ll] xa[ll]", fixed("file.saveAll"));
ex("e[dit]", (arg, bang) => (hasPath(arg) ? openFile(arg) : bang ? run("file.revert") : skip("reloading happens on its own")));
ex("tabe[dit] tabnew", (arg) => (hasPath(arg) ? openFile(arg) : run("quickOpen")));
ex("tabf[ind] fin[d]", (arg) => run("quickOpen", hasPath(arg) ? { query: arg.trim() } : undefined));
ex("sp[lit] new", (arg) => (hasPath(arg) ? openFile(arg, "down") : splitRun("down")));
ex("vs[plit] vne[w]", (arg) => (hasPath(arg) ? openFile(arg, "right") : splitRun("right")));
ex("vert[ical]", (arg, _, ctx) => {
  const inner = /^\s*(\w+)!?\s*([\s\S]*)$/.exec(arg);
  if (!inner) return skip("needs a command");
  if (/^(s(p(l(i(t)?)?)?)?|new)$/.test(inner[1])) return hasPath(inner[2]) ? openFile(inner[2], "right") : splitRun("right");
  return resolveEx(inner[1], inner[2], false, ctx);
});
ex("on[ly]", fixed("split.only"));
ex("hid[e]", fixed("split.close"));
ex("winc[md]", (arg) => windowCommand(arg.trim()));
ex("bn[ext] tabn[ext]", (arg) => (/^\d+$/.test(arg.trim()) ? run("tabs.goto", { index: Number(arg) - 1 }) : run("tabs.next")));
ex("bp[revious] bN[ext] tabp[revious] tabN[ext]", fixed("tabs.prev"));
ex("bd[elete] bw[ipeout] bun[load] tabc[lose]", fixed("file.close"));
ex("tabo[nly]", fixed("file.closeOthers"));
ex("bf[irst] br[ewind] tabfir[st] tabr[ewind]", fixed("tabs.goto", { index: 0 }));
ex("b[uffer]", (arg) => {
  const a = arg.trim();
  if (/^\d+$/.test(a)) return run("tabs.goto", { index: Number(a) - 1 });
  if (isAlternate(a)) return run("tabs.alternate");
  return a ? run("quickOpen", { query: a }) : run("tabs.switcher");
});
ex("ls buffers", fixed("tabs.switcher"));
ex("ter[minal]", fixed("terminal.toggle"));
ex("so[urce] ru[ntime]", (arg) => (/vimrc|init\.vim|%/.test(arg) ? run("vim.reloadConfig") : skip("only reloading the vimrc is supported")));

// ── file tree ───────────────────────────────────────────────────────────────
ex("Lex[plore] Rex[plore] NERDTree NERDTreeToggle NERDTreeFocus NERDTreeToggleVCS NERDTreeVCS NERDTreeCWD NvimTreeToggle NvimTreeOpen NvimTreeFocus CHADopen Fern Defx Dirvish Vaffle NeoTreeShowToggle NeoTreeFocusToggle", fixed("tree.toggle"));
ex("Ex[plore] Sex[plore] Vex[plore] Tex[plore] Hex[plore] NERDTreeFind NvimTreeFindFile NvimTreeFindFileToggle NeoTreeReveal", fixed("tree.reveal"));
ex("Neotree", (arg) => run(/reveal/.test(arg) ? "tree.reveal" : "tree.toggle"));

// ── finders ─────────────────────────────────────────────────────────────────
ex("CtrlP CtrlPMixed CtrlPMRU CtrlPMRUFiles CtrlPCurWD CtrlPRoot Files GFiles GitFiles FZF History LeaderfFile Denite Unite", fixed("quickOpen"));
ex("CtrlPBuffer Buffers LeaderfBuffer", fixed("tabs.switcher"));
ex("CtrlPFunky CtrlPBufTag BTags Tlist TlistToggle Vista Tagbar TagbarToggle TagbarOpen SymbolsOutline AerialToggle Outline LspDocumentSymbol", fixed("goto.symbol"));
ex("Tags CtrlPTag LspWorkspaceSymbol", fixed("goto.workspaceSymbol"));

const PICKERS: Record<string, (ctx: ExContext) => ExResolution> = {
  find_files: () => run("quickOpen"),
  git_files: () => run("quickOpen"),
  files: () => run("quickOpen"),
  oldfiles: () => run("quickOpen"),
  fd: () => run("quickOpen"),
  buffers: () => run("tabs.switcher"),
  live_grep: () => run("search.project"),
  grep: () => run("search.project"),
  live_grep_args: () => run("search.project"),
  grep_string: (ctx) => search(ctx.word(), false),
  grep_cword: (ctx) => search(ctx.word(), false),
  lsp_document_symbols: () => run("goto.symbol"),
  treesitter: () => run("goto.symbol"),
  current_buffer_tags: () => run("goto.symbol"),
  lsp_workspace_symbols: () => run("goto.workspaceSymbol"),
  lsp_dynamic_workspace_symbols: () => run("goto.workspaceSymbol"),
  lsp_live_workspace_symbols: () => run("goto.workspaceSymbol"),
  lsp_references: () => run("lsp.references"),
  lsp_definitions: () => run("lsp.definition"),
  lsp_code_actions: () => run("lsp.codeAction"),
};
const picker: Resolver = (arg, _, ctx) => {
  const sub = arg.trim().split(/\s+/)[0] || "find_files";
  return PICKERS[sub]?.(ctx) ?? skip(`no ${sub} picker here`);
};
ex("Telescope FzfLua Leaderf Clap", picker);

// ── search ──────────────────────────────────────────────────────────────────
ex("gr[ep] lgr[ep] grepa[dd]", (arg) => search(grepQuery(arg, "grep")));
ex("vim[grep] lv[imgrep] vimgrepa[dd]", (arg) => search(grepQuery(arg, "vimgrep")));
ex("Rg Ag Ack Grepper GrepperRg CtrlSF Rgrep RG LeaderfRg Find", (arg) => search(grepQuery(arg, "rg")));
ex("cn[ext] lne[xt] cnf[ile]", fixed("search.next"));
ex("cp[revious] cN[ext] lp[revious] lN[ext] cpf[ile]", fixed("search.prev"));
ex("cope[n] cw[indow] lop[en] lw[indow]", fixed("search.project"));

// ── git ─────────────────────────────────────────────────────────────────────
// `:Gdiffsplit` diffs against HEAD; `:Gdiffsplit main` (any ref git can read
// a file at) against that ref. The index (`:0`, `!`) reads as HEAD here.
const diffHead: Resolver = (arg) => {
  const ref = arg.trim();
  if (/^(HEAD|@|:0|!)?$/i.test(ref)) return run("git.diffHead");
  if (!/^[\w./~^@{}-]+$/.test(ref) || ref.startsWith("-") || ref.includes("..")) return skip("not a ref");
  return run("git.diffAgainst", { ref });
};
ex("Gdiff[split] Gvdiff[split] Ghdiff[split] DiffviewOpen SignifyDiff GitGutterDiffOrig", diffHead);
ex("Gblame GitBlameToggle BlameToggle", fixed("blame.toggle"));
ex("Git G", (arg) => {
  const sub = arg.trim().split(/\s+/)[0];
  if (sub === "blame") return run("blame.toggle");
  if (sub === "diff" || sub === "diffsplit" || sub === "vdiffsplit") return diffHead(arg.trim().slice(sub.length), false, { word: () => "" });
  return skip("git commands run in the terminal");
});
ex("GitGutterNextHunk SignifyNextHunk", fixed("git.nextHunk"));
ex("GitGutterPrevHunk SignifyPrevHunk", fixed("git.prevHunk"));
ex("GitGutterUndoHunk GitGutterRevertHunk SignifyHunkUndo", fixed("git.revertHunk"));
ex("GitGutterPreviewHunk SignifyHunkDiff", fixed("git.peekHunk"));
const GITSIGNS: Record<string, CodeCommandId> = {
  blame: "blame.toggle",
  blame_line: "blame.toggle",
  toggle_current_line_blame: "blame.toggle",
  next_hunk: "git.nextHunk",
  prev_hunk: "git.prevHunk",
  reset_hunk: "git.revertHunk",
  undo_stage_hunk: "git.revertHunk",
  preview_hunk: "git.peekHunk",
  preview_hunk_inline: "git.peekHunk",
  diffthis: "git.diffHead",
};
ex("Gitsigns", (arg) => {
  const words = arg.trim().split(/\s+/);
  if (words[0] === "nav_hunk") return run(words[1] === "prev" ? "git.prevHunk" : "git.nextHunk");
  const id = GITSIGNS[words[0]];
  return id ? run(id) : skip(`no Gitsigns ${words[0]} here`);
});

// ── language features ───────────────────────────────────────────────────────
ex("ALEGoToDefinition LspDefinition LspDeclaration", fixed("lsp.definition"));
ex("ALEFindReferences LspReferences", fixed("lsp.references"));
ex("ALEHover LspHover", fixed("lsp.hover"));
ex("ALERename LspRename", fixed("lsp.rename"));
ex("ALEFix LspDocumentFormat Format Prettier PrettierAsync PrettierPartial Neoformat Autoformat", fixed("lsp.format"));
ex("ALECodeAction LspCodeAction", fixed("lsp.codeAction"));
ex("ALENext ALENextWrap LspNextDiagnostic LspNextError", fixed("diagnostic.next"));
ex("ALEPrevious ALEPreviousWrap LspPreviousDiagnostic LspPreviousError", fixed("diagnostic.prev"));
const YCM: Record<string, CodeCommandId> = {
  GoTo: "lsp.definition",
  GoToDefinition: "lsp.definition",
  GoToDeclaration: "lsp.definition",
  GoToReferences: "lsp.references",
  GetDoc: "lsp.hover",
  GetType: "lsp.hover",
  RefactorRename: "lsp.rename",
  Format: "lsp.format",
  FixIt: "lsp.codeAction",
};
ex("YcmCompleter", (arg) => {
  const id = YCM[arg.trim().split(/\s+/)[0]];
  return id ? run(id) : skip("no such YcmCompleter subcommand here");
});

const LUA: Array<[RegExp, CodeCommandId]> = [
  [/vim\.lsp\.buf\.(definition|declaration)\b/, "lsp.definition"],
  [/vim\.lsp\.buf\.references\b/, "lsp.references"],
  [/vim\.lsp\.buf\.hover\b/, "lsp.hover"],
  [/vim\.lsp\.buf\.rename\b/, "lsp.rename"],
  [/vim\.lsp\.buf\.(format|formatting|range_formatting)\b/, "lsp.format"],
  [/vim\.lsp\.buf\.code_action\b/, "lsp.codeAction"],
  [/vim\.lsp\.buf\.document_symbol\b/, "goto.symbol"],
  [/vim\.lsp\.buf\.workspace_symbol\b/, "goto.workspaceSymbol"],
  [/vim\.(lsp\.)?diagnostic\.goto_next\b|vim\.diagnostic\.jump\(\s*\{\s*count\s*=\s*1\b/, "diagnostic.next"],
  [/vim\.(lsp\.)?diagnostic\.goto_prev\b|vim\.diagnostic\.jump\(\s*\{\s*count\s*=\s*-1\b/, "diagnostic.prev"],
  [/telescope\.builtin['"]?\)?\.(find_files|git_files|oldfiles)\b/, "quickOpen"],
  [/telescope\.builtin['"]?\)?\.buffers\b/, "tabs.switcher"],
  [/telescope\.builtin['"]?\)?\.(live_grep|grep_string)\b/, "search.project"],
  [/telescope\.builtin['"]?\)?\.lsp_references\b/, "lsp.references"],
  [/telescope\.builtin['"]?\)?\.lsp_definitions\b/, "lsp.definition"],
  [/telescope\.builtin['"]?\)?\.lsp_document_symbols\b/, "goto.symbol"],
  [/nvim-tree(\.api)?['"]?\)?\.tree\.toggle\b|NvimTreeToggle/, "tree.toggle"],
];
ex("lua", (arg, _, ctx) => {
  for (const [re, id] of LUA) {
    if (!re.test(arg)) continue;
    return id === "search.project" && /grep_string/.test(arg) ? search(ctx.word(), false) : run(id);
  }
  return skip("runs lua");
});

// ── agents ──────────────────────────────────────────────────────────────────
// The vim way into Cmd-K and Cmd-L, which a vimrc may map to something else:
// `:Ask fix this` sends the instruction about the selection or line to the
// linked session (bare `:Ask`, or no link, opens the box), `:Quote` quotes it
// to the linked session, `:AgentClear` clears the agent edit marks.
ex("Ask", (arg) => run("agent.inlineInstruction", arg.trim() ? { text: arg.trim() } : undefined), { ranged: true });
ex("Quote", fixed("agent.quoteSelection"), { ranged: true });
ex("AgentClear", fixed("agent.dismissEdits"));

// ── classification ──────────────────────────────────────────────────────────

/** Commands the vim engine runs itself, as name[abbreviation]. */
const NATIVE = new Set<string>();
for (const n of "colo[rscheme] map im[ap] nm[ap] vm[ap] om[ap] no[remap] nn[oremap] vn[oremap] ino[remap] ono[remap] unm[ap] mapc[lear] u[ndo] red[o] se[t] setl[ocal] setg[lobal] sor[t] s[ubstitute] startinsert noh[lsearch] y[ank] pu[t] delm[arks] marks reg[isters] v[global] d[elete] j[oin] norm[al] g[lobal] Commentary".split(" ")) {
  NATIVE.add(n);
}
const nativeNames = [...NATIVE].map((n) => {
  const m = /^([^[]+)(?:\[([^\]]+)\])?$/.exec(n)!;
  return { name: m[1] + (m[2] ?? ""), prefix: m[1] };
});

const VIMSCRIPT = /^(cal[l]?|call|exe(c(ute)?)?|let|unl(et)?|echo(m(sg)?|e(rr)?|hl)?|ec|if|for|wh(ile)?|retu(rn)?|redr(aw)?|py(thon)?3?|py3|pyx|perl|rub(y)?|fu(nction)?|try|throw|silent)$/;

const matches = (word: string, e: { name: string; prefix: string }) => word.startsWith(e.prefix) && e.name.startsWith(word);

function findAdapter(word: string): ExAdapter | undefined {
  // Exact names first: user-style commands like `Gdiff` and `Gdiffsplit` share a prefix.
  return adapters.find((a) => a.name === word) ?? adapters.find((a) => matches(word, a));
}

export function resolveEx(word: string, arg: string, bang: boolean, ctx: ExContext): ExResolution {
  const adapter = findAdapter(word);
  return adapter ? adapter.resolve(arg, bang, ctx) : skip(`no :${word} here`);
}

export type ExClass =
  | { kind: "native"; name: string }
  | { kind: "adapter"; name: string; command: CodeCommandId; args?: Record<string, unknown> }
  | { kind: "alias"; name: string }
  | { kind: "skip"; name: string; reason: string };

const PLUGIN_REASONS: Array<[RegExp, string]> = [
  [/^ALE(Toggle|Enable|Disable|Lint|Info|Detail|Reset)/, "diagnostics come from language servers here"],
  [/^(Plug|Packer|Lazy|Mason|TSUpdate|TSInstall|Coc)/, "plugin management doesn't apply here"],
  [/^Copilot|^Codeium/, "no completion plugins here"],
];

/** Classify the command at the start of an ex line, `:Foo bar`. */
export function classifyEx(line: string, aliases: ReadonlySet<string>): ExClass {
  const text = line.replace(/^[\s:]*/, "").replace(/^sil(e(n(t)?)?)?!?\s+/, "");
  // A range or a bare line number (`:%s`, `:'<,'>`, `:42`) belongs to the engine.
  const body = text.replace(/^(?:%|\d+|[.$]|'[a-z<>]|[+-]\d*)(?:,(?:\d+|[.$]|'[a-z<>]|[+-]\d*))?/, "");
  if (body.startsWith("!")) return { kind: "skip", name: "!", reason: "runs a shell command" };
  const m = /^([A-Za-z]\w*)(!?)\s*([\s\S]*)$/.exec(body);
  if (!m) return body.trim() ? { kind: "skip", name: body.trim(), reason: "can't read this command" } : { kind: "native", name: "range" };
  const [, word, bang, arg] = m;
  if (aliases.has(word)) return { kind: "alias", name: word };
  if (VIMSCRIPT.test(word)) return { kind: "skip", name: word, reason: word === "lua" ? "runs lua" : "runs vimscript" };
  const adapter = findAdapter(word);
  if (adapter) {
    const r = adapter.resolve(arg, bang === "!", { word: () => "<cword>" });
    return "skip" in r ? { kind: "skip", name: word, reason: r.skip } : { kind: "adapter", name: word, command: r.command, args: r.args };
  }
  if (nativeNames.some((n) => matches(word, n))) return { kind: "native", name: word };
  for (const [re, reason] of PLUGIN_REASONS) if (re.test(word)) return { kind: "skip", name: word, reason };
  return { kind: "skip", name: word, reason: `:${word} isn't available here` };
}

/** Every command name the command line knows, full length, for completion. */
export function exCommandNames(): string[] {
  return [...adapters.map((a) => a.name), ...nativeNames.map((n) => n.name)];
}

export function isExCommandName(word: string, aliases: ReadonlySet<string>): boolean {
  return aliases.has(word) || !!findAdapter(word) || nativeNames.some((n) => matches(word, n));
}

// ── runtime ─────────────────────────────────────────────────────────────────

export function wordAtCursor(view: EditorView | undefined, big = false): string {
  if (!view) return "";
  const { state } = view;
  const head = state.selection.main.head;
  if (big) {
    const line = state.doc.lineAt(head);
    const at = head - line.from;
    const left = /\S*$/.exec(line.text.slice(0, at))![0];
    const right = /^\S*/.exec(line.text.slice(at))![0];
    return left + right;
  }
  const range = state.wordAt(head);
  return range ? state.sliceDoc(range.from, range.to) : "";
}

function registerText(name: string): string {
  const reg = Vim.getRegisterController().getRegister(name === '"' ? undefined : name);
  return reg.toString().replace(/\n$/, "");
}

/** Expand what a command line typed by a map holds: <C-R><C-W> (word under
 *  cursor), <C-R><C-A> (WORD), <C-R><C-L> (line), <C-R>x (register x), and
 *  expand('<cword>'). */
export function expandCommandLine(view: EditorView | undefined, text: string): string {
  return text
    .replace(/<C-R>(?:<C-R>|<C-O>|<C-P>)?(<C-W>|<C-A>|<C-L>|<C-F>|.)/gi, (_, what: string) => {
      const key = what.toUpperCase();
      if (key === "<C-W>") return wordAtCursor(view);
      if (key === "<C-A>" || key === "<C-F>") return wordAtCursor(view, true);
      if (key === "<C-L>") return view ? view.state.doc.lineAt(view.state.selection.main.head).text : "";
      return registerText(what);
    })
    .replace(/expand\(\s*['"]<cword>['"]\s*\)|<cword>/g, () => wordAtCursor(view))
    .replace(/expand\(\s*['"]<cWORD>['"]\s*\)|<cWORD>/g, () => wordAtCursor(view, true));
}

/** Run a resolved ex command; true when a handler took it. */
export function runResolution(r: ExResolution, view: EditorView | undefined): boolean {
  if ("skip" in r) return false;
  const ctx = { view, source: "vim" as const };
  if (r.command === "file.saveAndClose" && !runCodeCommand(r.command, r.args, ctx)) {
    return runCodeCommand("file.save", undefined, ctx) && runCodeCommand("file.close", undefined, ctx);
  }
  return runCodeCommand(r.command, r.args, ctx);
}

/** Marks where a map that leaves the command line open puts the caret
 *  (`:%s/<C-r><C-w>//g<Left><Left>`); taken out when the line opens. */
export const PROMPT_CARET = "\uE000";

/** The ex command a map's `:...<CR>` runs through when its text needs
 *  expanding at the moment it runs (<C-R><C-W>, registers). */
export const EXPAND_EX = "CodecastEx";

let installed = false;

/** Vim's 0-based line range as the editor's selection, whole lines. */
function selectLines(view: EditorView, first: number, last: number): void {
  const doc = view.state.doc;
  const clamp = (n: number) => Math.min(doc.lines, Math.max(1, n + 1));
  const [a, b] = first <= last ? [first, last] : [last, first];
  view.dispatch({ selection: EditorSelection.range(doc.line(clamp(a)).from, doc.line(clamp(b)).to) });
}

export interface ExLines {
  line?: number;
  lineEnd?: number;
}

function runAdapter(a: ExAdapter, cm: unknown, argString: string, lines: ExLines = {}): void {
  const view = asVimCM(cm).cm6;
  if (a.ranged && view && typeof lines.line === "number") selectLines(view, lines.line, typeof lines.lineEnd === "number" ? lines.lineEnd : lines.line);
  const bang = argString.startsWith("!");
  const arg = expandCommandLine(view, bang ? argString.slice(1) : argString);
  const r = a.resolve(arg, bang, { word: () => wordAtCursor(view) });
  if ("skip" in r) notify(cm, `:${a.name}: ${r.skip}`);
  else if (!runResolution(r, view)) notify(cm, r.declined ? `:${a.name}: ${r.declined}` : `:${a.name} isn't available in this view`);
}

/** Run the adapter `name` would reach if typed, as typing it would; false
 *  when there is none. For an alias that shadowed one and is gone. */
export function runAdapterNamed(name: string, cm: unknown, argString: string, lines?: ExLines): boolean {
  const a = findAdapter(name);
  if (a) runAdapter(a, cm, argString, lines);
  return !!a;
}

/** Register every adapter with the vim engine. Idempotent. */
export function installExAdapters(): void {
  if (installed) return;
  installed = true;
  for (const a of adapters) Vim.defineEx(a.name, a.prefix, (cm, params) => runAdapter(a, cm, params.argString ?? "", params as ExLines));
  Vim.defineEx(EXPAND_EX, EXPAND_EX, (cm, params) => {
    const view = asVimCM(cm).cm6;
    // A range typed ahead of it (visual mode's '<,'>) belongs to the line it runs.
    const { line, lineEnd } = params as ExLines;
    const range = typeof line === "number" ? `${line + 1},${(lineEnd ?? line) + 1}` : "";
    Vim.handleEx(cm, range + expandCommandLine(view, (params.argString ?? "").trimStart()));
  });
}

/** Every `<C-w>` second key, as the command it runs here. A key with no
 *  counterpart resolves to a skip, so it is never left for the engine to read
 *  as an ordinary command (`<C-w>x` deleting a character). */
const WINDOW: Record<string, ExResolution> = {};
const win = (keys: string, r: ExResolution) => keys.split(" ").forEach((k) => (WINDOW[k] = r));
win("h <C-h> <Left> <BS>", run("focus.left"));
win("j <C-j> <Down>", run("focus.down"));
win("k <C-k> <Up>", run("focus.up"));
win("l <C-l> <Right>", run("focus.right"));
win("w <C-w>", run("focus.cycle", { delta: 1 }));
win("W", run("focus.cycle", { delta: -1 }));
win("t <C-t>", run("focus.cycle", { to: "first" }));
win("b <C-b>", run("focus.cycle", { to: "last" }));
win("p <C-p>", run("focus.previous"));
win("v <C-v>", splitRun("right"));
win("s S <C-s> n <C-n>", splitRun("down"));
win("c q <C-q>", run("split.close"));
win("o <C-o>", run("split.only"));
win("=", run("split.equalize"));
win("_ <C-_>", run("split.maximize", { axis: "height" }));
win("|", run("split.maximize", { axis: "width" }));
win("x <C-x>", run("split.exchange"));
win("r <C-r>", run("split.rotate", { delta: 1 }));
win("R", run("split.rotate", { delta: -1 }));
win("H", run("split.moveToEdge", { edge: "left" }));
win("L", run("split.moveToEdge", { edge: "right" }));
win("K", run("split.moveToEdge", { edge: "top" }));
win("J", run("split.moveToEdge", { edge: "bottom" }));
win("^ <C-6>", run("tabs.alternate"));

const RESIZE: Record<string, { axis: "width" | "height"; sign: 1 | -1 }> = {
  "+": { axis: "height", sign: 1 },
  "-": { axis: "height", sign: -1 },
  ">": { axis: "width", sign: 1 },
  "<": { axis: "width", sign: -1 },
};

/** Every `<C-w>` second key that runs something here. */
export const WINDOW_KEYS = [...Object.keys(WINDOW), ...Object.keys(RESIZE)];

/** The one engine key a map's right side plays for `<C-w>{key}`: the
 *  engine splits a played right side into keys and runs a lone `<C-w>` as
 *  nothing, so the pair travels as one. Null for a key with no command. */
export function windowEngineKey(key: string): string | null {
  const k = key === "<lt>" ? "<" : key;
  if (!(k in WINDOW) && !(k in RESIZE)) return null;
  return `<CcWin${[...k].map((c) => c.charCodeAt(0).toString(16)).join("")}>`;
}

/** `:wincmd` and `<C-w>` keys to commands. `count` is the count typed before
 *  `<C-w>`: one step of a resize is one percent of the workspace. */
export function windowCommand(key: string, count?: number): ExResolution {
  const resize = RESIZE[key === "<lt>" ? "<" : key];
  if (resize) return run("split.resize", { axis: resize.axis, by: resize.sign * Math.max(1, count ?? 1) });
  return WINDOW[key] ?? skip(`<C-w>${key} isn't here`);
}

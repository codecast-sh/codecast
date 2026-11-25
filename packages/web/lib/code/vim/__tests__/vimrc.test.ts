import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { installDom } from "./dom";

installDom();
const { parseVimrc } = await import("../parse");
const { tokenizeKeys, lhsKeys } = await import("../keys");
const { evaluateCondition, UnknownCondition } = await import("../expr");
const { splitCommands, logicalLines } = await import("../lines");
const { editorOptionsFromReport, wordCharsFromIskeyword } = await import("../editorOptions");
const { ensureVimConfig, currentVimConfig, onVimConfigChange } = await import("../index");

const fixture = readFileSync(new URL("../__fixtures__/vimrc.vim", import.meta.url), "utf8");
const parsed = parseVimrc([{ path: "/home/me/.vimrc", content: fixture }], { platform: "mac" });
const directives = parsed.sources[0].directives;
const find = (text: string) => {
  const d = directives.find((x) => x.text === text);
  if (!d) throw new Error(`no directive ${text}`);
  return d;
};

describe("the report", () => {
  it("says what each directive became", () => {
    const expectations: Array<[string, string, RegExp]> = [
      ["set nocompatible", "applied", /vim, not vi/],
      ["call plug#begin('~/.vim/plugged')", "skipped", /vim-plug block, 5 plugins; built in here: commentary, surround, file tree, quick open, git/],
      [`let mapleader = "'"`, "applied", /<leader> is '/],
      [`let maplocalleader = "\\<Space>"`, "applied", /<localleader> is <Space>/],
      ["set expandtab", "applied", /expandtab on/],
      ["set clipboard=unnamed", "translated", /system clipboard/],
      ["set iskeyword+=-", "translated", /word characters/],
      ["set noswapfile", "skipped", /files are read and saved by codecast/],
      ["set guifont=Menlo:h14", "skipped", /theme and font/],
      ["set foobarbaz=3", "skipped", /^unknown option$/],
      ["if has('gui_running')", "applied", /true here/],
      ["nnoremap <D-s> :w<CR>", "translated", /file\.save/],
      ["set t_Co=256", "skipped", /branch not taken \(an earlier branch ran; 2 lines\)/],
      ["if has('nvim')", "applied", /false here/],
      ["set inccommand=nosplit", "skipped", /has\('nvim'\) is false/],
      ["if exists('+colorcolumn') && v:version >= 703", "applied", /true here/],
      ["if executable('rg')", "skipped", /can't evaluate executable\(\); treated as false/],
      ["nnoremap ˙ <C-w>h", "translated", /focus\.left/],
      ["nnoremap <leader>n :NERDTreeToggle<CR>", "translated", /tree\.toggle/],
      ["nnoremap <C-p> :CtrlP<CR>", "translated", /quickOpen/],
      ["nnoremap <silent> π :CtrlPBuffer<CR>", "translated", /tabs\.switcher/],
      ["nnoremap <leader>g :Rg <C-R><C-W><CR>", "translated", /search\.project/],
      [`nnoremap <leader>* yiw:Rg <C-R>"<CR>`, "translated", /search\.project/],
      ["nnoremap <leader>gd :Gdiffsplit<CR>", "translated", /git\.diffHead/],
      ["nnoremap <leader>gb :Git blame<CR>", "translated", /blame\.toggle/],
      ["nnoremap ]q :cnext<CR>", "translated", /search\.next/],
      ["nnoremap <leader>a :ALEToggle<CR>", "skipped", /language servers/],
      ["nnoremap <leader>s :call StripTrailing()<CR>", "skipped", /runs vimscript \(:call\)/],
      ["nnoremap Y y$", "applied", /^normal: Y$/],
      ["inoremap jk <Esc>", "applied", /^insert: jk$/],
      ["xmap <leader>c <Plug>Commentary", "applied", /visual/],
      ["nnoremap <expr> j v:count ? 'j' : 'gj'", "skipped", /<expr>/],
      ["cnoremap <C-a> <Home>", "skipped", /command-line maps/],
      ["cnoreabbrev W w", "translated", /ex alias :W → :w/],
      ["smap <Tab> <Plug>snipMateNextOrTrigger", "skipped", /select mode/],
      ["noremap! <C-b> <Left>", "translated", /insert: <C-b> \(command-line maps/],
      ["iabbrev teh the", "skipped", /insert abbreviations/],
      ["nnoremap <leader>q :q<CR>", "translated", /file\.close/],
      ["command! -nargs=* Grep Rg <args>", "translated", /:Grep → :Rg <args> \(search\.project\)/],
      ["command! -bang Kill call KillBuffer(<bang>0)", "skipped", /runs vimscript/],
      ["function! StripTrailing()", "skipped", /vimscript function StripTrailing \(5 lines\)/],
      ["augroup filetypes", "skipped", /1 other line skipped/],
      ["autocmd FileType go setlocal noexpandtab tabstop=8 | setlocal colorcolumn=", "translated", /^go: noexpandtab tabstop=8 colorcolumn=$/],
      ["autocmd FileType markdown,text setlocal wrap linebreak spell", "translated", /skipped spell/],
      ["autocmd BufRead,BufNewFile *.md set filetype=markdown", "skipped", /detected/],
      ["lua << EOF", "skipped", /plugin manager block, 2 plugins/],
      ["colorscheme solarized", "skipped", /theme/],
    ];
    for (const [text, status, detail] of expectations) {
      const d = find(text);
      expect(`${text} → ${d.status}`).toBe(`${text} → ${status}`);
      expect(d.detail).toMatch(detail);
    }
  });

  it("puts each directive on the line it starts on, continuations folded in", () => {
    expect(find("let g:fzf_layout = { 'window': { 'width': 0.9, 'height': 0.6 } }").line).toBe(109);
    expect(find("nnoremap <leader>t :Files<CR>").line).toBe(113);
    // The augroup's entry comes before the FileType lines inside it.
    const at = directives.findIndex((d) => d.text === "augroup filetypes");
    expect(directives[at + 1].text).toBe("autocmd FileType python setlocal tabstop=4 shiftwidth=4");
  });

  it("splits `|` commands but keeps `||` in conditions", () => {
    expect(splitCommands("nnoremap <leader>l :nohlsearch<CR>| nnoremap <leader>q :q<CR>")).toEqual([
      "nnoremap <leader>l :nohlsearch<CR>",
      "nnoremap <leader>q :q<CR>",
    ]);
    expect(splitCommands(`if has("mac") || has('unix') " both`)).toEqual([`if has("mac") || has('unix')`]);
    expect(splitCommands("nnoremap x :a\\|b<CR>")).toEqual(["nnoremap x :a\\|b<CR>"]);
    expect(splitCommands(`let g:x = "a | b" | set ts=2`)).toEqual([`let g:x = "a | b"`, "set ts=2"]);
    expect(splitCommands(`set sw=2 " indent`)).toEqual(["set sw=2"]);
    expect(splitCommands("autocmd FileType go setlocal ts=4 | setlocal noet")).toEqual(["autocmd FileType go setlocal ts=4 | setlocal noet"]);
    expect(logicalLines("a\n  \\ b\n\"\\ note\n  \\ c\nd").map((l) => [l.line, l.text])).toEqual([
      [1, "a b c"],
      [5, "d"],
    ]);
  });

  it("collects options globally and per filetype", () => {
    expect(parsed.options.global).toMatchObject({ tabstop: 4, shiftwidth: 4, expandtab: true, number: true, relativenumber: true, wrap: false, scrolloff: 8, cursorline: true });
    expect(parsed.options.byFiletype.go).toEqual({ expandtab: false, tabstop: 8, colorcolumn: "" });
    const ts = editorOptionsFromReport(parsed, "typescriptreact");
    expect(ts).toMatchObject({ tabSize: 2, indentUnit: "  ", lineNumbers: "relative", wrap: false, colorColumns: [101], wordChars: "-" });
    expect(editorOptionsFromReport(parsed, "Markdown")).toMatchObject({ wrap: true, lineBreak: true });
  });

  it("counts by status", () => {
    const c = { applied: 0, translated: 0, skipped: 0 };
    for (const d of directives) c[d.status]++;
    expect(c.applied + c.translated + c.skipped).toBe(directives.length);
    expect(c.translated).toBeGreaterThan(25);
  });
});

describe("key notation", () => {
  it("normalizes to what the engine reports for a keypress", () => {
    const keys = (s: string) => lhsKeys(tokenizeKeys(s).map((t) => (t.kind === "key" ? t.keys : `[${t.kind}]`)).join(""));
    expect(keys("<c-X><C-S-x><M-j><A-j><D-s><S-Tab><cr><ESC><space><bar><lt><Bslash>")).toBe("<C-x><C-S-X><A-j><A-j><M-s><S-Tab><CR><Esc><Space>|<\\");
    expect(keys("<S-a> x")).toBe("A<Space>x");
    expect(keys("<leader>w<Plug>(coc-rename)<Nop>")).toBe("[leader]w[plug][nop]");
    expect(keys("˙∆<foo>")).toBe("˙∆<foo>");
  });
});

describe("conditions", () => {
  const ctx = {
    env: { platform: "linux" as const },
    option: (n: string) => (n === "compatible" ? false : undefined),
    optionExists: (n: string) => n === "termguicolors",
    variableExists: (n: string) => n === "g:loaded_x",
    commandExists: (n: string) => n === "NERDTree",
  };
  it("evaluates the usual vimrc branches", () => {
    expect(evaluateCondition("has('mac') || has('unix')", ctx)).toBe(true);
    expect(evaluateCondition("!has('nvim') && has('gui_running')", ctx)).toBe(true);
    expect(evaluateCondition("has('macunix')", ctx)).toBe(false);
    expect(evaluateCondition("v:version >= 800 && exists('+termguicolors')", ctx)).toBe(true);
    expect(evaluateCondition("exists('g:loaded_x') && exists(':NERDTree') == 2", ctx)).toBe(true);
    expect(evaluateCondition("&compatible", ctx)).toBe(false);
    expect(evaluateCondition("(has('win32') || has('win64'))", ctx)).toBe(false);
  });
  it("throws for what it can't know", () => {
    expect(() => evaluateCondition("executable('rg')", ctx)).toThrow(UnknownCondition);
    expect(() => evaluateCondition("&t_Co > 2", ctx)).toThrow(UnknownCondition);
  });
});

it("reads iskeyword into extra word characters", () => {
  expect(wordCharsFromIskeyword("@,48-57,_,192-255,-,#,$")).toBe("-#$");
  expect(wordCharsFromIskeyword("@,48-57,_,45")).toBe("-");
});

it("ensureVimConfig paints from the cached config, then adopts the fresh one", async () => {
  localStorage.clear();
  const first = { sources: [{ path: "/home/me/.vimrc", content: "set ts=3" }], overlay: null };
  const report = await ensureVimConfig(async () => JSON.stringify(first));
  expect(report.options.global.tabstop).toBe(3);
  expect(localStorage.getItem("codecast:code-vimrc:v3")).toContain("ts=3");

  // A reload with a changed vimrc replaces it; a fetch that fails keeps it.
  const second = { sources: [{ path: "/home/me/.vimrc", content: "set ts=5" }], overlay: { path: "/home/me/.codecast/editor/vimrc", content: "set sw=1" } };
  const reloaded = await ensureVimConfig(async () => JSON.stringify(second), { reload: true });
  expect(reloaded.options.global).toMatchObject({ tabstop: 5, shiftwidth: 1 });
  expect(reloaded.sources[1].overlay).toBe(true);
  const kept = await ensureVimConfig(async () => {
    throw new Error("daemon offline");
  }, { reload: true });
  expect(kept.options.global.tabstop).toBe(5);
  expect(currentVimConfig()?.options.global.tabstop).toBe(5);
});

describe("structure on one line, and comments on structure lines", () => {
  const source = readFileSync(new URL("../__fixtures__/structure.vim", import.meta.url), "utf8");
  const report = parseVimrc([{ path: "/home/me/.vimrc", content: source }], { platform: "mac" });
  const lines = report.sources[0].directives;
  const at = (text: string) => {
    const d = lines.find((x) => x.text === text);
    if (!d) throw new Error(`no directive ${text}`);
    return d;
  };

  it("closes a one-line if, true or false, and reads on past it", () => {
    expect(at("set mouse=a").status).toBe("applied");
    expect(at("nnoremap <Space>w :w<CR>").status).toBe("translated");
    expect(at("set number").status).toBe("applied");
    expect(at("set inccommand=split")).toMatchObject({ status: "skipped", detail: expect.stringMatching(/branch not taken \(has\('nvim'\) is false; 1 line\)/) });
    expect(at("set hlsearch").status).toBe("applied");
    // Nested inside a branch that runs, and one that doesn't.
    expect(at("set icm=nosplit").detail).toMatch(/branch not taken/);
    expect(at("set lines=40").detail).not.toMatch(/branch not taken/);
    expect(at("if has('mac') | set linebreak | endif").detail).toMatch(/branch not taken \(has\('nvim'\) is false; 2 lines\)/);
    expect(at("nnoremap <Space>z zz").status).toBe("applied");
  });

  it("keeps the lines after a one-line augroup", () => {
    expect(at("augroup vimrc")).toMatchObject({ status: "applied", detail: "augroup vimrc" });
    expect(at("nnoremap <leader>q :q<CR>").status).toBe("translated");
  });

  it("reads if, else and endif with a trailing comment", () => {
    expect(at("if !has('nvim')").detail).toBe("true here");
    expect(at("set cursorline").status).toBe("applied");
    expect(at("set norelativenumber").detail).toMatch(/branch not taken/);
    expect(at("set relativenumber").status).toBe("applied");
    expect(lines.some((d) => /out of place/.test(d.detail))).toBe(false);
  });

  it("skips one-line loops and functions without swallowing what follows", () => {
    expect(at("for f in ['a']").detail).toBe("vimscript for block (1 line)");
    expect(at("function! F()").detail).toBe("vimscript function F (1 line)");
    expect(at("set wrap").status).toBe("applied");
    expect(at("set scrolloff=3").status).toBe("applied");
  });

  it("gives an augroup whose END an autocmd swallowed only its own line", () => {
    expect(report.options.byFiletype.go).toEqual({ tabstop: 8 });
    expect(at("set incsearch").status).toBe("applied");
    expect(report.options.global).toMatchObject({ number: true, cursorline: true, relativenumber: true, wrap: true, scrolloff: 3 });
  });

  it("keeps the config between a swallowed augroup and the next normal one", () => {
    expect(at("set textwidth=100").status).toBe("applied");
    expect(at("nnoremap <leader>s :w<CR>").status).toBe("translated");
    expect(at("augroup other")).toMatchObject({ status: "skipped", detail: "augroup other: 1 other line skipped" });
    expect(report.options.byFiletype.python).toEqual({ tabstop: 4 });
    expect(at("set colorcolumn=80").status).toBe("applied");
  });

  it("ends an augroup that never closes where the next one opens", () => {
    expect(at("augroup unclosed").status).toBe("applied");
    expect(at("set shiftwidth=2").status).toBe("applied");
    expect(report.options.global).toMatchObject({ textwidth: 100, shiftwidth: 2 });
  });

  it("splits `autocmd!` that only clears at its `|`", () => {
    expect(splitCommands("augroup vimrc | autocmd! | augroup END")).toEqual(["augroup vimrc", "autocmd!", "augroup END"]);
    expect(splitCommands("autocmd! BufWrite * | echo 1")).toEqual(["autocmd! BufWrite *", "echo 1"]);
    expect(splitCommands("autocmd BufWrite * echo 1 | echo 2")).toEqual(["autocmd BufWrite * echo 1 | echo 2"]);
  });
});

it("ensureVimConfig keeps the newest config when an older fetch lands last", async () => {
  localStorage.clear();
  const config = (ts: number) => JSON.stringify({ sources: [{ path: "/home/me/.vimrc", content: `set ts=${ts}` }], overlay: null });
  let releaseOld!: () => void;
  const old = ensureVimConfig(() => new Promise<string>((resolve) => (releaseOld = () => resolve(config(6)))), { reload: true });
  const fresh = await ensureVimConfig(async () => config(7), { reload: true });
  expect(fresh.options.global.tabstop).toBe(7);
  releaseOld();
  expect((await old).options.global.tabstop).toBe(7);
  expect(currentVimConfig()?.options.global.tabstop).toBe(7);
  expect(JSON.parse(localStorage.getItem("codecast:code-vimrc:v3")!).response).toContain("ts=7");
});

it("ensureVimConfig applies nothing again for an unchanged vimrc", async () => {
  localStorage.clear();
  const same = () => JSON.stringify({ sources: [{ path: "/home/me/.vimrc", content: "set ts=9" }], overlay: null });
  await ensureVimConfig(async () => same(), { reload: true });
  let applied = 0;
  const off = onVimConfigChange(() => applied++);
  const kept = await ensureVimConfig(async () => same(), { reload: true });
  expect(kept.options.global.tabstop).toBe(9);
  expect(applied).toBe(0);
  await ensureVimConfig(async () => JSON.stringify({ sources: [{ path: "/home/me/.vimrc", content: "set ts=8" }], overlay: null }), { reload: true });
  expect(applied).toBe(1);
  off();
});

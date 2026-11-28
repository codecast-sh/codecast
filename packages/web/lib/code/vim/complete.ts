// Tab completion on the `:` command line, as vim's wildmenu with
// `wildmode=longest,list,full`: the first Tab fills in what every candidate
// shares and lists them on a strip above the line, each Tab after that steps
// through them (Shift-Tab back). Command names come from the ex adapters, the
// engine's own commands and the vimrc's aliases; paths for :e, :sp, :vs and
// :tabe from the folder's file table; open tabs for :b. Work happens only on
// Tab, never per keystroke.

import type { EditorView } from "@codemirror/view";
import { exCommandNames } from "./exAdapters";
import { exCompletionSourceFor } from "./completionSource";

let aliasNames: () => Iterable<string> = () => [];

/** The vimrc's ex aliases, read when a completion runs. */
export function setExAliasNames(fn: () => Iterable<string>): void {
  aliasNames = fn;
}

/** `name[abbr]` lists, as the adapter table writes them. */
function commandSet(names: string): (word: string) => boolean {
  const list = names.split(" ").map((n) => {
    const m = /^([^[]+)(?:\[([^\]]+)\])?$/.exec(n)!;
    return { prefix: m[1], name: m[1] + (m[2] ?? "") };
  });
  return (word) => list.some((e) => word.startsWith(e.prefix) && e.name.startsWith(word));
}
const takesPath = commandSet("e[dit] sp[lit] vs[plit] new vne[w] tabe[dit] tabnew");
const takesTab = commandSet("b[uffer] sb[uffer]");

const RANGE = /^[\s:]*(?:(?:[%.$]|\d+|'[a-zA-Z<>]|[+-]\d*)(?:\s*[,;]\s*(?:[.$]|\d+|'[a-zA-Z<>]|[+-]\d*))*)?/;

export interface Completion {
  /** Where the completed word starts in the line. */
  start: number;
  items: string[];
}

const escapePath = (p: string) => p.replace(/ /g, "\\ ");

/** The folder entries directly under `typed`'s folder that start with its
 *  last segment; folders end in `/`. */
function pathItems(typed: string, files: Record<string, { dir?: boolean }>): string[] {
  const raw = typed.replace(/\\ /g, " ");
  const slash = raw.lastIndexOf("/");
  const dir = raw.slice(0, slash + 1);
  const out = new Set<string>();
  for (const path in files) {
    if (!path.startsWith(raw)) continue;
    const next = path.indexOf("/", dir.length);
    if (next >= 0) out.add(path.slice(0, next + 1));
    else out.add(files[path].dir ? `${path}/` : path);
  }
  return [...out].sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || (a < b ? -1 : 1)).map(escapePath);
}

/** What a Tab at the end of `line` could complete to. */
export function exCompletions(line: string, src: { commands: Iterable<string>; files: Record<string, { dir?: boolean }> | null; tabs: string[] }): Completion | null {
  const range = RANGE.exec(line)![0];
  const body = line.slice(range.length);
  const name = /^([A-Za-z]\w*)$/.exec(body) ?? (body === "" ? ["", ""] : null);
  if (name) {
    const word = name[1];
    const items = [...new Set(src.commands)].filter((c) => c.startsWith(word) && c !== word).sort();
    return { start: range.length, items };
  }
  const cmd = /^([A-Za-z]\w*)!?\s+((?:\\ |\S)*)$/.exec(body);
  if (!cmd) return null;
  const [, word, arg] = cmd;
  const start = line.length - arg.length;
  if (takesTab(word)) {
    const needle = arg.toLowerCase();
    return { start, items: src.tabs.filter((t) => t.toLowerCase().includes(needle)).map(escapePath) };
  }
  if (takesPath(word) && src.files) return { start, items: pathItems(arg, src.files) };
  return null;
}

function commonPrefix(items: string[]): string {
  let p = items[0] ?? "";
  for (const s of items) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}

/** Wire Tab and Shift-Tab completion into an open `:` prompt. */
export function attachExCompletion(view: EditorView, input: HTMLInputElement, panel: HTMLElement): void {
  let state: { base: string; start: number; items: string[]; at: number } | null = null;
  let strip: HTMLElement | null = null;

  const hide = () => {
    state = null;
    strip?.remove();
    strip = null;
  };
  const draw = () => {
    if (!state || state.items.length < 2) return hide();
    if (!strip) {
      strip = document.createElement("div");
      strip.className = "cm-vim-wild";
      panel.prepend(strip);
    }
    const shown = state.items.slice(Math.max(0, state.at - 20), Math.max(0, state.at - 20) + 40);
    strip.replaceChildren(
      ...shown.map((item) => {
        const el = document.createElement("span");
        el.textContent = item.endsWith("/") ? item.slice(item.lastIndexOf("/", item.length - 2) + 1) : item.slice(item.lastIndexOf("/") + 1) || item;
        if (state!.items[state!.at] === item) el.className = "cm-vim-wild-on";
        return el;
      }),
    );
  };
  const set = (text: string) => {
    input.value = text;
    input.setSelectionRange(text.length, text.length);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    const back = e.shiftKey;
    if (state && input.value === state.base.slice(0, state.start) + (state.items[state.at] ?? state.base.slice(state.start))) {
      const n = state.items.length;
      state.at = state.at < 0 ? (back ? n - 1 : 0) : (state.at + (back ? -1 : 1) + n) % n;
      set(state.base.slice(0, state.start) + state.items[state.at]);
      return draw();
    }
    const line = input.value.slice(0, input.selectionStart ?? input.value.length);
    const source = exCompletionSourceFor(view);
    const found = exCompletions(line, { commands: [...exCommandNames(), ...aliasNames()], files: source?.files() ?? null, tabs: source?.tabs() ?? [] });
    if (!found || found.items.length === 0) return hide();
    const head = line.slice(0, found.start);
    if (found.items.length === 1) {
      set(head + found.items[0]);
      return hide();
    }
    const longest = commonPrefix(found.items);
    const typed = line.slice(found.start);
    set(head + (longest.length > typed.length ? longest : typed));
    state = { base: input.value, start: found.start, items: found.items, at: -1 };
    draw();
  });
  input.addEventListener("input", hide);
  input.addEventListener("blur", hide);
}

// The symbol path at the cursor (class › method) for the breadcrumbs row,
// read from the Lezer syntax tree the language already keeps, with the
// outline's own classifier (lsp/symbols.ts symbolOfNode), so a symbol has the
// kind and color here that it has in Go to symbol. A ViewPlugin writes it into
// the group's row as plain DOM, at most once a frame, and only when the path
// changed, so typing costs a tree walk of a few parent hops and no React at
// all. Pressing a crumb lists that level's symbols (a class's methods, the
// file's top level) in the symbol pick, on the current one.

import type { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { crumbsForView, onCrumbsBound } from "./groupRegistry";
import { runCodeCommand } from "../commands";
import { CHEVRON_RIGHT, lineIcon } from "../icons";
import { isContainerKind, kindGlyph, symbolOfNode, type SymbolKindName } from "../lsp/symbols";

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

export interface SymbolCrumb {
  name: string;
  kind: SymbolKindName;
  /** Where the symbol's name starts. */
  from: number;
}

/** Symbols enclosing `pos`, outermost first. */
export function symbolPathAt(state: EditorState, pos: number): SymbolCrumb[] {
  const tree = syntaxTree(state);
  if (!tree.length) return [];
  const out: SymbolCrumb[] = [];
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    const sym = symbolOfNode(state, node);
    if (sym && isContainerKind(sym.kind)) out.push({ name: sym.name.slice(0, 80), kind: sym.kind, from: sym.nameFrom });
  }
  return out.reverse();
}

/** lucide's ChevronRight, sized like the folder segments' separator in
 *  CodeFileBar, so the row has one separator. */
const chevron = () => lineIcon(CHEVRON_RIGHT, 12, "mx-0.5 h-3 w-3 shrink-0 opacity-60");

/** Write the crumbs into the row's element. A press opens the symbol pick on
 *  that crumb's level (its container's symbols), with the crumb selected. */
function render(view: EditorView, el: HTMLElement, crumbs: SymbolCrumb[]): void {
  el.textContent = "";
  crumbs.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "truncate transition-opacity hover:opacity-80";
    b.style.color = kindGlyph(c.kind).color;
    b.textContent = c.name;
    b.title = c.kind;
    b.onclick = () => {
      runCodeCommand("goto.symbol", { container: i > 0 ? crumbs[i - 1].name : null, current: c.name }, { view, source: "menu" });
    };
    el.append(chevron(), b);
  });
}

const plugins = new Map<object, { refresh(): void }>();
onCrumbsBound((view) => plugins.get(view)?.refresh());

export const symbolPathPlugin = ViewPlugin.fromClass(
  class {
    private frame = 0;
    private last = "\u0000";
    private el: HTMLElement | null = null;
    constructor(private readonly view: EditorView) {
      plugins.set(view, this);
      this.schedule();
    }
    refresh() {
      this.last = "\u0000";
      this.schedule();
    }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.schedule();
    }
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const el = crumbsForView(this.view);
        if (!el) return;
        const crumbs = symbolPathAt(this.view.state, this.view.state.selection.main.head);
        const key = crumbs.map((c) => `${c.kind}:${c.name}`).join("|");
        if (key === this.last && el === this.el) return;
        this.last = key;
        this.el = el;
        render(this.view, el, crumbs);
      });
    }
    destroy() {
      if (this.frame) cancelAnimationFrame(this.frame);
      if (plugins.get(this.view) === this) plugins.delete(this.view);
    }
  },
);

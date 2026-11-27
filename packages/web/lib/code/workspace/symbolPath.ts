// The symbol path at the cursor (class › method) for the breadcrumbs row,
// read from the Lezer syntax tree the language already keeps. A ViewPlugin
// writes it into the group's row as plain DOM, at most once a frame, and only
// when the path changed, so typing costs a tree walk of a few parent hops and
// no React at all.

import type { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { crumbsForView, onCrumbsBound } from "./groupRegistry";

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

export interface SymbolCrumb {
  name: string;
  kind: "class" | "function" | "type" | "module";
  /** Where the symbol's name starts. */
  from: number;
}

const DECLARATION = /^(Class|Interface|Enum|Struct|Trait|Impl|Mod|Module|Namespace|Function|Method|TypeAlias|Type|Object|Constructor|Record|Union)(Declaration|Definition|Item|Decl|Spec)$/;
/** A variable or property is a symbol when its value is a function or class. */
const BINDING = /^(VariableDeclaration|VariableDeclarator|LexicalDeclaration|Property|PropertyDeclaration|Assignment)$/;
const FUNCTION_VALUE = /^(ArrowFunction|FunctionExpression|ClassExpression|Lambda|ParamList)$/;
const NAME = /(Definition|Name|Identifier)$/;

function kindOf(type: string): SymbolCrumb["kind"] {
  if (/^(Class|Struct|Object|Record|Impl|Trait)/.test(type)) return "class";
  if (/^(Interface|Enum|TypeAlias|Type|Union)/.test(type)) return "type";
  if (/^(Mod|Module|Namespace)/.test(type)) return "module";
  return "function";
}

function nameChild(node: SyntaxNode): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (NAME.test(c.type.name)) return c;
    // Rust's `impl Trait for Type` names the type after `for`; take the first type.
    if (c.type.name === "TypeIdentifier") return c;
  }
  return null;
}

function hasFunctionValue(node: SyntaxNode): boolean {
  for (let c = node.firstChild; c; c = c.nextSibling) if (FUNCTION_VALUE.test(c.type.name)) return true;
  return false;
}

/** Symbols enclosing `pos`, outermost first. */
export function symbolPathAt(state: EditorState, pos: number): SymbolCrumb[] {
  const tree = syntaxTree(state);
  if (!tree.length) return [];
  const out: SymbolCrumb[] = [];
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    const type = node.type.name;
    let kind: SymbolCrumb["kind"] | null = null;
    if (DECLARATION.test(type)) kind = kindOf(type);
    else if (BINDING.test(type) && hasFunctionValue(node)) kind = /ClassExpression/.test(node.lastChild?.type.name ?? "") ? "class" : "function";
    if (!kind) continue;
    const name = nameChild(node);
    if (!name) continue;
    out.push({ name: state.sliceDoc(name.from, Math.min(name.to, name.from + 80)), kind, from: name.from });
  }
  return out.reverse();
}

const KIND_CLASS: Record<SymbolCrumb["kind"], string> = {
  class: "text-sol-yellow",
  function: "text-sol-blue",
  type: "text-sol-cyan",
  module: "text-sol-magenta",
};

const SVG = "http://www.w3.org/2000/svg";

/** lucide's ChevronRight, sized like the folder segments' separator in
 *  CodeFileBar, so the row has one separator. */
function chevron(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "mx-0.5 h-3 w-3 shrink-0 opacity-60");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "m9 18 6-6-6-6");
  svg.append(path);
  return svg;
}

/** Write the crumbs into the row's element (buttons that jump to each symbol).
 *  A crumb finds its symbol when clicked, so edits above it never need a
 *  rebuild to keep the jump right. */
function render(view: EditorView, el: HTMLElement, crumbs: SymbolCrumb[]): void {
  el.textContent = "";
  crumbs.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `truncate transition-colors hover:text-sol-text ${KIND_CLASS[c.kind]}`;
    b.textContent = c.name;
    b.title = `Go to ${c.name}`;
    b.onclick = () => {
      const now = symbolPathAt(view.state, view.state.selection.main.head)[i];
      const from = now && now.name === c.name ? now.from : Math.min(c.from, view.state.doc.length);
      view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
      view.focus();
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

// Symbols in a file, for the outline pick (goto.symbol): the language
// server's documentSymbol when one is attached, else what the file's Lezer
// syntax tree shows (functions, classes, types, methods, top-level bindings),
// so the pick works for every language with a grammar. The breadcrumbs
// (workspace/symbolPath.ts) read the same classifier, `symbolOfNode`, so a
// symbol has one kind and one color on both surfaces.

import type * as lsp from "./protocol";
import type { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { offsetIn } from "./edits";

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

export type SymbolKindName =
  | "file" | "module" | "namespace" | "class" | "method" | "property" | "field" | "constructor" | "enum"
  | "interface" | "function" | "variable" | "constant" | "type" | "struct" | "event" | "operator" | "member";

export interface OutlineSymbol {
  name: string;
  kind: SymbolKindName;
  /** The enclosing symbol's name. */
  container?: string;
  detail?: string;
  /** Offsets in the document the symbols were read from. */
  from: number;
  /** Where the symbol's text ends. */
  to: number;
  /** Where the cursor goes: the name. */
  nameFrom: number;
}

const LSP_KIND: Record<number, SymbolKindName> = {
  1: "file", 2: "module", 3: "namespace", 4: "module", 5: "class", 6: "method", 7: "property", 8: "field",
  9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 15: "constant",
  16: "constant", 17: "constant", 18: "constant", 19: "type", 20: "property", 21: "constant", 22: "member",
  23: "struct", 24: "event", 25: "operator", 26: "type",
};

export function lspKindName(kind: number | undefined): SymbolKindName {
  return (kind && LSP_KIND[kind]) || "variable";
}

const GLYPH: Record<SymbolKindName, [string, string]> = {
  file: ["F", "--sol-text-dim"], module: ["M", "--sol-violet"], namespace: ["N", "--sol-violet"],
  class: ["C", "--sol-yellow"], struct: ["S", "--sol-yellow"], interface: ["I", "--sol-cyan"], type: ["T", "--sol-cyan"],
  enum: ["E", "--sol-yellow"], method: ["m", "--sol-blue"], function: ["ƒ", "--sol-blue"], constructor: ["c", "--sol-blue"],
  property: ["p", "--sol-green"], field: ["p", "--sol-green"], member: ["e", "--sol-green"], variable: ["v", "--sol-magenta"],
  constant: ["k", "--sol-magenta"], event: ["!", "--sol-orange"], operator: ["o", "--sol-text-dim"],
};

/** The letter and color the picks draw for a kind. */
export function kindGlyph(kind: SymbolKindName): { letter: string; color: string; title: string } {
  const [letter, color] = GLYPH[kind] ?? ["·", "--sol-text-dim"];
  return { letter, color: `var(${color})`, title: kind };
}

/** A documentSymbol answer (nested DocumentSymbol or flat SymbolInformation)
 *  as a flat outline in document order. */
export function flattenLspSymbols(result: readonly (lsp.DocumentSymbol | lsp.SymbolInformation)[] | null, state: EditorState): OutlineSymbol[] {
  if (!result?.length) return [];
  const out: OutlineSymbol[] = [];
  const doc = state.doc;
  const walk = (items: readonly lsp.DocumentSymbol[], container?: string) => {
    for (const s of items) {
      out.push({
        name: s.name,
        kind: lspKindName(s.kind),
        container,
        detail: s.detail || undefined,
        from: offsetIn(doc, s.range.start),
        to: offsetIn(doc, s.range.end),
        nameFrom: offsetIn(doc, s.selectionRange.start),
      });
      if (s.children?.length) walk(s.children, s.name);
    }
  };
  if ("location" in result[0]) {
    for (const s of result as lsp.SymbolInformation[]) {
      const from = offsetIn(doc, s.location.range.start);
      out.push({ name: s.name, kind: lspKindName(s.kind), container: s.containerName || undefined, from, to: offsetIn(doc, s.location.range.end), nameFrom: from });
    }
  } else walk(result as lsp.DocumentSymbol[]);
  return out.sort((a, b) => a.from - b.from);
}

// ── Lezer fallback ──────────────────────────────────────────────────────────

/** Node names that declare something, and what. Grammars name these
 *  consistently enough (FunctionDeclaration, ClassDefinition, StructItem,
 *  FunctionDecl, MethodDeclaration) for one table to read most of them. */
const DECLARATIONS: [RegExp, SymbolKindName][] = [
  [/^(Method|MethodDeclaration|MethodDefinition|MethodDecl|MethodSpec)$/, "method"],
  [/Constructor/, "constructor"],
  [/^(Function|FunctionDeclaration|FunctionDefinition|FunctionItem|FunctionDecl|FuncDecl|FunctionStatement)$/, "function"],
  [/^(Class|ClassDeclaration|ClassDefinition|ClassItem|ClassSpecifier)$/, "class"],
  [/^(Interface|InterfaceDeclaration|TraitItem|ProtocolDeclaration)$/, "interface"],
  [/^(TypeAliasDeclaration|TypeItem|TypeSpec|TypeDecl|TypeDefinition)$/, "type"],
  [/^(Enum|EnumDeclaration|EnumItem|EnumSpecifier)$/, "enum"],
  [/^(Struct|StructItem|StructSpecifier|StructDeclaration)$/, "struct"],
  [/^(Module|ModuleDeclaration|ModItem|NamespaceDeclaration|NamespaceDefinition)$/, "module"],
  [/^(ImplItem)$/, "class"],
  [/^(PropertyDeclaration|PropertyDefinition|FieldDefinition)$/, "property"],
  [/^(VariableDeclaration|LexicalDeclaration|ConstItem|StaticItem|ConstDecl|VarDecl|LetDeclaration|Declaration|AssignStatement)$/, "variable"],
];

/** Names inside a declaration that are the declared name. */
const NAME_NODE = /^(VariableDefinition|PropertyDefinition|PropertyName|TypeDefinition|DefName|Definition|BoundIdentifier|TypeIdentifier|VariableName|Identifier|Name|FieldName|FieldIdentifier)$/;

/** Bodies whose locals are not outline entries. */
const FUNCTION_BODY = /^(Function|Method|Arrow|Lambda|Closure|Func)/;

/** A binding is a function or class when its value is one (`const X = () =>`,
 *  `{ run: function () {} }`, `f = lambda: 0`). */
const FUNCTION_VALUE = /^(ArrowFunction|FunctionExpression|Lambda|LambdaExpression|ClosureExpression|FuncLiteral)$/;
const CLASS_VALUE = /^(ClassExpression)$/;
/** Object members, which are symbols only when their value is a function. */
const MEMBER = /^(Property)$/;

const kindFor = (name: string): SymbolKindName | null => {
  for (const [re, kind] of DECLARATIONS) if (re.test(name)) return kind;
  return null;
};

/** Kinds that hold other symbols: the breadcrumbs' levels. */
export const isContainerKind = (kind: SymbolKindName) => kind !== "variable" && kind !== "property" && kind !== "constant" && kind !== "field" && kind !== "member";

/** What one syntax node declares, if anything: its name and kind. */
export function symbolOfNode(state: EditorState, node: SyntaxNode): { name: string; kind: SymbolKindName; nameFrom: number } | null {
  let kind = kindFor(node.name);
  const member = !kind && MEMBER.test(node.name);
  if (!kind && !member) return null;
  // The declared name: the first name-like direct child (or grandchild, for
  // grammars that wrap it, like a C declarator).
  let nameNode: SyntaxNode | null = null;
  let value: string | null = null;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (!nameNode) {
      if (NAME_NODE.test(c.name)) nameNode = c;
      else if (/Declarator|Pattern|Signature|Head/.test(c.name)) {
        for (let g = c.firstChild; g; g = g.nextSibling) if (NAME_NODE.test(g.name)) { nameNode = g; break; }
      }
    } else if (FUNCTION_VALUE.test(c.name) || CLASS_VALUE.test(c.name)) {
      value = c.name;
      break;
    }
  }
  if (!nameNode) return null;
  if (kind === "variable" || kind === "property" || member) {
    if (value) kind = CLASS_VALUE.test(value) ? "class" : member || kind === "property" ? "method" : "function";
    else if (member) return null;
  }
  const name = state.sliceDoc(nameNode.from, nameNode.to);
  if (!name || name.length >= 200) return null;
  return { name, kind: kind!, nameFrom: nameNode.from };
}

/** The outline of a file from its syntax tree. Waits up to `timeoutMs` for
 *  the parser to reach the end of the file, else reads what it has. */
export function lezerSymbols(state: EditorState, timeoutMs = 200): OutlineSymbol[] {
  const tree = ensureSyntaxTree(state, state.doc.length, timeoutMs) ?? syntaxTree(state);
  const out: OutlineSymbol[] = [];
  const containers: { name: string; to: number }[] = [];
  const functionEnds: number[] = [];
  tree.iterate({
    enter: (node) => {
      while (containers.length && containers[containers.length - 1].to <= node.from) containers.pop();
      while (functionEnds.length && functionEnds[functionEnds.length - 1] <= node.from) functionEnds.pop();
      const kind = kindFor(node.name);
      const candidate = kind || MEMBER.test(node.name);
      const insideFunction = functionEnds.length > 0;
      if (candidate && !(insideFunction && (kind === "variable" || kind === "property" || !kind))) {
        const sym = symbolOfNode(state, node.node);
        if (sym) {
          out.push({ ...sym, container: containers[containers.length - 1]?.name, from: node.from, to: node.to });
          if (isContainerKind(sym.kind)) containers.push({ name: sym.name, to: node.to });
        }
      }
      if (FUNCTION_BODY.test(node.name) && kind !== "class") functionEnds.push(node.to);
    },
  });
  return out;
}

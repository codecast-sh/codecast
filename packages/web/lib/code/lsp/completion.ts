// Completion while a language server is attached: the server's items first,
// words from the file after them (minus any the server already offered), in
// one popup that fills once rather than reshuffling as answers arrive.
//
// The stock source in @codemirror/lsp-client never resolves an item, and
// typescript-language-server sends documentation and auto-import edits only on
// completionItem/resolve, so here the info panel resolves the item it shows,
// and accepting an item applies the edits its resolve brought (an import line).
// All of it stays inside CodeMirror's autocomplete: no React, no store.

import type * as lsp from "./protocol";
import type { EditorView } from "@codemirror/view";
import { language } from "@codemirror/language";
import type { ChangeSpec, Extension, Text } from "@codemirror/state";
import {
  autocompletion,
  completeAnyWord,
  insertCompletionText,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { LSPPlugin } from "@codemirror/lsp-client";
import { offsetIn } from "./edits";
import { capabilitiesOf, serverCan } from "./protocol";

/** How long words wait for the server's answer to the same keystroke, so the
 *  popup opens once with both. Past it words show alone. */
const WORDS_WAIT_MS = 250;

// LSP snippet syntax to CodeMirror's: drop backslashes before `$}\`, which
// CodeMirror does not escape, and write `$1` as `${1}`.
export function lspToSnippet(text: string): string {
  return text.replace(/\\([$}\\])|\$(\d+)/g, (_m, esc, field) => esc || `\${${field}}`);
}

const KIND_TYPE: Record<number, string> = {
  1: "text", 2: "method", 3: "function", 4: "class", 5: "property", 6: "variable", 7: "class", 8: "interface",
  9: "namespace", 10: "property", 11: "keyword", 12: "constant", 13: "enum", 14: "keyword", 15: "text",
  16: "constant", 17: "text", 18: "text", 19: "namespace", 20: "constant", 21: "constant", 22: "class",
  23: "keyword", 24: "keyword", 25: "type",
};

/** Non-word prefixes the items start with (`@`, `#`, `.`), for validFor. */
function prefixRegexp(items: readonly lsp.CompletionItem[]): RegExp {
  const step = Math.ceil(items.length / 50);
  const prefixes: string[] = [];
  for (let i = 0; i < items.length; i += step) {
    const item = items[i];
    const text = item.textEdit?.newText || item.textEditText || item.insertText || item.label;
    if (!/^\w/.test(text)) {
      const prefix = /^[^\w]*/.exec(text)![0];
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
  }
  if (!prefixes.length) return /^\w*$/;
  return new RegExp(`^(?:${prefixes.map((p) => p.replace(/[^\w\s]/g, "\\$&")).join("|")})?\\w*$`);
}

function triggerKind(plugin: LSPPlugin, ch: string, explicit: boolean): lsp.CompletionContext | null {
  if (explicit) return { triggerKind: 1 };
  const triggers = capabilitiesOf(plugin.client)?.completionProvider?.triggerCharacters;
  if (triggers?.includes(ch)) return { triggerKind: 2, triggerCharacter: ch };
  if (/[\w$]/.test(ch)) return { triggerKind: 1 };
  return null;
}

function resultRange(cx: CompletionContext, list: lsp.CompletionList): { from: number; to: number } {
  const item0 = list.items[0];
  const def = list.itemDefaults?.editRange;
  const range = def ? ("insert" in def ? def.insert : def) : item0?.textEdit ? ("range" in item0.textEdit ? item0.textEdit.range : item0.textEdit.insert) : null;
  if (range && range.start.line === range.end.line) {
    const line = cx.state.doc.lineAt(cx.pos);
    if (range.start.line === line.number - 1) return { from: line.from + range.start.character, to: line.from + range.end.character };
  }
  const word = cx.matchBefore(/[\w$]*/);
  return { from: word?.from ?? cx.pos, to: cx.pos };
}

/** additionalTextEdits are positions in the document before the item was
 *  inserted: read them there, then carry them past the insert, which replaced
 *  `from..to` and moved everything after it by `delta`. */
function editsToChanges(before: Text, insert: { from: number; to: number; delta: number }, edits: readonly lsp.TextEdit[] | undefined): ChangeSpec[] {
  const map = (p: number) => (p <= insert.from ? p : p >= insert.to ? p + insert.delta : insert.from);
  return (edits ?? []).map((e) => ({ from: map(offsetIn(before, e.range.start)), to: map(offsetIn(before, e.range.end)), insert: e.newText }));
}

/** A markdown code block the hover renderer highlights in the file's language
 *  (it highlights a fence whose tag is the editor language's name). */
export function codeFence(view: EditorView, code: string, lang?: string): string {
  return "```" + (lang ?? view.state.facet(language)?.name ?? "") + "\n" + code + "\n```";
}

function renderInfo(plugin: LSPPlugin, item: lsp.CompletionItem): Node | null {
  const docText = typeof item.documentation === "string" ? item.documentation : item.documentation?.value;
  if (!item.detail && !docText?.trim()) return null;
  const dom = document.createElement("div");
  dom.className = "cm-lsp-documentation cm-lsp-completion-documentation";
  // The detail is a signature: shown as code, in the file's language.
  if (item.detail) dom.innerHTML = plugin.docToHTML({ kind: "markdown", value: codeFence(plugin.view, item.detail) });
  if (docText?.trim()) dom.insertAdjacentHTML("beforeend", plugin.docToHTML(item.documentation!, "markdown"));
  return dom;
}

interface Inflight {
  view: EditorView | undefined;
  pos: number;
  doc: unknown;
  labels: Promise<Set<string>>;
}

let inflight: Inflight | null = null;

/** Completions from the language server attached to this editor. */
export const lspCompletionSource: CompletionSource = (cx) => {
  const plugin = cx.view && LSPPlugin.get(cx.view);
  if (!plugin || !serverCan(plugin.client, "completionProvider")) return null;
  const context = triggerKind(plugin, cx.state.sliceDoc(cx.pos - 1, cx.pos), cx.explicit);
  if (!context) return null;
  plugin.client.sync();
  const params: lsp.CompletionParams = { textDocument: { uri: plugin.uri }, position: plugin.toPosition(cx.pos), context };
  cx.addEventListener("abort", () => plugin.client.cancelRequest(params));
  const request = plugin.client.request<lsp.CompletionParams, lsp.CompletionItem[] | lsp.CompletionList | null>("textDocument/completion", params);
  const result = request.then(
    (raw): CompletionResult | null => {
      if (!raw) return null;
      const list: lsp.CompletionList = Array.isArray(raw) ? { isIncomplete: false, items: raw } : raw;
      if (!list.items.length) return null;
      const { from, to } = resultRange(cx, list);
      const resolvable = !!capabilitiesOf(plugin.client)?.completionProvider?.resolveProvider;
      const defaultCommit = list.itemDefaults?.commitCharacters;
      return {
        from,
        to,
        commitCharacters: defaultCommit,
        validFor: list.isIncomplete ? undefined : prefixRegexp(list.items),
        options: list.items.map((item): Completion => {
          let resolved: Promise<lsp.CompletionItem> | null = null;
          const resolve = () =>
            (resolved ??= resolvable && !item.documentation
              ? plugin.client.request<lsp.CompletionItem, lsp.CompletionItem>("completionItem/resolve", item).catch(() => item)
              : Promise.resolve(item));
          let settled: lsp.CompletionItem | null = resolvable ? null : item;
          const text = item.textEdit?.newText || item.textEditText || item.insertText || item.label;
          const isSnippet = (item.insertTextFormat ?? list.itemDefaults?.insertTextFormat) === 2;
          return {
            label: item.filterText || item.label,
            displayLabel: item.label,
            detail: item.labelDetails?.description ?? (item.detail && item.detail.length < 40 ? item.detail : undefined),
            type: item.kind ? KIND_TYPE[item.kind] : undefined,
            sortText: item.sortText,
            ...(item.commitCharacters && item.commitCharacters !== defaultCommit ? { commitCharacters: item.commitCharacters } : {}),
            info: () =>
              resolve().then((full) => {
                settled = full;
                return renderInfo(plugin, full);
              }),
            apply: (view, completion, from, to) => {
              const before = view.state.doc;
              if (isSnippet) snippet(lspToSnippet(text))(view, completion, from, to);
              else view.dispatch(insertCompletionText(view.state, text, from, to));
              const insert = { from, to, delta: view.state.doc.length - before.length };
              // Edits elsewhere (an import). Ready when the info panel resolved
              // the item; otherwise applied when the resolve lands, if the
              // person has not typed in between.
              const extra = (full: lsp.CompletionItem) => {
                const changes = editsToChanges(before, insert, full.additionalTextEdits);
                if (changes.length) view.dispatch({ changes, userEvent: "input.complete" });
              };
              if (settled) return extra(settled);
              const doc = view.state.doc;
              void resolve().then((full) => {
                if (view.state.doc === doc) extra(full);
              });
            },
          };
        }),
      };
    },
    (err: { code?: number }) => {
      if (err?.code === -32800) return null;
      throw err;
    },
  );
  inflight = {
    view: cx.view,
    pos: cx.pos,
    doc: cx.state.doc,
    labels: result.then(
      (r) => new Set(r?.options.map((o) => o.label) ?? []),
      () => new Set<string>(),
    ),
  };
  return result;
};

/** Words from the file, under the server's items and without its labels. */
export const wordCompletionSource: CompletionSource = async (cx) => {
  const words = await completeAnyWord(cx);
  if (!words) return null;
  const mine = inflight && inflight.view === cx.view && inflight.pos === cx.pos && inflight.doc === cx.state.doc ? inflight.labels : null;
  const taken = mine ? await Promise.race([mine, new Promise<null>((r) => setTimeout(() => r(null), WORDS_WAIT_MS))]) : null;
  if (cx.aborted) return null;
  const options = words.options.filter((o) => !taken?.has(o.label)).map((o) => ({ ...o, boost: -50 }));
  return options.length ? { ...words, options } : null;
};

/** The completion setup while a server is attached (replaces the plain word
 *  completion the editor has otherwise). */
export function lspCompletion(): Extension {
  return autocompletion({ override: [lspCompletionSource, wordCompletionSource] });
}

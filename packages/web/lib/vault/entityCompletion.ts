// `[[` completion for codecast objects.
//
// Typing `[[` in a note has always offered NOTES. It now also offers sessions,
// tasks, plans, docs and people — the same list the `@` mention dropdown offers
// everywhere else in the app, from the same store-local query, so no new server
// call rides on a keystroke.
//
// The two kinds of completion insert DIFFERENT TEXT, which is the whole point:
//
//   a note   → `[[Some Note]]`   (unchanged, byte for byte)
//   an object → `[Title](https://codecast.sh/tasks/ct-40561)`
//
// A note lives in the vault, so the vault's own link syntax addresses it. An
// object lives in codecast, and the only address that still means something in
// Obsidian, on GitHub, or in a plain editor is its URL. So picking an object
// REPLACES the `[[` the user typed, brackets and all, with an ordinary markdown
// link. The replacement is a pure function of the document (below) so it can be
// asserted without a browser.

import type { EditorState } from "@codemirror/state";
import type { Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import {
  entityRefMarkdown,
  makeEntityRef,
  sanitizeLinkText,
  type EntityRefType,
  type VaultEntityRef,
} from "@codecast/shared/vault";

/** The mention-dropdown item shape, narrowed to the fields a link needs. */
export interface EntityCompletionItem {
  id: string;
  type: string;
  label: string;
  sublabel?: string | null;
  shortId?: string | null;
}

/** Mention types that address an object a note can link. Labels (the user's
 *  personal filing) are absent on purpose: they have no page of their own. */
const LINKABLE: Record<string, EntityRefType> = {
  session: "session",
  task: "task",
  doc: "doc",
  plan: "plan",
  person: "person",
  project: "project",
  trigger: "trigger",
};

/**
 * The reference a mention item points at, or null when it addresses nothing
 * linkable — a label, or a person with no github username (the handle
 * `/team/<name>` needs). Returning null is the honest answer: a link that
 * cannot resolve anywhere is worse than no completion.
 */
export function refForMentionItem(item: EntityCompletionItem): VaultEntityRef | null {
  const type = LINKABLE[item.type];
  if (!type) return null;
  if (type === "person") {
    const handle = (item.shortId || "").replace(/^@/, "");
    return handle ? makeEntityRef("person", handle) : null;
  }
  // Short id first — `ct-40561` reads as itself in the file, where a 32-char
  // Convex id reads as noise. Docs have no short id and fall back to theirs.
  return makeEntityRef(type, item.shortId || item.id) ?? makeEntityRef(type, item.id);
}

/** The text the link carries: the object's name, or the handle for a person. */
export function linkTextFor(item: EntityCompletionItem, ref: VaultEntityRef): string {
  if (ref.type === "person") return `@${ref.id}`;
  return sanitizeLinkText(item.label) || ref.id;
}

/** The markdown a picked item inserts, or null when it addresses nothing. */
export function markdownForMentionItem(item: EntityCompletionItem): string | null {
  const ref = refForMentionItem(item);
  if (!ref) return null;
  return entityRefMarkdown(ref, linkTextFor(item, ref));
}

/**
 * Swap the `[[…` the user is typing for a finished markdown link.
 *
 * `from`/`to` are the completion's own range, which starts just INSIDE the
 * brackets — so the replacement reaches two characters back for the `[[`, and
 * forward over the `]]` closeBrackets inserts when the second `[` is typed.
 * Missing either end leaves `[[[Title](url)]]` in somebody's file.
 */
export function entityLinkEdit(
  state: EditorState,
  from: number,
  to: number,
  insert: string,
): { changes: { from: number; to: number; insert: string }; selection: { anchor: number } } {
  const start = Math.max(0, from - 2);
  const end = state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
  return {
    changes: { from: start, to: end, insert },
    selection: { anchor: start + insert.length },
  };
}

/** Completion options for a batch of mention items, in the order the mention
 *  query ranked them (the result sets `filter: false`, so that order stands). */
export function entityCompletions(items: readonly EntityCompletionItem[]): Completion[] {
  const options: Completion[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const markdown = markdownForMentionItem(item);
    if (!markdown) continue;
    const ref = refForMentionItem(item)!;
    if (seen.has(ref.key)) continue;
    seen.add(ref.key);
    options.push({
      label: sanitizeLinkText(item.label) || ref.id,
      detail: ref.type === "person" ? `@${ref.id}` : item.shortId || ref.type,
      apply: (view: EditorView, _c: Completion, from: number, to: number) => {
        const edit = entityLinkEdit(view.state, from, to, markdown);
        view.dispatch({ ...edit, userEvent: "input.complete" });
      },
    });
  }
  return options;
}

/**
 * What is being completed inside `[[ … ]]` at `pos`, or null when the cursor
 * isn't in one. Objects are offered on the plain target only: after a `#` the
 * user is picking a heading of the named note, and after a `|` they are writing
 * their own display text — neither is a place to insert a URL.
 */
export function wikiCompletionContext(
  lineText: string,
  lineFrom: number,
  pos: number,
): { from: number; query: string } | null {
  const before = lineText.slice(0, pos - lineFrom);
  const open = before.lastIndexOf("[[");
  if (open === -1) return null;
  const inner = before.slice(open + 2);
  if (inner.includes("]]") || inner.includes("|") || inner.includes("#")) return null;
  return { from: lineFrom + open + 2, query: inner };
}

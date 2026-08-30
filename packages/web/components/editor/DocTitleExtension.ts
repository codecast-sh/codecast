import { Extension, Node } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Title-first documents.
 *
 * A doc is one text and its title is the first block: a level 1 heading the
 * schema requires, so the title is never a separate field. Paste a page and
 * line one is the title; arrow up out of the body and you are in it. The
 * markdown that leaves the editor opens with `# Title`, which is what the
 * server reads the stored title from (@codecast/shared/docs).
 *
 * Two pieces:
 * - `TitleFirstDocument` replaces StarterKit's top node with one whose content
 *   is `heading block*`. ProseMirror then keeps the first block a heading on
 *   every edit: select-all-delete leaves an empty title, a toolbar "turn into
 *   paragraph" on it is refused, a paste that lands in it fills it and pushes
 *   the rest below.
 * - `DocTitleExtension` holds the two invariants the schema can't express: the
 *   title is level 1, and it is one line (a pasted newline or a Shift+Enter in
 *   it splits the remainder off into a paragraph). It also brings a doc whose
 *   snapshot predates the rule up to it on open, using `fallbackTitle` (the
 *   stored title) as the heading text when the body has none.
 */
export const TITLE_FIRST_CONTENT = "heading block*";

export const TitleFirstDocument = Node.create({
  name: "doc",
  topNode: true,
  content: TITLE_FIRST_CONTENT,
});

export interface DocTitleOptions {
  /** The stored title, written in as the heading when a legacy body opens without one. */
  fallbackTitle: () => string;
}

/** The first hard line break inside the title block, as a doc position and its width. */
function titleLineBreak(title: PMNode): { pos: number; size: number } | null {
  let found: { pos: number; size: number } | null = null;
  title.forEach((child, offset) => {
    if (found) return;
    if (child.type.name === "hardBreak") found = { pos: 1 + offset, size: child.nodeSize };
    else if (child.isText && child.text!.includes("\n")) {
      found = { pos: 1 + offset + child.text!.indexOf("\n"), size: 1 };
    }
  });
  return found;
}

/**
 * Apply the title invariants to `tr`'s doc. Returns whether it changed
 * anything. Safe to call on a doc that predates the schema (first block a
 * paragraph): the steps it builds all leave a valid doc behind.
 */
export function ensureTitleBlock(tr: Transaction, fallbackTitle: string): boolean {
  const { schema } = tr.doc.type;
  const heading = schema.nodes.heading;
  const first = tr.doc.firstChild;
  const titleText = fallbackTitle.trim() ? schema.text(fallbackTitle.trim()) : undefined;

  if (!first) {
    tr.insert(0, heading.create({ level: 1 }, titleText));
    return true;
  }
  if (first.type !== heading) {
    if (first.type.name === "paragraph" && first.textContent.trim() === "") {
      // An empty first paragraph becomes the title, carrying the stored title.
      tr.setNodeMarkup(0, heading, { level: 1 });
      if (titleText) tr.insertText(titleText.text!, 1);
    } else {
      // A body that starts with real content keeps it; the title goes above.
      tr.insert(0, heading.create({ level: 1 }, titleText));
    }
    return true;
  }
  if (first.attrs.level !== 1) {
    tr.setNodeMarkup(0, undefined, { ...first.attrs, level: 1 });
    return true;
  }
  const brk = titleLineBreak(first);
  if (brk) {
    tr.delete(brk.pos, brk.pos + brk.size);
    tr.split(brk.pos, 1, [{ type: schema.nodes.paragraph }]);
    return true;
  }
  return false;
}

const pluginKey = new PluginKey("docTitle");

export const DocTitleExtension = Extension.create<DocTitleOptions>({
  name: "docTitle",

  addOptions() {
    return { fallbackTitle: () => "" };
  },

  onCreate() {
    // The initial content is not a transaction, so the invariants run once
    // here. On a legacy snapshot this is the one collaborative step that
    // gives the doc its title block; a current doc dispatches nothing.
    const tr = this.editor.state.tr;
    if (ensureTitleBlock(tr, this.options.fallbackTitle())) this.editor.view.dispatch(tr);
  },

  addKeyboardShortcuts() {
    return {
      // Enter anywhere in the title: what follows the cursor becomes the
      // first body paragraph, never a second title-sized heading.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if ($from.depth !== 1 || $from.index(0) !== 0) return false;
        return editor.commands.command(({ tr, state }) => {
          if (!empty) tr.deleteSelection();
          tr.split(tr.mapping.map($from.pos), 1, [{ type: state.schema.nodes.paragraph }]);
          tr.scrollIntoView();
          return true;
        });
      },
    };
  },

  addProseMirrorPlugins() {
    const fallbackTitle = this.options.fallbackTitle;
    return [
      new Plugin({
        key: pluginKey,
        appendTransaction: (transactions, _old, newState) => {
          if (!transactions.some((t) => t.docChanged)) return null;
          const tr = newState.tr;
          return ensureTitleBlock(tr, fallbackTitle()) ? tr : null;
        },
      }),
    ];
  },
});

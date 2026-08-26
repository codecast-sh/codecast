import { Node, mergeAttributes, InputRule } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { NodeType } from "@tiptap/pm/model";
import { SHORT_ID_PREFIX } from "../../lib/entityLinks";
import { EntityIdNodeView } from "./EntityIdNodeView";

// The same bare-id vocabulary read mode pills (shared/entities BARE_ID_SOURCE),
// minus the raw-32-char-Convex-id branch: converting an arbitrary hash someone
// is typing into an atom is too aggressive for an editor, and those ids only
// resolve through a server round-trip anyway. Prefixed short ids derive from
// the shared registry so a new object type lights up here automatically.
const PREFIX_ALT = Object.keys(SHORT_ID_PREFIX).join("|");
const ENTITY_SOURCE = `(?:${PREFIX_ALT})-[a-z0-9]+|jx[a-z0-9]{5,}|doc:[a-z0-9]{20,}`;
const ENTITY_PATTERN = new RegExp(`\\b(?:${ENTITY_SOURCE})\\b`, "gi");
const INPUT_RULE_RE = new RegExp(`(?:^|\\s)(${ENTITY_SOURCE})\\s$`, "i");

/**
 * Build a transaction converting bare entity ids in text into entityId atoms.
 * `cursorPos` (when given) protects the id under the cursor so typing one
 * isn't yanked into an atom mid-keystroke; pass null for the initial
 * whole-document pass on editor creation.
 */
function buildConversionTr(
  state: EditorState,
  entityType: NodeType,
  cursorPos: number | null,
): Transaction | null {
  const replacements: { from: number; to: number; id: string }[] = [];

  state.doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return;
    // Leave code and links alone: rewriting inside a code span/block corrupts
    // verbatim content, and link text is EntityRefExtension's territory (the
    // href, not the text, names the object there).
    if (parent?.type.spec.code) return;
    if (node.marks.some((m) => m.type.name === "code" || m.type.name === "link")) return;
    // An id inside an `@[Title id]` mention belongs to the mention —
    // EntityRefExtension converts the whole thing. Eating the id out of it
    // here would leave `@[Title ` + pill + `]` behind.
    const mentionSpans: [number, number][] = [];
    const mentionRe = /@\[[^\]]*\]/g;
    let mm;
    while ((mm = mentionRe.exec(node.text)) !== null) {
      mentionSpans.push([mm.index, mm.index + mm[0].length]);
    }
    const re = new RegExp(ENTITY_PATTERN.source, "gi");
    let match;
    while ((match = re.exec(node.text)) !== null) {
      const start = match.index;
      if (mentionSpans.some(([s, e]) => start >= s && start < e)) continue;
      const from = pos + start;
      const to = pos + start + match[0].length;
      if (cursorPos == null || cursorPos < from || cursorPos > to) {
        replacements.push({ from, to, id: match[0].toLowerCase() });
      }
    }
  });

  if (replacements.length === 0) return null;
  const tr = state.tr;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { from, to, id } = replacements[i];
    tr.replaceWith(from, to, entityType.create({ shortId: id }));
  }
  return tr;
}

export const EntityIdExtension = Node.create({
  name: "entityId",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      shortId: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-entity-id]",
        getAttrs: (el: HTMLElement) => ({
          shortId: el.getAttribute("data-entity-id"),
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-entity-id": node.attrs.shortId }),
      node.attrs.shortId,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EntityIdNodeView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(node.attrs.shortId);
        },
        parse: {},
      },
    };
  },

  // The initial whole-document pass. Loading content dispatches no transaction,
  // so without this a doc opened in the editor showed its ids as plain text
  // until the first keystroke.
  onCreate() {
    const tr = buildConversionTr(this.editor.state, this.type, null);
    if (tr) this.editor.view.dispatch(tr);
  },

  addInputRules() {
    const entityType = this.type;
    return [
      new InputRule({
        find: INPUT_RULE_RE,
        handler: ({ state, range, match }) => {
          const id = match[1].toLowerCase();
          const idStart = range.from + match[0].indexOf(match[1]);
          const idEnd = idStart + match[1].length;
          const node = entityType.create({ shortId: id });
          state.tr.replaceWith(idStart, idEnd, node);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const entityType = this.type;
    return [
      new Plugin({
        key: new PluginKey("entityIdAutoConvert"),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          return buildConversionTr(newState, entityType, newState.selection.$head.pos);
        },
      }),
    ];
  },
});

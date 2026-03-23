import { Node, mergeAttributes, InputRule } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { EntityIdNodeView } from "./EntityIdNodeView";

const ENTITY_PATTERN = /\b(ct|pl)-[a-z0-9]+\b/gi;
const INPUT_RULE_RE = /(?:^|\s)((ct|pl)-[a-z0-9]+)\s$/i;

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
    let processedInitial = false;
    return [
      new Plugin({
        key: new PluginKey("entityIdAutoConvert"),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;

          const cursorPos = newState.selection.$head.pos;
          const replacements: { from: number; to: number; id: string }[] = [];

          newState.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return;
            const re = new RegExp(ENTITY_PATTERN.source, "gi");
            let match;
            while ((match = re.exec(node.text)) !== null) {
              const from = pos + match.index;
              const to = pos + match.index + match[0].length;
              if (!processedInitial) {
                replacements.push({ from, to, id: match[0].toLowerCase() });
              } else if (cursorPos < from || cursorPos > to) {
                replacements.push({ from, to, id: match[0].toLowerCase() });
              }
            }
          });

          if (replacements.length > 0) processedInitial = true;
          if (replacements.length === 0) {
            if (!processedInitial) processedInitial = true;
            return null;
          }

          const tr = newState.tr;
          for (let i = replacements.length - 1; i >= 0; i--) {
            const { from, to, id } = replacements[i];
            tr.replaceWith(from, to, entityType.create({ shortId: id }));
          }
          return tr;
        },
      }),
    ];
  },
});

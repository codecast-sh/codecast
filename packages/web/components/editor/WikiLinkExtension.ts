/**
 * WikiLinkExtension — TipTap extension for [[wiki-style]] doc links.
 *
 * Typing `[[` opens a suggestion popup filtered to docs only.
 * Selecting a doc inserts a styled inline link: [[Doc Title]]
 * The link navigates to /docs/<id> on click.
 */
import { Node, mergeAttributes } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { MentionList, type MentionItem } from "./MentionList";

export type WikiLinkQueryFn = (query: string) => Promise<MentionItem[]>;

const WIKI_LINK_PLUGIN_KEY = new PluginKey("wikiLink");

export function createWikiLinkExtension(queryFn: WikiLinkQueryFn) {
  return Node.create({
    name: "wikiLink",
    group: "inline",
    inline: true,
    atom: true,

    addAttributes() {
      return {
        id: { default: null },
        label: { default: null },
        docType: { default: null },
      };
    },

    parseHTML() {
      return [
        {
          tag: 'a[data-wiki-link]',
          getAttrs: (el: HTMLElement) => ({
            id: el.getAttribute("data-wiki-link-id"),
            label: el.textContent?.replace(/^\[\[|\]\]$/g, "") || "",
            docType: el.getAttribute("data-doc-type") || null,
          }),
        },
      ];
    },

    renderHTML({ node }) {
      const { id, label, docType } = node.attrs;
      return [
        "a",
        mergeAttributes({
          class: `wiki-link wiki-link-${docType || "note"}`,
          href: `/docs/${id}`,
          "data-wiki-link": "",
          "data-wiki-link-id": id,
          "data-doc-type": docType || "",
        }),
        `[[${label || "Untitled"}]]`,
      ];
    },

    addProseMirrorPlugins() {
      const editor = this.editor;

      return [
        new Plugin({
          key: WIKI_LINK_PLUGIN_KEY,
          state: {
            init: () => ({ active: false, query: "", from: 0 }),
            apply(tr, prev) {
              const meta = tr.getMeta(WIKI_LINK_PLUGIN_KEY);
              if (meta) return meta;
              if (!prev.active) return prev;
              // Keep tracking while active
              const { from } = tr.selection;
              const text = tr.doc.textBetween(prev.from, from, "");
              // If user deleted back past the [[ trigger, deactivate
              if (from <= prev.from) return { active: false, query: "", from: 0 };
              return { ...prev, query: text };
            },
          },
          props: {
            handleTextInput(view, from, _to, text) {
              const state = WIKI_LINK_PLUGIN_KEY.getState(view.state);
              if (state?.active) return false;

              // Check if the previous char was [ and current is [
              if (text === "[") {
                const before = view.state.doc.textBetween(Math.max(from - 1, 0), from, "");
                if (before === "[") {
                  // Activate wiki link mode
                  view.dispatch(
                    view.state.tr.setMeta(WIKI_LINK_PLUGIN_KEY, {
                      active: true,
                      query: "",
                      from: from + 1, // after the second [
                    })
                  );
                }
              }
              return false;
            },
            handleKeyDown(view, event) {
              const state = WIKI_LINK_PLUGIN_KEY.getState(view.state);
              if (!state?.active) return false;

              if (event.key === "Escape") {
                view.dispatch(
                  view.state.tr.setMeta(WIKI_LINK_PLUGIN_KEY, {
                    active: false,
                    query: "",
                    from: 0,
                  })
                );
                return true;
              }

              // Check for ]] to close
              if (event.key === "]") {
                const { from } = view.state.selection;
                const before = view.state.doc.textBetween(Math.max(from - 1, 0), from, "");
                if (before === "]") {
                  view.dispatch(
                    view.state.tr.setMeta(WIKI_LINK_PLUGIN_KEY, {
                      active: false,
                      query: "",
                      from: 0,
                    })
                  );
                  return false;
                }
              }

              return false;
            },
            decorations(state) {
              const pluginState = WIKI_LINK_PLUGIN_KEY.getState(state);
              if (!pluginState?.active) return DecorationSet.empty;

              // Add a decoration to highlight the [[ trigger area
              const triggerFrom = Math.max(pluginState.from - 2, 0);
              return DecorationSet.create(state.doc, [
                Decoration.inline(triggerFrom, state.selection.from, {
                  class: "wiki-link-typing",
                }),
              ]);
            },
          },
          view(editorView) {
            let component: ReactRenderer<any> | null = null;
            let popup: TippyInstance[] | null = null;
            let lastQuery = "";

            function show(query: string) {
              if (!component) {
                const items = queryFn(query);
                component = new ReactRenderer(MentionList, {
                  props: {
                    items,
                    command: (item: MentionItem) => {
                      const state = WIKI_LINK_PLUGIN_KEY.getState(editorView.state);
                      if (!state?.active) return;

                      // Delete the [[ trigger text and the query
                      const triggerFrom = Math.max(state.from - 2, 0);
                      const to = editorView.state.selection.from;

                      editor
                        .chain()
                        .focus()
                        .deleteRange({ from: triggerFrom, to })
                        .insertContent({
                          type: "wikiLink",
                          attrs: {
                            id: item.id,
                            label: item.label,
                            docType: item.docType || null,
                          },
                        })
                        .insertContent(" ")
                        .run();

                      // Deactivate
                      editorView.dispatch(
                        editorView.state.tr.setMeta(WIKI_LINK_PLUGIN_KEY, {
                          active: false,
                          query: "",
                          from: 0,
                        })
                      );

                      hide();
                    },
                  },
                  editor,
                });

                const coords = editorView.coordsAtPos(editorView.state.selection.from);
                popup = tippy("body", {
                  getReferenceClientRect: () => new DOMRect(coords.left, coords.top, 0, 20),
                  appendTo: () => document.body,
                  content: component.element,
                  showOnCreate: true,
                  interactive: true,
                  trigger: "manual",
                  placement: "bottom-start",
                  zIndex: 10002,
                });
              }

              // Update items
              if (query !== lastQuery) {
                lastQuery = query;
                queryFn(query).then((items: MentionItem[]) => {
                  component?.updateProps({ items });
                });
              }
            }

            function hide() {
              popup?.[0]?.destroy();
              popup = null;
              component?.destroy();
              component = null;
              lastQuery = "";
            }

            return {
              update(view) {
                const state = WIKI_LINK_PLUGIN_KEY.getState(view.state);
                if (state?.active) {
                  show(state.query);
                } else {
                  hide();
                }
              },
              destroy() {
                hide();
              },
            };
          },
        }),
      ];
    },
  });
}

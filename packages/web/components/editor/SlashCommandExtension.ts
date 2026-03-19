import { Extension } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import Suggestion from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { SlashCommandList, SLASH_COMMANDS, type SlashCommandItem } from "./SlashCommand";

export const SlashCommandExtension = Extension.create({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: true,
        items: ({ query }: { query: string }) => {
          const q = query.toLowerCase();
          if (!q) return SLASH_COMMANDS;
          return SLASH_COMMANDS.filter(
            (cmd) =>
              cmd.title.toLowerCase().includes(q) ||
              cmd.description.toLowerCase().includes(q)
          );
        },
        command: ({ editor, range, props: item }: any) => {
          editor.chain().focus().deleteRange(range).run();
          (item as SlashCommandItem).command(editor);
        },
        render: () => {
          let component: ReactRenderer<any> | null = null;
          let popup: TippyInstance[] | null = null;

          return {
            onStart: (props: any) => {
              component = new ReactRenderer(SlashCommandList, {
                props: { ...props, editor: props.editor },
                editor: props.editor,
              });

              if (!props.clientRect) return;

              popup = tippy("body", {
                getReferenceClientRect: props.clientRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
              });
            },
            onUpdate(props: any) {
              component?.updateProps({ ...props, editor: props.editor });
              if (popup?.[0] && props.clientRect) {
                popup[0].setProps({
                  getReferenceClientRect: props.clientRect,
                });
              }
            },
            onKeyDown(props: any) {
              if (props.event.key === "Escape") {
                popup?.[0]?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },
            onExit() {
              popup?.[0]?.destroy();
              component?.destroy();
            },
          };
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

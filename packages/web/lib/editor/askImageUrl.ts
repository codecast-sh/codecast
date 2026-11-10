// The Image slash command asks for its URL in a small form at the cursor. A
// native prompt() is not an option: the desktop shell does not implement it,
// so there the command did nothing.
import { ReactRenderer } from "@tiptap/react";
import tippy from "tippy.js";
import { ImageUrlForm } from "../../components/editor/ImageUrlPrompt";

/** Ask for an image URL at the editor's cursor and insert the image there. */
export function askImageUrl(editor: any): void {
  const at = editor.state.selection.from;
  let closed = false;
  const close = (refocus: boolean) => {
    if (closed) return;
    closed = true;
    popup.destroy();
    component.destroy();
    if (refocus) editor.commands.focus();
  };
  const component = new ReactRenderer(ImageUrlForm, {
    editor,
    props: {
      onSubmit: (src: string) => {
        close(false);
        editor.chain().focus().setImage({ src }).run();
      },
      onCancel: () => close(true),
    },
  });
  const [popup] = tippy("body", {
    getReferenceClientRect: () => {
      const c = editor.view.coordsAtPos(at);
      return new DOMRect(c.left, c.top, 0, c.bottom - c.top);
    },
    appendTo: () => document.body,
    content: component.element,
    showOnCreate: true,
    interactive: true,
    trigger: "manual",
    placement: "bottom-start",
    zIndex: 10002,
    onClickOutside: () => close(false),
  });
}

import { useRef, useImperativeHandle, forwardRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { BubbleToolbar } from "./BubbleToolbar";
import { createBaseExtensions, createMentionExtension, type MentionQueryFn } from "./editorExtensions";
import "./editor.css";

export interface ComposeEditorHandle {
  getMarkdown: () => string;
  focus: () => void;
  clear: () => void;
}

interface ComposeEditorProps {
  initialContent: string;
  onMentionQuery: MentionQueryFn;
  onImagePaste?: (file: File) => void;
  onSubmit: () => void;
  onExit: () => void;
  onContentChange?: (hasContent: boolean) => void;
  placeholder?: string;
}

export const ComposeEditor = forwardRef<ComposeEditorHandle, ComposeEditorProps>(
  ({ initialContent, onMentionQuery, onImagePaste, onSubmit, onExit, onContentChange, placeholder }, ref) => {
    const onSubmitRef = useRef(onSubmit);
    onSubmitRef.current = onSubmit;
    const onExitRef = useRef(onExit);
    onExitRef.current = onExit;
    const onImagePasteRef = useRef(onImagePaste);
    onImagePasteRef.current = onImagePaste;
    const onContentChangeRef = useRef(onContentChange);
    onContentChangeRef.current = onContentChange;

    const ComposeKeymap = useRef(
      Extension.create({
        name: "composeKeymap",
        addKeyboardShortcuts() {
          return {
            "Mod-Enter": () => {
              onSubmitRef.current();
              return true;
            },
            "Mod-Shift-e": () => {
              onExitRef.current();
              return true;
            },
          };
        },
      })
    ).current;

    const extensions = [
      ...createBaseExtensions({
        placeholder: placeholder || "Compose your message... / for commands, @ to mention",
        withTables: false,
      }),
      ...(onMentionQuery ? [createMentionExtension(onMentionQuery)] : []),
      ComposeKeymap,
    ];

    const editor = useEditor({
      extensions,
      content: initialContent,
      editable: true,
      autofocus: "end",
      editorProps: {
        attributes: {
          class: "doc-editor-content focus:outline-none",
        },
        handlePaste: (_view, event) => {
          const items = event.clipboardData?.items;
          if (!items || !onImagePasteRef.current) return false;
          for (const item of Array.from(items)) {
            if (item.type.startsWith("image/")) {
              const file = item.getAsFile();
              if (!file) continue;
              event.preventDefault();
              onImagePasteRef.current(file);
              return true;
            }
          }
          return false;
        },
        handleDrop: (_view, event) => {
          const files = event.dataTransfer?.files;
          if (!files?.length || !onImagePasteRef.current) return false;
          const imageFiles = Array.from(files).filter(f => f.type.startsWith("image/"));
          if (!imageFiles.length) return false;
          event.preventDefault();
          imageFiles.forEach(f => onImagePasteRef.current!(f));
          return true;
        },
      },
      onUpdate: ({ editor: e }) => {
        const md = (e.storage as any).markdown?.getMarkdown() ?? e.getText();
        onContentChangeRef.current?.(md.trim().length > 0);
      },
    });

    useImperativeHandle(ref, () => ({
      getMarkdown: () => {
        if (!editor) return "";
        return (editor.storage as any).markdown?.getMarkdown() ?? editor.getText();
      },
      focus: () => editor?.commands.focus("end"),
      clear: () => editor?.commands.clearContent(),
    }));

    if (!editor) return null;

    return (
      <div className="compose-editor doc-editor">
        <BubbleToolbar editor={editor} />
        <EditorContent editor={editor} />
      </div>
    );
  }
);

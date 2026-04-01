import { useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleToolbar } from "./BubbleToolbar";
import { useMountEffect } from "../../hooks/useMountEffect";
import { createBaseExtensions, createMentionExtension, type MentionQueryFn } from "./editorExtensions";
import { uploadImageWithPlaceholder } from "./ImageUploadPlugin";
import "./editor.css";

interface DocEditorProps {
  content: string;
  onUpdate: (markdown: string) => void;
  onMentionQuery: MentionQueryFn;
  onImageUpload?: (file: File) => Promise<string | null>;
  editable?: boolean;
  className?: string;
  placeholder?: string;
}

export function DocEditor({
  content,
  onUpdate,
  onMentionQuery,
  onImageUpload,
  editable = true,
  className = "",
  placeholder = "Start writing, use / for commands, @ to mention, # for dates...",
}: DocEditorProps) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);
  const onImageUploadRef = useRef(onImageUpload);
  onImageUploadRef.current = onImageUpload;

  const debouncedSave = useCallback(
    (md: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        if (md !== lastSavedRef.current) {
          lastSavedRef.current = md;
          onUpdate(md);
        }
      }, 500);
    },
    [onUpdate]
  );

  const extensions = [
    ...createBaseExtensions({ placeholder }),
    ...(onMentionQuery ? [createMentionExtension(onMentionQuery)] : []),
  ];

  const editor = useEditor({
    extensions,
    content,
    editable,
    editorProps: {
      attributes: {
        class: "doc-editor-content focus:outline-none",
      },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (!items || !onImageUploadRef.current) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (!file) continue;
            event.preventDefault();
            uploadImageWithPlaceholder(view, file, view.state.selection.from, onImageUploadRef.current);
            return true;
          }
        }
        return false;
      },
      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (!files?.length || !onImageUploadRef.current) return false;
        const imageFiles = Array.from(files).filter(f => f.type.startsWith("image/"));
        if (!imageFiles.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        for (const file of imageFiles) {
          uploadImageWithPlaceholder(view, file, pos, onImageUploadRef.current);
        }
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const md = (e.storage as any).markdown?.getMarkdown() ?? e.getHTML();
      debouncedSave(md);
    },
  });

  useMountEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  });

  if (!editor) return null;

  return (
    <div className={`doc-editor ${className}`}>
      {editable && <BubbleToolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

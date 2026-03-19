import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link,
  Underline,
  Highlighter,
} from "lucide-react";
import { useState, useCallback } from "react";

interface BubbleToolbarProps {
  editor: Editor;
}

function ToolbarButton({
  onClick,
  isActive,
  children,
  title,
}: {
  onClick: () => void;
  isActive: boolean;
  children: React.ReactNode;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded transition-colors ${
        isActive
          ? "bg-sol-cyan/20 text-sol-cyan"
          : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight"
      }`}
    >
      {children}
    </button>
  );
}

export function BubbleToolbar({ editor }: BubbleToolbarProps) {
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const setLink = useCallback(() => {
    if (linkUrl) {
      (editor.chain().focus().extendMarkRange("link") as any)
        .setLink({ href: linkUrl })
        .run();
    }
    setShowLinkInput(false);
    setLinkUrl("");
  }, [editor, linkUrl]);

  const handleLinkClick = useCallback(() => {
    if (editor.isActive("link")) {
      (editor.chain().focus() as any).unsetLink().run();
      return;
    }
    const existingHref = editor.getAttributes("link").href;
    setLinkUrl(existingHref || "");
    setShowLinkInput(true);
  }, [editor]);

  return (
    <BubbleMenu
      editor={editor}
      className="bg-sol-bg border border-sol-border/60 rounded-lg shadow-xl flex items-center gap-0.5 p-1"
    >
      {showLinkInput ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setLink();
          }}
          className="flex items-center gap-1.5 px-1"
        >
          <input
            type="url"
            placeholder="https://..."
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            className="text-xs bg-sol-bg-alt border border-sol-border/50 rounded px-2 py-1 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan w-48"
            autoFocus
          />
          <button
            type="submit"
            className="text-xs text-sol-cyan hover:text-sol-text px-2 py-1 rounded hover:bg-sol-bg-highlight"
          >
            Set
          </button>
          <button
            type="button"
            onClick={() => setShowLinkInput(false)}
            className="text-xs text-sol-text-dim hover:text-sol-text px-1"
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <ToolbarButton
            onClick={() => (editor.chain().focus() as any).toggleBold().run()}
            isActive={editor.isActive("bold")}
            title="Bold (Cmd+B)"
          >
            <Bold className="w-3.5 h-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => (editor.chain().focus() as any).toggleItalic().run()}
            isActive={editor.isActive("italic")}
            title="Italic (Cmd+I)"
          >
            <Italic className="w-3.5 h-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => (editor.chain().focus() as any).toggleUnderline().run()}
            isActive={editor.isActive("underline")}
            title="Underline (Cmd+U)"
          >
            <Underline className="w-3.5 h-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => (editor.chain().focus() as any).toggleStrike().run()}
            isActive={editor.isActive("strike")}
            title="Strikethrough"
          >
            <Strikethrough className="w-3.5 h-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => (editor.chain().focus() as any).toggleCode().run()}
            isActive={editor.isActive("code")}
            title="Inline Code (Cmd+E)"
          >
            <Code className="w-3.5 h-3.5" />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => (editor.chain().focus() as any).toggleHighlight().run()}
            isActive={editor.isActive("highlight")}
            title="Highlight"
          >
            <Highlighter className="w-3.5 h-3.5" />
          </ToolbarButton>
          <div className="w-px h-5 bg-sol-border/40 mx-0.5" />
          <ToolbarButton
            onClick={handleLinkClick}
            isActive={editor.isActive("link")}
            title="Link (Cmd+K)"
          >
            <Link className="w-3.5 h-3.5" />
          </ToolbarButton>
        </>
      )}
    </BubbleMenu>
  );
}

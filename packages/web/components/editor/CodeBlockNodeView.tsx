import { useState } from "react";
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from "@tiptap/react";
import { Copy, Check } from "lucide-react";
import { copyToClipboard } from "../../lib/utils";

// The editor's code block with the reading view's chrome: hover reveals the
// language and a copy button, so a block is copyable without leaving edit
// mode. The pre/code styling itself stays in editor.css (`.tiptap pre`), and
// lowlight's highlight decorations flow through NodeViewContent untouched.
export function CodeBlockNodeView({ node }: NodeViewProps) {
  const [copied, setCopied] = useState(false);
  const language: string | null = node.attrs.language || null;

  const handleCopy = () => {
    copyToClipboard(node.textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <NodeViewWrapper className="relative group">
      <div
        className="absolute right-1 top-1 z-10 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
        contentEditable={false}
      >
        {language && (
          <span className="text-[10px] font-mono text-sol-text-dim select-none">{language}</span>
        )}
        <button
          onClick={handleCopy}
          className="p-1 rounded text-sol-text-dim/60 hover:text-sol-text-secondary select-none"
          title="Copy code"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre>
        {/* The prop union is typed "div"-only in this tiptap version, but the
            runtime renders any tag — and a code block must be a <code>. */}
        <NodeViewContent as={"code" as unknown as "div"} />
      </pre>
    </NodeViewWrapper>
  );
}

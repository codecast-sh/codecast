import { useState, useMemo, useCallback, memo } from "react";
import { useFullWidthExpand } from "../hooks/useFullWidthExpand";
import { toast } from "sonner";
import { copyToClipboard } from "../lib/utils";
import { Copy, Check, MoveHorizontal, WrapText } from "lucide-react";
import { highlightCode } from "../lib/codeLanguage";

interface CodeBlockProps {
  code: string;
  language?: string;
}

const wrappedBlocks = new Set<string>();

function codeKey(code: string): string {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = ((h << 5) - h + code.charCodeAt(i)) | 0;
  return String(h);
}

export const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  const key = useMemo(() => codeKey(code), [code]);
  const { expanded, toggle: toggleExpand, containerRef, style: expandStyle } = useFullWidthExpand(key);
  const [wrapped, setWrapped] = useState(wrappedBlocks.has(key));
  const [copied, setCopied] = useState(false);

  const toggleWrap = useCallback(() => {
    const next = !wrapped;
    setWrapped(next);
    if (next) wrappedBlocks.add(key);
    else wrappedBlocks.delete(key);
  }, [wrapped, key]);

  const handleCopy = async () => {
    try {
      await copyToClipboard(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  return (
    <div
      ref={containerRef}
      className="code-block-resizable relative group my-2 transition-all duration-200"
      style={expandStyle}
    >
      <div className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center gap-1.5 pl-8 pr-2 pt-1.5 pb-1.5 bg-gradient-to-r from-transparent to-[var(--sol-bg)] via-[var(--sol-bg)]">
        <button
          onClick={toggleWrap}
          className={`p-1 rounded select-none ${wrapped ? "text-sol-cyan" : "text-sol-text-dim/60 hover:text-sol-text-secondary"}`}
          title={wrapped ? "Disable line wrap" : "Wrap lines"}
        >
          <WrapText size={14} />
        </button>
        <button
          onClick={toggleExpand}
          className={`p-1 rounded select-none ${expanded ? "text-sol-cyan" : "text-sol-text-dim/60 hover:text-sol-text-secondary"}`}
          title={expanded ? "Collapse" : "Expand to full width"}
        >
          <MoveHorizontal size={14} />
        </button>
        <button
          onClick={handleCopy}
          className="p-1 text-sol-text-dim/60 hover:text-sol-text-secondary rounded select-none"
          title="Copy code"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre
        className={`!m-0 !py-2 !pl-4 !pr-8 !border-0 text-sm code-block-accent ${wrapped ? "" : "cb-hscroll"}`}
        style={wrapped ? { whiteSpace: "pre-wrap", wordBreak: "break-word" } : undefined}
      >
        {highlighted ? (
          <code className="font-mono text-sol-text-secondary" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code className="font-mono text-sol-text-secondary">{code}</code>
        )}
      </pre>
    </div>
  );
});

export interface ParsedBlock {
  type: "text" | "code";
  content: string;
  language?: string;
}

export function parseCodeBlocks(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({
        type: "text",
        content: content.slice(lastIndex, match.index),
      });
    }
    blocks.push({
      type: "code",
      content: match[2].trimEnd(),
      language: match[1] || undefined,
    });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    blocks.push({
      type: "text",
      content: content.slice(lastIndex),
    });
  }

  return blocks;
}

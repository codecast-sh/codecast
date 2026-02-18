"use client";
import { toast } from "sonner";
import { copyToClipboard } from "../lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const handleCopy = async () => {
    try {
      await copyToClipboard(code);
      toast.success("Copied!");
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  return (
    <div className="relative group my-2 rounded-md overflow-hidden border border-sol-border/30 bg-sol-bg-alt">
      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <button
          onClick={handleCopy}
          className="px-2 py-1 text-xs bg-sol-bg-highlight text-sol-text-secondary rounded hover:bg-sol-border/50"
          title="Copy code"
        >
          Copy
        </button>
      </div>
      {language && (
        <div className="text-xs px-3 py-1 text-sol-text-dim bg-sol-bg-highlight/50 border-b border-sol-border/20">
          {language}{code.split('\n').length > 1 ? ` \u00b7 ${code.split('\n').length} lines` : ''}
        </div>
      )}
      <pre className="!m-0 !p-3 !border-0 overflow-x-auto scrollbar-auto text-sm bg-sol-bg-alt">
        <code className="font-mono text-sol-text-secondary">{code}</code>
      </pre>
    </div>
  );
}

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

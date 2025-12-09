"use client";
import { toast } from "sonner";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Copied!");
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  return (
    <div className="relative group my-3">
      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <button
          onClick={handleCopy}
          className="px-2 py-1 text-xs bg-slate-600 text-sol-base2 rounded hover:bg-slate-500"
          title="Copy code"
        >
          Copy
        </button>
      </div>
      {language && (
        <div className="text-xs text-sol-base0 bg-sol-base02 px-3 py-1 rounded-t border-b border-sol-base01">
          {language}
        </div>
      )}
      <pre className={`bg-sol-base02 p-4 overflow-x-auto text-sm ${language ? "rounded-b" : "rounded"}`}>
        <code className="text-sol-base2 font-mono">{code}</code>
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

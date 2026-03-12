"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { copyToClipboard } from "../lib/utils";
import { Copy, Check, ChevronsRight, ChevronsLeft } from "lucide-react";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-css";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-go";
import "prismjs/components/prism-swift";

interface CodeBlockProps {
  code: string;
  language?: string;
}

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", sh: "bash", shell: "bash", zsh: "bash",
  yml: "yaml", md: "markdown", html: "markup", xml: "markup",
};

function highlightCode(code: string, language?: string): string | null {
  if (!language) return null;
  const lang = LANG_ALIASES[language] || language;
  const grammar = Prism.languages[lang];
  if (!grammar) return null;
  try {
    return Prism.highlight(code, grammar, lang);
  } catch {
    return null;
  }
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [expandWidth, setExpandWidth] = useState(0);

  useEffect(() => {
    if (!expanded) { setExpandWidth(0); return; }
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setExpandWidth(Math.max(0, window.innerWidth - rect.right - 24));
  }, [expanded]);

  const [copied, setCopied] = useState(false);

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
      className="code-block-resizable relative group my-2 transition-[width] duration-200"
      style={expanded ? { width: `calc(100% + ${expandWidth}px)` } : undefined}
    >
      <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex gap-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className="p-1 text-sol-text-dim hover:text-sol-text-secondary select-none"
          title={expanded ? "Collapse" : "Expand to full width"}
        >
          {expanded ? <ChevronsLeft size={13} /> : <ChevronsRight size={13} />}
        </button>
        <button
          onClick={handleCopy}
          className="p-1 text-sol-text-dim hover:text-sol-text-secondary select-none"
          title="Copy code"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre className="!m-0 !py-2 !pl-4 !pr-3 !border-0 cb-hscroll text-sm code-block-accent">
        {highlighted ? (
          <code className="font-mono text-sol-text-secondary" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code className="font-mono text-sol-text-secondary">{code}</code>
        )}
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

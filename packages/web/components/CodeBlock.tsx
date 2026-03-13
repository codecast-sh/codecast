"use client";
import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { copyToClipboard } from "../lib/utils";
import { Copy, Check, MoveHorizontal } from "lucide-react";
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

const expandedBlocks = new Map<string, { left: number; width: number }>();

function codeKey(code: string): string {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = ((h << 5) - h + code.charCodeAt(i)) | 0;
  return String(h);
}

function measureExpand(el: HTMLElement, currentLeftOffset = 0): { left: number; width: number } | null {
  const scrollParent = el.closest('.overflow-y-auto') as HTMLElement | null;
  if (!scrollParent) return null;
  const scrollRect = scrollParent.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const naturalLeft = elRect.left - currentLeftOffset;
  const leftOffset = naturalLeft - scrollRect.left - 16;
  const targetWidth = scrollRect.width - 32;
  return { left: -leftOffset, width: targetWidth };
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  const key = useMemo(() => codeKey(code), [code]);
  const stored = expandedBlocks.get(key);
  const [expanded, setExpanded] = useState(!!stored);
  const [geo, setGeo] = useState<{ left: number; width: number } | null>(stored || null);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !expanded) return;
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      const fresh = measureExpand(el, geo?.left || 0);
      if (!fresh) return;
      if (geo?.left !== fresh.left || geo?.width !== fresh.width) {
        expandedBlocks.set(key, fresh);
        setGeo(fresh);
      }
    });
  }, [expanded, key]);

  const toggleExpand = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      const el = containerRef.current;
      if (el) {
        const fresh = measureExpand(el);
        if (fresh) {
          expandedBlocks.set(key, fresh);
          setGeo(fresh);
        }
      }
    } else {
      expandedBlocks.delete(key);
      setGeo(null);
    }
  }, [expanded, key]);

  const handleCopy = async () => {
    try {
      await copyToClipboard(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  const expandStyle: React.CSSProperties = geo
    ? { position: 'relative', left: geo.left, width: geo.width }
    : {};

  return (
    <div
      ref={containerRef}
      className="code-block-resizable relative group my-2 transition-all duration-200"
      style={expandStyle}
    >
      <div className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center gap-1.5 pl-8 pr-2 pt-1.5 pb-1.5 bg-gradient-to-r from-transparent to-[var(--sol-bg)] via-[var(--sol-bg)]">
        <button
          onClick={toggleExpand}
          className="p-1 text-sol-text-dim/60 hover:text-sol-text-secondary rounded select-none"
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
      <pre className="!m-0 !py-2 !pl-4 !pr-8 !border-0 cb-hscroll text-sm code-block-accent">
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

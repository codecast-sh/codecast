"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { copyToClipboard } from "../lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [extraWidth, setExtraWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [maxExpand, setMaxExpand] = useState(600);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rightSpace = window.innerWidth - rect.right - 24;
    setMaxExpand(Math.max(0, rightSpace));
  }, []);

  const handleCopy = async () => {
    try {
      await copyToClipboard(code);
      toast.success("Copied!");
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = extraWidth;

    const el = containerRef.current;
    const currentMax = el
      ? Math.max(0, window.innerWidth - el.getBoundingClientRect().left - el.offsetWidth - 24)
      : maxExpand;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - dragStartX.current;
      setExtraWidth(Math.max(0, Math.min(currentMax + dragStartWidth.current, dragStartWidth.current + delta)));
    };
    const onUp = () => {
      setIsDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [extraWidth, maxExpand]);

  const isExpanded = extraWidth > 0;

  return (
    <div
      ref={containerRef}
      className={`code-block-resizable relative group my-2 rounded-md border border-sol-border/30 bg-sol-bg-alt ${isDragging ? "select-none" : ""}`}
      style={isExpanded ? { width: `calc(100% + ${extraWidth}px)` } : undefined}
    >
      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex gap-1">
        {isExpanded && (
          <button
            onClick={() => setExtraWidth(0)}
            className="px-2 py-1 text-xs bg-sol-bg-highlight text-sol-text-secondary rounded hover:bg-sol-border/50"
            title="Reset width"
          >
            Reset
          </button>
        )}
        <button
          onClick={handleCopy}
          className="px-2 py-1 text-xs bg-sol-bg-highlight text-sol-text-secondary rounded hover:bg-sol-border/50"
          title="Copy code"
        >
          Copy
        </button>
      </div>
      {language && (
        <div className="text-xs px-3 py-1 text-sol-text-dim bg-sol-bg-highlight/50 border-b border-sol-border/20 rounded-t-md">
          {language}{code.split('\n').length > 1 ? ` \u00b7 ${code.split('\n').length} lines` : ''}
        </div>
      )}
      <pre className="!m-0 !p-3 !border-0 cb-hscroll text-sm bg-sol-bg-alt rounded-b-md">
        <code className="font-mono text-sol-text-secondary">{code}</code>
      </pre>
      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className="absolute top-0 -right-1 w-4 h-full cursor-col-resize opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center justify-center"
        title="Drag to expand"
      >
        <div className="w-1.5 rounded-full bg-sol-base01/50 hover:bg-amber-500 transition-colors" style={{ height: 'min(80%, calc(100% - 16px))' }} />
      </div>
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

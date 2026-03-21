"use client";
import { useState } from "react";
import { CollabDocEditor } from "./editor/CollabDocEditor";
import { useMentionQuery } from "../hooks/useMentionQuery";
import { ErrorBoundary } from "./ErrorBoundary";
import { ArrowLeft, Edit3, Eye, MoreHorizontal, Copy, Check } from "lucide-react";
import Link from "next/link";

interface DocumentDetailLayoutProps {
  docId: string;
  title: string;
  markdownContent: string;
  editable?: boolean;
  placeholder?: string;
  onTitleChange: (title: string) => void;
  backHref: string;
  topBarLeft?: React.ReactNode;
  topBarRight?: React.ReactNode;
  metaContent?: React.ReactNode;
  children?: React.ReactNode;
}

export function DocumentDetailLayout({
  docId,
  title,
  markdownContent,
  editable: initialEditable = true,
  placeholder = "Start writing, use / for commands, @ to mention...",
  onTitleChange,
  backHref,
  topBarLeft,
  topBarRight,
  metaContent,
  children,
}: DocumentDetailLayoutProps) {
  const [isEditing, setIsEditing] = useState(initialEditable);
  const [showMeta, setShowMeta] = useState(false);
  const [copied, setCopied] = useState(false);
  const handleMentionQuery = useMentionQuery();

  const handleCopyMarkdown = () => {
    const full = title ? `# ${title}\n\n${markdownContent}` : markdownContent;
    navigator.clipboard.writeText(full);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-2 border-b border-sol-border/10 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link
            href={backHref}
            className="text-sol-text-dim hover:text-sol-cyan transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          {topBarLeft}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopyMarkdown}
            className="p-1.5 rounded-md text-xs flex items-center gap-1 text-sol-text-dim hover:text-sol-text transition-colors"
            title="Copy as Markdown"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-sol-green" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => setIsEditing(!isEditing)}
            className={`p-1.5 rounded-md text-xs flex items-center gap-1 transition-colors ${
              isEditing
                ? "text-sol-cyan"
                : "text-sol-text-dim hover:text-sol-text"
            }`}
            title={isEditing ? "Switch to view mode" : "Switch to edit mode"}
          >
            {isEditing ? <Edit3 className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
          {topBarRight}
          {metaContent && (
            <button
              onClick={() => setShowMeta(!showMeta)}
              className="p-1.5 rounded-md text-sol-text-dim hover:text-sol-text transition-colors"
              title="Info"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {showMeta && metaContent && (
        <div className="px-10 py-3 border-b border-sol-border/10 flex-shrink-0 max-w-5xl mx-auto w-full">
          {metaContent}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-10 pt-10 pb-32">
          <h1
            contentEditable={isEditing}
            suppressContentEditableWarning
            onBlur={(e) => {
              const text = e.currentTarget.textContent || "";
              if (text !== title) onTitleChange(text);
            }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLElement).blur(); } }}
            className={`text-3xl font-bold text-sol-text leading-tight mb-1 break-words ${isEditing ? "outline-none cursor-text" : ""}`}
          >
            {title || "Untitled"}
          </h1>

          <div className="mt-4">
            <ErrorBoundary name="DocEditor" level="panel">
              <CollabDocEditor
                key={docId}
                docId={docId}
                markdownContent={markdownContent}
                onMentionQuery={handleMentionQuery}
                editable={isEditing}
                placeholder={placeholder}
              />
            </ErrorBoundary>
          </div>

          {children && (
            <div className="mt-16 pt-8 border-t border-sol-border/15">
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

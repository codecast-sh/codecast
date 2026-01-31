"use client";
import { useState } from "react";
import type { ToolViewProps } from "@/lib/toolRegistry";
import { MarkdownRenderer, isMarkdownFile, isPlanFile } from "./MarkdownRenderer";

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'tsx',
    'js': 'javascript',
    'jsx': 'jsx',
    'py': 'python',
    'json': 'json',
    'css': 'css',
    'md': 'markdown',
  };
  return langMap[ext] || 'javascript';
}

function HighlightedCode({ code, language: _language }: { code: string; language: string }) {
  return (
    <pre className="text-xs font-mono overflow-x-auto p-2 m-0">
      <code>{code}</code>
    </pre>
  );
}

function DiffView({ oldStr, newStr, filePath }: { oldStr: string; newStr: string; filePath: string }) {
  const [expanded, setExpanded] = useState(false);
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const totalLines = Math.max(oldLines.length, newLines.length);
  const COLLAPSE_THRESHOLD = 10;
  const shouldCollapse = totalLines > COLLAPSE_THRESHOLD;
  const language = detectLanguage(filePath);

  const displayOldStr = shouldCollapse && !expanded
    ? oldLines.slice(0, COLLAPSE_THRESHOLD).join('\n')
    : oldStr;

  const displayNewStr = shouldCollapse && !expanded
    ? newLines.slice(0, COLLAPSE_THRESHOLD).join('\n')
    : newStr;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-xs text-red-500 mb-1 font-semibold">- Removed</div>
          <div className="bg-red-500/10 border border-red-500/20 rounded overflow-hidden">
            <div className="overflow-x-auto">
              <HighlightedCode code={displayOldStr} language={language} />
            </div>
          </div>
        </div>
        <div>
          <div className="text-xs text-emerald-500 mb-1 font-semibold">+ Added</div>
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded overflow-hidden">
            <div className="overflow-x-auto">
              <HighlightedCode code={displayNewStr} language={language} />
            </div>
          </div>
        </div>
      </div>
      {shouldCollapse && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
        >
          {expanded ? "Show less" : `Show all ${totalLines} lines`}
        </button>
      )}
    </div>
  );
}

export function EditToolView({ input, output }: ToolViewProps) {
  const filePath = input?.file_path || '';
  const fileName = filePath.split('/').pop() || 'file';
  const language = detectLanguage(filePath);
  const content = input?.content || '';

  const isMarkdown = isMarkdownFile(filePath);
  const isPlan = isMarkdown && isPlanFile(filePath, content);
  const [viewMode, setViewMode] = useState<'raw' | 'rendered'>(isPlan ? 'rendered' : 'raw');

  if (input?.old_string && input?.new_string) {
    return (
      <div className="p-4 space-y-3">
        <div className="text-sm text-muted-foreground">
          <span className="font-semibold">File:</span> {fileName}
        </div>
        <DiffView oldStr={input.old_string} newStr={input.new_string} filePath={filePath} />
      </div>
    );
  }

  if (content) {
    const contentLines = content.split('\n');
    const lineCount = contentLines.length;

    return (
      <div className="p-4 space-y-3">
        <div className="text-sm text-muted-foreground flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold">File:</span> {fileName} ({lineCount} lines)
            {isPlan && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-sol-bg-highlight text-sol-text-muted font-medium">
                PLAN
              </span>
            )}
          </div>
          {isMarkdown && (
            <div className="flex items-center gap-1 text-xs">
              <button
                onClick={() => setViewMode('raw')}
                className={`px-2 py-0.5 rounded transition-colors ${
                  viewMode === 'raw'
                    ? 'bg-sol-bg-highlight text-sol-text'
                    : 'text-sol-text-dim hover:text-sol-text-muted'
                }`}
              >
                Raw
              </button>
              <button
                onClick={() => setViewMode('rendered')}
                className={`px-2 py-0.5 rounded transition-colors ${
                  viewMode === 'rendered'
                    ? 'bg-sol-bg-highlight text-sol-text'
                    : 'text-sol-text-dim hover:text-sol-text-muted'
                }`}
              >
                Rendered
              </button>
            </div>
          )}
        </div>
        <div className="text-xs text-emerald-500 mb-1 font-semibold">+ Created</div>

        {viewMode === 'rendered' && isMarkdown ? (
          <div className="rounded border overflow-hidden p-4 bg-emerald-500/10 border-emerald-500/20">
            <MarkdownRenderer content={content} filePath={filePath} />
          </div>
        ) : (
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded overflow-hidden max-h-64">
            <div className="overflow-auto">
              <HighlightedCode code={content} language={language} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 text-sm text-muted-foreground">
      {output ? String(output) : 'File modified'}
    </div>
  );
}

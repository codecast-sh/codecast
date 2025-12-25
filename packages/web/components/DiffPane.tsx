"use client";

import { useMemo } from 'react';
import { parseDiff, Diff, Hunk, tokenize } from 'react-diff-view';
import { createTwoFilesPatch } from 'diff';
import * as Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-markdown';
import 'react-diff-view/style/index.css';

interface DiffPaneProps {
  filePath: string;
  oldContent?: string;
  newContent: string;
}

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

function computeChangeStats(oldContent: string | undefined, newContent: string): { additions: number; deletions: number } {
  if (!oldContent) {
    const lines = newContent.split('\n').length;
    return { additions: lines, deletions: 0 };
  }

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  let additions = 0;
  let deletions = 0;

  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === undefined) {
      additions++;
    } else if (newLine === undefined) {
      deletions++;
    } else if (oldLine !== newLine) {
      additions++;
      deletions++;
    }
  }

  return { additions, deletions };
}

export function DiffPane({ filePath, oldContent, newContent }: DiffPaneProps) {
  const language = detectLanguage(filePath);
  const stats = useMemo(() => computeChangeStats(oldContent, newContent), [oldContent, newContent]);

  const diffText = useMemo(() => {
    const oldFile = oldContent || '';
    return createTwoFilesPatch(
      filePath,
      filePath,
      oldFile,
      newContent,
      '',
      '',
      { context: 3 }
    );
  }, [oldContent, newContent, filePath]);

  const files = useMemo(() => {
    try {
      return parseDiff(diffText);
    } catch (error) {
      console.error('Failed to parse diff:', error);
      return [];
    }
  }, [diffText]);

  const tokens = useMemo(() => {
    if (files.length === 0) return undefined;

    const file = files[0];
    const options = {
      highlight: true,
      language,
      refractor: Prism,
    };

    try {
      return tokenize(file.hunks, options);
    } catch (error) {
      console.error('Failed to tokenize:', error);
      return undefined;
    }
  }, [files, language]);

  if (files.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No changes to display
      </div>
    );
  }

  const file = files[0];

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border p-4 bg-muted/50">
        <div className="flex items-center justify-between">
          <div className="font-mono text-sm font-semibold">{filePath}</div>
          <div className="flex items-center gap-4 text-xs">
            {stats.additions > 0 && (
              <span className="text-emerald-500 font-semibold">+{stats.additions}</span>
            )}
            {stats.deletions > 0 && (
              <span className="text-red-500 font-semibold">-{stats.deletions}</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-background">
        <Diff
          viewType="unified"
          diffType={file.type}
          hunks={file.hunks}
          tokens={tokens}
        >
          {(displayHunks) => displayHunks.map((hunk) => (
            <Hunk key={hunk.content} hunk={hunk} />
          ))}
        </Diff>
      </div>
    </div>
  );
}

"use client";
import { useState } from "react";

type CommitCardProps = {
  sha: string;
  message: string;
  timestamp: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  authorName: string;
  authorEmail: string;
};

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatFullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function GitIcon() {
  return (
    <div className="w-5 h-5 rounded bg-sol-bg-alt border border-sol-border flex items-center justify-center shrink-0">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-sol-text-muted">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
      </svg>
    </div>
  );
}

export function CommitCard({ sha, message, timestamp, filesChanged, insertions, deletions, authorName, authorEmail }: CommitCardProps) {
  const [expanded, setExpanded] = useState(false);
  const shortSha = sha.slice(0, 7);
  const commitMessage = message.split('\n')[0];

  return (
    <div
      className="my-2 rounded-lg bg-sol-bg-alt/40 border border-sol-border/50 overflow-hidden cursor-pointer hover:border-sol-border transition-colors"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="px-3 py-2 flex items-center gap-2">
        <GitIcon />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-sol-cyan">
              {shortSha}
            </span>
            <span className="text-xs text-sol-text-secondary truncate">
              {commitMessage}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-sol-text-dim">
            <span>{authorName}</span>
            <span>•</span>
            <a
              href={`#commit-${sha}`}
              className="hover:text-sol-text-muted transition-colors"
              title={formatFullTimestamp(timestamp)}
              onClick={(e) => e.stopPropagation()}
            >
              {formatRelativeTime(timestamp)}
            </a>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono flex-shrink-0">
          <span className="text-sol-text-dim">
            {filesChanged} file{filesChanged !== 1 ? 's' : ''}
          </span>
          {(insertions > 0 || deletions > 0) && (
            <>
              <span className="text-sol-green">+{insertions}</span>
              <span className="text-sol-red">-{deletions}</span>
            </>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-sol-text-dim transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {expanded && (
        <div className="border-t border-sol-border/50 px-3 py-2 bg-sol-bg/30">
          <div className="text-xs text-sol-text-muted whitespace-pre-wrap font-mono">
            {message}
          </div>
          {(insertions > 0 || deletions > 0) && (
            <div className="mt-2 flex items-center gap-3 text-[10px]">
              <span className="text-sol-text-dim">Changes:</span>
              <span className="text-sol-green">+{insertions} insertion{insertions !== 1 ? 's' : ''}</span>
              <span className="text-sol-red">-{deletions} deletion{deletions !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

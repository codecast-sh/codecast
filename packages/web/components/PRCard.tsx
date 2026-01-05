"use client";
import { useState } from "react";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

type PRFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

type PRCardProps = {
  _id: Id<"pull_requests">;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  repository: string;
  author_github_username: string;
  head_ref?: string;
  base_ref?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits_count?: number;
  files?: PRFile[];
  created_at: number;
  updated_at: number;
  merged_at?: number;
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

function PRIcon() {
  return (
    <div className="w-5 h-5 rounded bg-sol-bg-alt border border-sol-border flex items-center justify-center shrink-0">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-sol-text-muted">
        <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/>
      </svg>
    </div>
  );
}

function StateIcon({ state }: { state: "open" | "closed" | "merged" }) {
  if (state === "merged") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-sol-violet">
        <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/>
      </svg>
    );
  }
  if (state === "closed") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-sol-red">
        <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.28a.75.75 0 0 1 1.06 0l2.5 2.5a.75.75 0 0 1-1.06 1.06L12 3.56 10.78 4.78a.75.75 0 0 1-1.06-1.06l2.5-2.5ZM3.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" className="text-sol-green">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>
    </svg>
  );
}

function FileDiffView({ file }: { file: PRFile }) {
  const [expanded, setExpanded] = useState(false);
  const lines = file.patch?.split("\n") || [];
  const previewLines = lines.slice(0, 10);
  const hasMore = lines.length > 10;

  return (
    <div className="border-t border-sol-border/30">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center justify-between hover:bg-sol-bg-alt/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
            file.status === "added" ? "bg-sol-green/20 text-sol-green" :
            file.status === "removed" ? "bg-sol-red/20 text-sol-red" :
            file.status === "renamed" ? "bg-sol-yellow/20 text-sol-yellow" :
            "bg-sol-blue/20 text-sol-blue"
          }`}>
            {file.status}
          </span>
          <span className="font-mono text-xs text-sol-text-secondary truncate">
            {file.filename}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono flex-shrink-0">
          {file.additions > 0 && <span className="text-sol-green">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-sol-red">-{file.deletions}</span>}
          <svg
            className={`w-3 h-3 text-sol-text-dim transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {expanded && file.patch && (
        <div className="bg-sol-bg/50 px-3 py-2 overflow-x-auto">
          <pre className="font-mono text-[11px] leading-relaxed">
            {(hasMore && !expanded ? previewLines : lines).map((line, idx) => {
              let lineClass = "text-sol-text-muted";
              let prefix = " ";
              if (line.startsWith("+") && !line.startsWith("+++")) {
                lineClass = "text-sol-green bg-sol-green/10";
                prefix = "+";
              } else if (line.startsWith("-") && !line.startsWith("---")) {
                lineClass = "text-sol-red bg-sol-red/10";
                prefix = "-";
              } else if (line.startsWith("@@")) {
                lineClass = "text-sol-cyan";
              } else if (line.startsWith("diff") || line.startsWith("index") || line.startsWith("---") || line.startsWith("+++")) {
                lineClass = "text-sol-text-dim";
              }
              return (
                <div key={idx} className={`${lineClass} whitespace-pre`}>
                  {line}
                </div>
              );
            })}
          </pre>
          {hasMore && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="text-[10px] text-sol-cyan hover:underline mt-1"
            >
              Show {lines.length - 10} more lines...
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function PRCard(props: PRCardProps) {
  const [expanded, setExpanded] = useState(false);
  const githubUrl = `https://github.com/${props.repository}/pull/${props.number}`;

  const stateLabel = props.state === "merged" ? "Merged" : props.state === "closed" ? "Closed" : "Open";
  const stateColor = props.state === "merged" ? "text-sol-violet" : props.state === "closed" ? "text-sol-red" : "text-sol-green";

  return (
    <div className="my-2 rounded-lg bg-sol-bg-alt/40 border border-sol-border/50 overflow-hidden">
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-sol-bg-alt/60 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <PRIcon />
        <StateIcon state={props.state} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-sol-cyan hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              #{props.number}
            </a>
            <span className="text-xs text-sol-text-secondary truncate">
              {props.title}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-sol-text-dim">
            <span className={stateColor}>{stateLabel}</span>
            <span>•</span>
            <span>{props.author_github_username}</span>
            {props.head_ref && (
              <>
                <span>•</span>
                <span className="text-sol-green">{props.head_ref}</span>
                {props.base_ref && (
                  <>
                    <span className="text-sol-text-dim">→</span>
                    <span className="text-sol-blue">{props.base_ref}</span>
                  </>
                )}
              </>
            )}
            <span>•</span>
            <span>{formatRelativeTime(props.updated_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono flex-shrink-0">
          {props.changed_files !== undefined && (
            <span className="text-sol-text-dim">
              {props.changed_files} file{props.changed_files !== 1 ? 's' : ''}
            </span>
          )}
          {(props.additions !== undefined || props.deletions !== undefined) && (
            <>
              {props.additions !== undefined && props.additions > 0 && (
                <span className="text-sol-green">+{props.additions}</span>
              )}
              {props.deletions !== undefined && props.deletions > 0 && (
                <span className="text-sol-red">-{props.deletions}</span>
              )}
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
        <div className="border-t border-sol-border/50">
          {props.body && (
            <div className="px-3 py-2 bg-sol-bg/30 border-b border-sol-border/30">
              <div className="text-xs text-sol-text-muted whitespace-pre-wrap">
                {props.body}
              </div>
            </div>
          )}

          {props.files && props.files.length > 0 ? (
            <div className="divide-y divide-sol-border/30">
              <div className="px-3 py-1.5 bg-sol-bg/20 text-[10px] text-sol-text-dim font-medium">
                Changed files ({props.files.length})
              </div>
              {props.files.map((file, idx) => (
                <FileDiffView key={idx} file={file} />
              ))}
            </div>
          ) : (
            <div className="px-3 py-3 text-xs text-sol-text-dim text-center">
              No file changes synced yet
            </div>
          )}

          <div className="px-3 py-2 bg-sol-bg/20 flex items-center justify-between">
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-sol-cyan hover:underline flex items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
              View on GitHub
            </a>
            {props.commits_count !== undefined && (
              <span className="text-[10px] text-sol-text-dim">
                {props.commits_count} commit{props.commits_count !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

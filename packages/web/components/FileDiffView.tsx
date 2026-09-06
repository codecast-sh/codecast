import { useState } from "react";

// One changed file inside a pull request or a commit: the status chip, the
// path, the +/- counts, and the patch behind a click. PRCard, CommitCard and
// the shared-object card all show the same rows, so the row lives once here.

export type DiffFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

function patchLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-sol-green bg-sol-green/10";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-sol-red bg-sol-red/10";
  if (line.startsWith("@@")) return "text-sol-cyan";
  if (line.startsWith("diff") || line.startsWith("index") || line.startsWith("---") || line.startsWith("+++")) return "text-sol-text-dim";
  return "text-sol-text-muted";
}

const STATUS_CHIP: Record<string, string> = {
  added: "bg-sol-green/20 text-sol-green",
  removed: "bg-sol-red/20 text-sol-red",
  renamed: "bg-sol-yellow/20 text-sol-yellow",
};

export function FileDiffView({ file }: { file: DiffFile }) {
  const [expanded, setExpanded] = useState(false);
  const lines = file.patch?.split("\n") || [];

  return (
    <div className="border-t border-sol-border/30">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        className="w-full px-3 py-2 flex items-center justify-between hover:bg-sol-bg-alt/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_CHIP[file.status] ?? "bg-sol-blue/20 text-sol-blue"}`}>
            {file.status}
          </span>
          <span className="font-mono text-xs text-sol-text-secondary truncate">{file.filename}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono flex-shrink-0">
          {file.additions > 0 && <span className="text-sol-green">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-sol-red">-{file.deletions}</span>}
          <svg
            className={`w-3 h-3 text-sol-text-dim transition-transform ${expanded ? "rotate-180" : ""}`}
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
            {lines.map((line, idx) => (
              <div key={idx} className={`${patchLineClass(line)} whitespace-pre`}>
                {line}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

/** The changed-files section: a count header and one FileDiffView per file, or the empty note. */
export function FileDiffList({ files, emptyText, className = "" }: { files?: DiffFile[] | null; emptyText?: string; className?: string }) {
  if (!files || files.length === 0) {
    return emptyText ? <div className={`px-3 py-3 text-xs text-sol-text-dim text-center ${className}`}>{emptyText}</div> : null;
  }
  return (
    <div className={`divide-y divide-sol-border/30 ${className}`}>
      <div className="px-3 py-1.5 bg-sol-bg/20 text-[10px] text-sol-text-dim font-medium">Changed files ({files.length})</div>
      {files.map((file, idx) => (
        <FileDiffView key={idx} file={file} />
      ))}
    </div>
  );
}

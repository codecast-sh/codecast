"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight, Columns2, FileCode, FileText, GitPullRequest, Image as ImageIcon, Paperclip } from "lucide-react";
import { useTeamTaskStatusList } from "../../lib/taskStatuses";
import { openBrowserPane } from "../../lib/stage";
import { pageFrameSrc, pageShareUrl } from "../../lib/publishedPageUrls";
import { TaskStatusBadge } from "../TaskStatusBadge";
import { useSyncTaskEvidence, useTaskEvidence, type TaskEvidencePage, type TaskEvidenceRow } from "../../hooks/useSyncTaskEvidence";
import { stationLabel, stationOf, type LineTask } from "../../lib/taskLine";
import { ReviewVerdictChip } from "./StationStrip";

// Evidence attaches at the station (docs/architecture/the-line.md L6, L10):
// the pages a station produced, grouped by station with thumbnails; the
// images a bound session captured; the docs that name the task; the handoff's
// files, PR and verification text; the execution status and the verdict.
// One store row per task (taskEvidence), fed here, painted from cache first.

type EvidenceTask = LineTask & {
  team_id?: string;
  files_changed?: string[];
  verification_evidence?: string;
  execution_status?: string;
};

function PageCard({ page }: { page: TaskEvidencePage }) {
  return (
    <div className="group flex flex-col w-[152px] shrink-0 rounded-lg border border-sol-border/40 bg-sol-card/40 overflow-hidden hover:border-sol-border transition-colors" data-evidence-page={page.slug}>
      <a href={pageShareUrl(page.slug)} target="_blank" rel="noopener noreferrer" className="block h-[88px] bg-sol-bg-highlight/60" title="Open in full">
        {page.thumbnail_url ? (
          <img src={page.thumbnail_url} alt="" className="w-full h-full object-cover object-top" loading="lazy" />
        ) : (
          <span className="flex items-center justify-center w-full h-full text-sol-text-dim"><FileText className="w-5 h-5" /></span>
        )}
      </a>
      <div className="px-2 py-1.5 min-w-0">
        <div className="text-[11px] text-sol-text truncate" title={page.title}>{page.title}</div>
        <div className="mt-1 flex items-center gap-1 text-[10px] text-sol-text-dim">
          <span className="font-mono">v{page.version}</span>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openBrowserPane({ kind: "url", url: pageFrameSrc(page.slug) }); }}
            className="ml-auto inline-flex items-center gap-0.5 hover:text-sol-violet"
            title="Open beside your work, as a pane"
            aria-label="Open in a pane"
          >
            <Columns2 className="w-3 h-3" />pane
          </button>
          <a href={pageShareUrl(page.slug)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:text-sol-blue" title="Open in full">
            <ArrowUpRight className="w-3 h-3" />open
          </a>
        </div>
      </div>
    </div>
  );
}

function FilesChanged({ files }: { files: string[] }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-sol-text-dim mb-2">
        <FileCode className="w-3.5 h-3.5" />
        Files changed ({files.length})
      </div>
      <div className="space-y-0.5 pl-1 border-l-2 border-sol-border/20">
        {files.map((f) => {
          const parts = f.split("/");
          const fileName = parts.pop();
          const dirPath = parts.join("/");
          return (
            <div key={f} className="flex items-center gap-1.5 text-xs font-mono py-0.5 pl-2 hover:bg-sol-bg-alt/20 rounded-r transition-colors min-w-0">
              <FileText className="w-3 h-3 text-sol-text-dim/50 flex-shrink-0" />
              {dirPath && <span className="text-sol-text-dim/50 truncate">{dirPath}/</span>}
              <span className="text-sol-text-muted truncate">{fileName}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TaskEvidence({ task }: { task: EvidenceTask }) {
  useSyncTaskEvidence(task._id);
  const row = useTaskEvidence(task._id);
  const statuses = useTeamTaskStatusList(task.team_id);
  // The task row already carries the handoff fields; the evidence row adds
  // pages, docs, images and the PR. Either paints alone.
  const files = row?.files_changed ?? task.files_changed ?? [];
  const verification = row?.verification_evidence ?? task.verification_evidence ?? null;
  const execution = row?.execution_status ?? task.execution_status ?? null;
  const verdict = row?.review_verdict ?? task.review_verdict ?? null;
  const stations = row?.stations ?? [];
  const docs = row?.docs ?? [];
  const images = row?.images ?? [];
  const pr = row?.pr_url ?? null;
  const groups = useMemo(() => {
    const current = stationOf(task);
    // The current station first, then the rest in the order the server gave.
    return [...stations].sort((a, b) => Number(b.station === current) - Number(a.station === current));
  }, [stations, task.status, task.status_id]);
  const empty = stations.length === 0 && docs.length === 0 && images.length === 0 && files.length === 0 && !verification && !pr && !verdict && !execution;

  return (
    <div className="mb-6" data-task-evidence={empty ? "empty" : "filled"}>
      <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2 flex items-center gap-1.5">
        <Paperclip className="w-3.5 h-3.5" />
        Evidence
        {execution && <TaskStatusBadge status={execution as any} type="execution" className="normal-case tracking-normal" />}
        <ReviewVerdictChip verdict={verdict} className="normal-case tracking-normal" />
      </h2>
      {empty ? (
        <p className="text-xs text-sol-text-dim" data-evidence-empty>Nothing attached yet. A handoff, a published page or a review adds to this.</p>
      ) : (
        <div className="border border-sol-border/30 rounded-lg bg-sol-bg-alt/20 p-4 space-y-4 border-l-2 border-l-sol-cyan/30">
          {groups.map((g) => (
            <div key={g.station || "unfiled"} data-evidence-station={g.station}>
              <div className="text-xs font-medium text-sol-text-dim mb-2">
                {stationLabel(g.station, statuses)} <span className="text-sol-text-dim/60">· {g.pages.length} {g.pages.length === 1 ? "page" : "pages"}</span>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
                {g.pages.map((p) => <PageCard key={p.id} page={p} />)}
              </div>
            </div>
          ))}
          {images.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-sol-text-dim mb-2"><ImageIcon className="w-3.5 h-3.5" />Images ({images.length})</div>
              <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
                {images.map((img) => (
                  <a key={img.message_id} href={img.url} target="_blank" rel="noopener noreferrer" className="block w-[104px] h-[72px] shrink-0 rounded-md border border-sol-border/40 overflow-hidden bg-sol-bg-highlight/60 hover:border-sol-border" title="Open the image">
                    <img src={img.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                  </a>
                ))}
              </div>
            </div>
          )}
          {docs.length > 0 && (
            <div>
              <div className="text-xs font-medium text-sol-text-dim mb-1.5">Docs</div>
              <ul className="space-y-0.5">
                {docs.map((d) => (
                  <li key={d.id} className="text-xs min-w-0 flex items-center gap-1.5">
                    <FileText className="w-3 h-3 text-sol-text-dim shrink-0" />
                    <Link href={d.href} className="truncate text-sol-text-muted hover:text-sol-blue">{d.title}</Link>
                    <span className="text-[10px] text-sol-text-dim shrink-0">{d.doc_type}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {files.length > 0 && <FilesChanged files={files} />}
          {pr && (
            <div className="text-xs flex items-center gap-1.5 min-w-0">
              <GitPullRequest className="w-3.5 h-3.5 text-sol-text-dim shrink-0" />
              <a href={pr} target="_blank" rel="noopener noreferrer" className="truncate text-sol-cyan hover:underline">{pr}</a>
            </div>
          )}
          {verification && (
            <div>
              <div className="text-xs font-medium text-sol-text-dim mb-1.5">Verification</div>
              <div className="text-sm text-sol-text-muted whitespace-pre-wrap">{verification}</div>
            </div>
          )}
          {verdict?.note && (
            <div>
              <div className="text-xs font-medium text-sol-text-dim mb-1.5">Review note</div>
              <div className="text-sm text-sol-text-muted whitespace-pre-wrap">{verdict.note}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type { TaskEvidenceRow };

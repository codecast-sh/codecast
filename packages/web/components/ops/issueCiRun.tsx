// The CI run a check issue is on, as GitHub's checks page shows it: the
// run's commit and how long it took, the job and step that failed, the
// annotations, and the end of the failed job's log.
import { useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { formatRelative } from "../../lib/utils";
import { durationShort } from "./metricModel";
import { LOG_LINES_SHOWN, annotationPath, failedStep, firstFailureLine, isFailureLine, runJobs, tailLines } from "./ciRunModel";
import type { CiRunState } from "./useCiRun";
import type { CiRunRow } from "./issuesModel";

export function CiRunCard({ row, state, repository, now, newest }: { row: CiRunRow; state: CiRunState; repository: string | null; now: number; newest: boolean }) {
  const { run, reading, failed } = state;
  const [whole, setWhole] = useState(false);
  const jobs = run ? runJobs(run) : null;
  const tail = tailLines(run?.log_tail);
  const shownTail = whole ? tail : tail.slice(-LOG_LINES_SHOWN);
  const fileHref = (path: string, line?: number) => (repository && row.sha ? `https://github.com/${repository}/blob/${row.sha}/${path}${line ? `#L${line}` : ""}` : null);
  return (
    <div className="ops-card iss-ci" data-ops-ci-run>
      <div className="ops-card-head">
        <span className="inline-flex items-center gap-2 min-w-0">
          Run
          <span className="ops-mono ops-dim font-normal text-[11px]">{row.run_id}</span>
          <span className="iss-ci-concl" data-ok={row.ok ? "true" : "false"}>{row.conclusion}</span>
          {!newest && <span className="ops-dim font-normal text-[11px]">{formatRelative(row.at, now)}</span>}
        </span>
        {row.url && <a href={row.url} target="_blank" rel="noopener noreferrer" className="ops-dim font-normal text-[11px] inline-flex items-center gap-1 hover:text-sol-text">GitHub <ExternalLink className="w-3 h-3" /></a>}
      </div>
      {run ? (
        <div className="iss-ci-body">
          <div className="iss-ci-meta ops-num">
            {run.title && <span className="iss-ci-title" title={run.title}>{run.title}</span>}
            {row.sha && <span className="ops-mono">{row.sha.slice(0, 7)}</span>}
            {run.duration_ms !== undefined && <span>{durationShort(run.duration_ms)}</span>}
            {run.attempt && run.attempt > 1 ? <span>attempt {run.attempt}</span> : null}
            {run.actor && <span className="ops-dim">{run.actor}</span>}
          </div>
          {jobs && jobs.failed.length > 0 && (
            <ol className="iss-ci-jobs" role="list">
              {jobs.failed.map((j) => {
                const step = failedStep(j);
                return (
                  <li key={j.id} className="iss-ci-job">
                    <X className="w-3.5 h-3.5 shrink-0" aria-label={j.conclusion} />
                    <span className="iss-ci-job-name" title={j.name}>{j.name}</span>
                    {step ? <span className="iss-ci-step" title={step.name}><span className="ops-dim ops-num">step {step.number}</span> {step.name}</span> : <span className="ops-dim">{j.conclusion}</span>}
                    {j.duration_ms !== undefined && <span className="ops-dim ops-num">{durationShort(j.duration_ms)}</span>}
                    {j.url && <a href={j.url} target="_blank" rel="noopener noreferrer" className="iss-ci-link" aria-label={`${j.name} on GitHub`}><ExternalLink className="w-3 h-3" /></a>}
                  </li>
                );
              })}
            </ol>
          )}
          {jobs && (jobs.passed > 0 || jobs.other > 0) && (
            <div className="iss-ci-rest ops-dim ops-num">
              {jobs.passed > 0 && <span>{jobs.passed} passed</span>}
              {jobs.other > 0 && <span>{jobs.other} skipped or cancelled</span>}
            </div>
          )}
          {run.annotations.length > 0 && (
            <ul className="iss-ci-notes" role="list">
              {run.annotations.slice(0, 6).map((a, i) => {
                const path = annotationPath(a.path);
                const href = path ? fileHref(path, a.line) : null;
                const where = path ? `${path}${a.line ? `:${a.line}` : ""}` : a.job;
                return (
                  <li key={i} className="iss-ci-note" data-level={a.level}>
                    {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="ops-mono iss-ci-where hover:underline" title={where}><bdi>{where}</bdi></a> : <span className="ops-mono iss-ci-where" title={where}><bdi>{where}</bdi></span>}
                    <span className="iss-ci-msg">{a.title ? <b>{a.title} </b> : null}{a.message}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {tail.length > 0 && (
            <div className="iss-ci-log">
              <div className="iss-ci-log-head ops-dim">
                <span>Log{run.log_job ? <> · <span className="ops-mono">{run.log_job}</span></> : null}</span>
                {tail.length > LOG_LINES_SHOWN && <button type="button" className="iss-more" onClick={() => setWhole((v) => !v)}>{whole ? "Last lines" : `Whole tail · ${tail.length}`}</button>}
              </div>
              <pre className="ops-code iss-ci-pre">
                {(() => {
                  // The first error line is the one that explains the failure, as GitHub's log viewer marks it.
                  const first = firstFailureLine(shownTail);
                  return shownTail.map((l, i) => <span key={i} data-error={i === first ? "first" : isFailureLine(l) ? "true" : undefined}>{l.replace(/^##\[error\]/, "")}{"\n"}</span>);
                })()}
              </pre>
            </div>
          )}
          {(run.log_error || run.error) && <div className="iss-ci-short ops-dim">{run.error ?? run.log_error}</div>}
        </div>
      ) : reading ? (
        <div className="ops-card-body flex flex-col gap-2" aria-busy="true">
          <div className="iss-skel" style={{ width: "55%" }} />
          <div className="iss-skel" style={{ width: "70%" }} />
        </div>
      ) : (
        <div className="ops-card-body ops-dim text-[12px]">{failed ? `Not read from GitHub: ${failed}` : "Not read from GitHub yet"}</div>
      )}
    </div>
  );
}

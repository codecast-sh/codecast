// One commit as the bisect pages show an answer: subject, author, date, the
// session that wrote it (its Codecast-Session trailer), its main-line twin
// when it sits on no branch, and its diff, limited to the surface's declared
// sources unless "Whole commit" is picked. CommitPanel reads GET /commit/:sha;
// CommitPanelView takes the answer as props.

import { useMemo, useRef, useState } from "react";
import { GitCommitHorizontal } from "lucide-react";
import type { CommitRef, CommitResponse } from "@codecast/shared/contracts/evalsApi";
import { parseUnifiedDiffSections } from "../../lib/unifiedDiffParser";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { DiffView } from "../DiffView";
import { EntityIdPill } from "../EntityIdPill";
import { SegmentedToggle } from "../SegmentedToggle";
import { useEvalsResource } from "../../lib/evals/hooks";
import { shortSha } from "./parts";
import "./bisect.css";

/** The session pill and the off-branch twin: what every commit line in these pages carries. */
export function CommitMarks({ commit }: { commit: CommitRef }) {
  return (
    <>
      {commit.session && <EntityIdPill type="session" id={commit.session} compact />}
      {!commit.onMain && (
        <span className="ev-chip ev-chip--offbranch" title="On no branch; its main-line twin carries the same patch">
          off-branch{commit.mainSha && commit.mainSha !== commit.sha ? `, main ${shortSha(commit.mainSha)}` : ", no main twin"}
        </span>
      )}
    </>
  );
}

const SCOPES = [
  { key: "declared", label: "Declared sources" },
  { key: "whole", label: "Whole commit" },
];

export function CommitPanelView({ data, loading = false, error = null, whole, onWhole, now = Date.now() }: { data: CommitResponse | null; loading?: boolean; error?: string | null; whole: boolean; onWhole: (whole: boolean) => void; now?: number }) {
  const sections = useMemo(() => (data ? parseUnifiedDiffSections(data.diff, data.files.map((f) => f.path)) : []), [data]);
  if (!data) {
    return (
      <section className="ev-card evb-commit" data-evb-commit="loading">
        <div className="px-4 py-4 text-[12px] ev-quiet">{error ? `Could not read the commit: ${error}` : loading ? "Reading the commit..." : "No commit."}</div>
      </section>
    );
  }
  const c = data.commit;
  const body = data.body.split("\n").slice(1).join("\n").trim();
  return (
    <section className="ev-card evb-commit" data-evb-commit={c.sha}>
      <header className="evb-commit-head">
        <div className="evb-commit-meta">
          <span className="ev-chip" title={c.sha}>
            <GitCommitHorizontal /> {shortSha(c.sha, 10)}
          </span>
          <CommitMarks commit={c} />
          <span>{c.author}</span>
          <span title={c.at}>{formatTimeAgo(Date.parse(c.at), now)} ago</span>
          {data.parents[0] && <span className="ev-mono">parent {shortSha(data.parents[0])}</span>}
        </div>
        <div className="evb-commit-subject">{c.subject}</div>
        {body && <div className="evb-note whitespace-pre-wrap">{body}</div>}
      </header>
      <div className="evb-commit-bar">
        <span className="text-[11.5px] ev-quiet">
          {data.files.length} {data.files.length === 1 ? "file" : "files"}
          {data.whole ? " in the whole commit" : " in the surface's declared sources"}
        </span>
        <SegmentedToggle value={whole ? "whole" : "declared"} onChange={(k) => onWhole(k === "whole")} items={SCOPES} />
      </div>
      {data.files.length > 0 && (
        <div className="evb-files">
          {data.files.map((f) => (
            <span key={f.path}>
              {f.path} <span className="evb-file-add">+{f.additions}</span> <span className="evb-file-del">-{f.deletions}</span>
            </span>
          ))}
        </div>
      )}
      {sections.length ? (
        sections.map((s) => (
          <div key={s.filePath} className="evb-commit-file">
            <div className="evb-commit-file-name">{s.filePath}</div>
            <DiffView hunks={s.hunks} oldStr={s.oldContent} newStr={s.newContent} showLineNumbers contextLines={3} />
          </div>
        ))
      ) : (
        <div className="px-4 py-4 text-[12px] ev-quiet">{data.whole ? "The commit changes no text." : "No declared source changed in this commit. Pick Whole commit to see everything it touched."}</div>
      )}
    </section>
  );
}

/** A commit read from the eval tool's checkout, its diff limited to the surface's declared sources by default. */
export function CommitPanel({ sha, surface }: { sha: string; surface: string }) {
  const [whole, setWhole] = useState(false);
  const res = useEvalsResource("GET /commit/:sha", { params: { sha }, query: { surface, whole } });
  // Flipping the scope keeps the last answer on screen until the new one lands.
  const last = useRef<CommitResponse | null>(null);
  if (res.data) last.current = res.data;
  const shown = res.data ?? (last.current?.commit.sha.startsWith(sha) ? last.current : null);
  return <CommitPanelView data={shown} loading={res.loading} error={res.error} whole={whole} onWhole={setWhole} />;
}

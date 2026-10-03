// One commit as the bisect pages show an answer: subject, author, date, the
// session that wrote it (its Codecast-Session trailer), its main-line twin
// when it sits on no branch, and its diff, limited to the surface's declared
// sources unless "Whole commit" is picked. CommitPanel reads GET /commit/:sha;
// CommitPanelView takes the answer as props. PatchPanel is the same for a
// kept tree patch (GET /patch/:sha): the uncommitted edits a dirty rep ran.

import { useMemo, useRef, useState } from "react";
import { GitCommitHorizontal } from "lucide-react";
import type { CommitRef, CommitResponse, PatchResponse } from "@codecast/shared/contracts/evalsApi";
import { splitSessionTrailer } from "@codecast/shared/blame";
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
  // The trailer already shows as the session pill above.
  const body = splitSessionTrailer(data.body.split("\n").slice(1).join("\n")).message.trim();
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
      <DiffFiles files={data.files} sections={sections} empty={data.whole ? "The commit changes no text." : "No declared source changed in this commit. Pick Whole commit to see everything it touched."} />
    </section>
  );
}

type Sections = ReturnType<typeof parseUnifiedDiffSections>;

/** The file list with line counts, then each file's diff: what a commit and a patch both show. */
function DiffFiles({ files, sections, empty }: { files: Array<{ path: string; additions: number; deletions: number }>; sections: Sections; empty: string }) {
  return (
    <>
      {files.length > 0 && (
        <div className="evb-files">
          {files.map((f) => (
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
        <div className="px-4 py-4 text-[12px] ev-quiet">{empty}</div>
      )}
    </>
  );
}

export function PatchPanelView({ data, loading = false, error = null, base = null }: { data: PatchResponse | null; loading?: boolean; error?: string | null; base?: string | null }) {
  const sections = useMemo(() => (data ? parseUnifiedDiffSections(data.diff, data.files.map((f) => f.path)) : []), [data]);
  if (!data) {
    return (
      <section className="ev-card evb-commit" data-evb-patch="loading">
        <div className="px-4 py-4 text-[12px] ev-quiet">{error ? `Could not read the patch: ${error}` : loading ? "Reading the patch..." : "No patch."}</div>
      </section>
    );
  }
  return (
    <section className="ev-card evb-commit" data-evb-patch={data.sha}>
      <header className="evb-commit-head">
        <div className="evb-commit-meta">
          <span className="ev-chip ev-chip--dirty" title={`EVALS_HOME/trees/${data.sha}.patch`}>
            patch {shortSha(data.sha, 10)}
          </span>
          {base && <span className="ev-mono">on top of {shortSha(base)}</span>}
        </div>
        <div className="evb-commit-subject">Uncommitted edits{base ? ` on top of ${shortSha(base)}` : ""}</div>
        <div className="evb-note">What the rep ran beyond its head: the surface's declared sources, fixtures and freezes as the disk held them. A replay applies it with git apply on a worktree at the head.</div>
      </header>
      <div className="evb-commit-bar">
        <span className="text-[11.5px] ev-quiet">
          {data.files.length} {data.files.length === 1 ? "file" : "files"}
          {data.truncated ? ", the text cut at 2 MiB" : ""}
        </span>
      </div>
      <DiffFiles files={data.files} sections={sections} empty="The patch changes no text." />
    </section>
  );
}

/** A kept tree patch read from EVALS_HOME/trees. */
export function PatchPanel({ sha, base = null }: { sha: string; base?: string | null }) {
  const res = useEvalsResource("GET /patch/:sha", { params: { sha } });
  return <PatchPanelView data={res.data} loading={res.loading} error={res.error} base={base} />;
}

/** A commit read from the eval tool's checkout, its diff limited to the surface's declared sources by default (the whole commit with no surface). */
export function CommitPanel({ sha, surface }: { sha: string; surface: string | null }) {
  const [whole, setWhole] = useState(false);
  const res = useEvalsResource("GET /commit/:sha", { params: { sha }, query: { surface: surface ?? undefined, whole } });
  // Flipping the scope keeps the last answer on screen until the new one lands.
  const last = useRef<CommitResponse | null>(null);
  if (res.data) last.current = res.data;
  const shown = res.data ?? (last.current?.commit.sha.startsWith(sha) ? last.current : null);
  return <CommitPanelView data={shown} loading={res.loading} error={res.error} whole={whole} onWhole={setWhole} />;
}

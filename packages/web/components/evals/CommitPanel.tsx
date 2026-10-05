// One commit as the bisect pages show an answer: subject, author, date, the
// session that wrote it (the host reads that from the commit's trailer), its main-line twin
// when it sits on no branch, and its diff, limited to the surface's declared
// sources unless "Whole commit" is picked. CommitPanel reads GET /commit/:sha;
// CommitPanelView takes the answer as props. PatchPanel is the same for a
// kept tree patch (GET /patch/:sha): the uncommitted edits a dirty rep ran.

import { useMemo, useRef, useState } from "react";
import { GitCommitHorizontal } from "lucide-react";
import type { CommitRef, CommitResponse, PatchResponse } from "@codecast/shared/contracts/evalsApi";
import { useEvalsResource } from "../../lib/evals/hooks";
import { offBranchWords, shortSha } from "./format";
import { evalsHref } from "./evalsPaths";
import { useEvalsHost, type EvalsHost } from "./host";
import { EvalsLink } from "./parts";

/** The session that wrote a commit, as the host reads its trailer value; null when it names none or the host reads no sessions. */
export function useCommitSession(commit: Pick<CommitRef, "session">): string | null {
  const read = useEvalsHost().commitSession;
  return commit.session && read ? read.id(commit.session) : null;
}

/** The session pill and the off-branch twin: what every commit line in these pages carries. */
export function CommitMarks({ commit }: { commit: CommitRef }) {
  const { SessionPill } = useEvalsHost().ui;
  const session = useCommitSession(commit);
  return (
    <>
      {session && <SessionPill id={session} />}
      {!commit.onMain && (
        <span className="ev-chip ev-chip--offbranch" title={offBranchWords(commit).title} data-ev-offbranch={commit.mainSha && commit.mainSha !== commit.sha ? "twin" : "none"}>
          {offBranchWords(commit).label}
        </span>
      )}
    </>
  );
}

const SCOPES = [
  { key: "declared", label: "Declared sources" },
  { key: "whole", label: "Whole commit" },
];

/** A diff's text split per file, by the host's parser; a host without one shows the file list alone. */
function useDiffSections(data: { diff: string; files: Array<{ path: string }> } | null): Sections {
  const parse = useEvalsHost().parseUnifiedDiff;
  return useMemo(() => (data && parse ? parse(data.diff, data.files.map((f) => f.path)) : []), [data, parse]);
}

export function CommitPanelView({ data, loading = false, error = null, whole, onWhole, now = Date.now() }: { data: CommitResponse | null; loading?: boolean; error?: string | null; whole: boolean; onWhole: (whole: boolean) => void; now?: number }) {
  const host = useEvalsHost();
  const { SegmentedToggle } = host.ui;
  const sections = useDiffSections(data);
  if (!data) {
    return (
      <section className="ev-card ev-b-commit" data-evb-commit="loading">
        <div className="ev-note ev-b-commit-wait">{error ? `Could not read the commit: ${error}` : loading ? "Reading the commit..." : "No commit."}</div>
      </section>
    );
  }
  const c = data.commit;
  // The trailer already shows as the session pill above.
  const rest = data.body.split("\n").slice(1).join("\n");
  const body = (host.commitSession ? host.commitSession.strip(rest) : rest).trim();
  return (
    <section className="ev-card ev-b-commit" data-evb-commit={c.sha}>
      <header className="ev-b-commit-head">
        <div className="ev-b-commit-meta">
          <span className="ev-chip" title={c.sha}>
            <GitCommitHorizontal /> {shortSha(c.sha, 10)}
          </span>
          <CommitMarks commit={c} />
          <span>{c.author}</span>
          <span title={c.at}>{host.format.timeAgo(Date.parse(c.at), now)} ago</span>
          {data.parents[0] && <span className="ev-mono">parent {shortSha(data.parents[0])}</span>}
        </div>
        <div className="ev-b-commit-subject">{c.subject}</div>
        {body && <div className="ev-b-note ev-b-commit-body">{body}</div>}
        {!c.onMain && !(c.mainSha && c.mainSha !== c.sha) && (
          <div className="ev-b-note" data-evb-no-twin>
            {offBranchWords(c).title}
            {c.near && (
              <>
                {" "}
                <EvalsLink className="ev-b-link" href={evalsHref.commit(c.near)}>
                  Open {shortSha(c.near)}
                </EvalsLink>
              </>
            )}
          </div>
        )}
      </header>
      <div className="ev-b-commit-bar">
        <span className="ev-b-fine ev-quiet">
          {data.files.length} {data.files.length === 1 ? "file" : "files"}
          {data.whole ? " in the whole commit" : " in the surface's declared sources"}
          {data.truncated ? ", the text cut at 2 MiB" : ""}
        </span>
        <SegmentedToggle value={whole ? "whole" : "declared"} onChange={(k) => onWhole(k === "whole")} items={SCOPES} />
      </div>
      <DiffFiles files={data.files} sections={sections} empty={data.whole ? "The commit changes no text." : "No declared source changed in this commit. Pick Whole commit to see everything it touched."} />
    </section>
  );
}

type Sections = ReturnType<NonNullable<EvalsHost["parseUnifiedDiff"]>>;

/** The file list with line counts, then each file's diff: what a commit and a patch both show. */
function DiffFiles({ files, sections, empty }: { files: Array<{ path: string; additions: number; deletions: number }>; sections: Sections; empty: string }) {
  const { DiffView } = useEvalsHost().ui;
  return (
    <>
      {files.length > 0 && (
        <div className="ev-b-files">
          {files.map((f) => (
            <span key={f.path}>
              {f.path} <span className="ev-b-file-add">+{f.additions}</span> <span className="ev-b-file-del">-{f.deletions}</span>
            </span>
          ))}
        </div>
      )}
      {sections.length ? (
        sections.map((s) => (
          <div key={s.filePath} className="ev-b-commit-file">
            <div className="ev-b-commit-file-name">{s.filePath}</div>
            <DiffView hunks={s.hunks} oldStr={s.oldContent} newStr={s.newContent} showLineNumbers contextLines={3} />
          </div>
        ))
      ) : (
        <div className="ev-note ev-b-commit-wait">{empty}</div>
      )}
    </>
  );
}

export function PatchPanelView({ data, loading = false, error = null, base = null }: { data: PatchResponse | null; loading?: boolean; error?: string | null; base?: string | null }) {
  const sections = useDiffSections(data);
  if (!data) {
    return (
      <section className="ev-card ev-b-commit" data-evb-patch="loading">
        <div className="ev-note ev-b-commit-wait">{error ? `Could not read the patch: ${error}` : loading ? "Reading the patch..." : "No patch."}</div>
      </section>
    );
  }
  return (
    <section className="ev-card ev-b-commit" data-evb-patch={data.sha}>
      <header className="ev-b-commit-head">
        <div className="ev-b-commit-meta">
          <span className="ev-chip ev-chip--dirty" title={`EVALS_HOME/trees/${data.sha}.patch`}>
            patch {shortSha(data.sha, 10)}
          </span>
          {base && <span className="ev-mono">on top of {shortSha(base)}</span>}
        </div>
        <div className="ev-b-commit-subject">Uncommitted edits{base ? ` on top of ${shortSha(base)}` : ""}</div>
        <div className="ev-b-note">What the rep ran beyond its head: the surface's declared sources, fixtures and freezes as the disk held them. A replay applies it with git apply on a worktree at the head.</div>
      </header>
      <div className="ev-b-commit-bar">
        <span className="ev-b-fine ev-quiet">
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

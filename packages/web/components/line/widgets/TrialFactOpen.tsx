"use client";
// What a card's figure counts, opened in place under the figures: the proof
// test's own output before and after the change, every check with the one that
// did not run named, the problem's findings the change reaches and the ones it
// misses, and the branch's diff read from a checkout that publishes the
// repository. A figure the person is asked to ship on opens the thing it counts.
import { useMemo, useRef } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import Link from "next/link";
import type { TrialCardRow } from "../../../hooks/useSyncTrial";
import type { FactOpen } from "../../trial/TrialFactsStrip";
import { checkRows, problemFindingsHref } from "../../trial/TrialFactsStrip";
import { useRunVerify } from "../../../hooks/useRunVerify";
import type { LineSignal } from "../../../lib/lineFlow";
import { useSyncTaskSignals } from "../../../hooks/useSyncSignals";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useRepoCompare } from "../../../hooks/useRepoBrowse";
import { serverErrorText } from "../../../lib/errorCause";
import { repoCompareHref } from "../../../lib/repoView";
import { InlineDiff } from "../../InlineDiff";
import "./trialFactOpen.css";

export function TrialFactOpen({ card: c, open }: { card: TrialCardRow; open: FactOpen }) {
  // A figure low on screen opens below the fold: the press would read as doing nothing. Bring what it opened into view.
  const ref = useRef<HTMLDivElement>(null);
  useWatchEffect(() => { ref.current?.scrollIntoView({ block: "nearest" }); }, [open]);
  return (
    <div ref={ref} className="tfo" data-trial-fact-open={open}>
      {open === "proof" && <Proof card={c} />}
      {open === "checks" && <Checks card={c} />}
      {open === "reach" && <Reach card={c} />}
      {open === "diff" && c.branch && <Diff branch={c.branch} />}
    </div>
  );
}

const runHref = (c: TrialCardRow) => (c.run_id ? `/line?view=problems&case=${encodeURIComponent(c.task_short_id || c.task_id)}&run=${encodeURIComponent(c.run_id)}` : null);

/** The proof test's own runs: its command and output on the base, then on the branch. */
function Proof({ card: c }: { card: TrialCardRow }) {
  const proof = c.card?.proof;
  if (!proof) return null;
  const href = runHref(c);
  return (
    <>
      {([["Before the change", proof.before], ["With the change", proof.after]] as const).map(([name, runs]) => (
        <section key={name} className="tfo-run">
          <h4>{name}</h4>
          {runs.map((k, i) => (
            <div key={i} className="tfo-out" data-ok={k.ok ? "" : undefined}>
              <code className="tfo-cmd">{k.name}</code>
              <pre>{k.detail}</pre>
            </div>
          ))}
        </section>
      ))}
      {href && <Link className="tfo-link" href={href}>The whole run</Link>}
    </>
  );
}

const CHECK_WORD = { red: "Red", idle: "Not run", green: "Green" } as const;
const CHECK_ORDER = { red: 0, idle: 1, green: 2 } as const;

/** Every check the run made, the ones that need a look first: the same rows the tile counts (checkRows). */
function Checks({ card: c }: { card: TrialCardRow }) {
  const verify = useRunVerify(c.run_id);
  const rows = useMemo(() => checkRows(c, verify).sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]), [c, verify]);
  return (
    <ul className="tfo-checks">
      {rows.map((k) => (
        <li key={k.name} data-state={k.state}>
          <span className="tfo-st">{CHECK_WORD[k.state]}</span>
          <b>{k.name}</b>
          <span className="tfo-detail">{k.detail}</span>
        </li>
      ))}
    </ul>
  );
}

const signalSig = (s: LineSignal) => `${s.task_id}|${s.short_id ?? ""}|${s.retired ? 1 : 0}`;

/** The problem's findings now, split by whether the change reaches them; each opens on the problem's page. */
function Reach({ card: c }: { card: TrialCardRow }) {
  const { ready } = useSyncTaskSignals(c.task_id);
  const where = useMemo(() => (s: LineSignal) => s.task_id === c.task_id && !s.retired, [c.task_id]);
  const live = useCollectionRows<LineSignal>("signals", { where, sig: signalSig });
  const covers = useMemo(() => new Set(c.card?.reach?.covers ?? []), [c.card]);
  const reached = live.filter((s) => s.short_id && covers.has(s.short_id));
  const missed = live.filter((s) => !s.short_id || !covers.has(s.short_id));
  if (!live.length) return <p className="tfo-note">{!ready ? "Reading the problem's findings" : "The problem holds no findings now"}</p>;
  const list = (rows: LineSignal[]) => (
    <ul className="tfo-findings">
      {rows.map((s) => (
        <li key={s._id}><Link href={problemFindingsHref(c.task_short_id || c.task_id, s.short_id ?? s._id)}><code>{s.short_id}</code> {s.title}</Link></li>
      ))}
    </ul>
  );
  return (
    <>
      {missed.length > 0 && <section className="tfo-run" data-reach="missed"><h4>Misses {missed.length}</h4>{list(missed)}</section>}
      <section className="tfo-run" data-reach="covered"><h4>Reaches {reached.length}</h4>{list(reached)}</section>
    </>
  );
}

/** The branch against the default branch, read from a checkout that publishes the repository. */
function Diff({ branch }: { branch: NonNullable<TrialCardRow["branch"]> }) {
  const read = useRepoCompare(branch.repository, branch.base, branch.name);
  const raw = useMemo(() => (read.data?.files ?? [])
    .filter((f) => f.patch)
    .map((f) => `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`)
    .join("\n"), [read.data]);
  const full = repoCompareHref(branch.repository, branch.base, branch.name);
  return (
    <>
      <p className="tfo-head"><code>{branch.name}</code><Link className="tfo-link" href={full}>Open the comparison</Link></p>
      {read.error ? <p className="tfo-note" data-tone="bad">{serverErrorText(read.error)}</p>
        : !read.data ? <p className="tfo-note">{read.pending ? `Reading the branch from a checkout of ${branch.repository}` : "Reading the branch"}</p>
        : raw ? <InlineDiff raw={raw} />
        : <p className="tfo-note">No file changes between {branch.base} and this branch</p>}
    </>
  );
}

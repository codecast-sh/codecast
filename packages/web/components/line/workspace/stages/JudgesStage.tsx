"use client";
// Judges (learning-loop.md LL8, LL11): each judge reads one kind of moment
// against the expectations and files what broke. The list says per judge what
// it read this week, what it filed, what failed, what it cost and how often a
// person marked it wrong. A judge opens whole: its findings as its finder page
// reads them (each "Judge is wrong" where it stands), its prompt as published,
// every run on a moment, and its versions with the A/B each fix measured.
// "Improve this judge" starts the session that brings a fix as one card.
import { useMemo } from "react";
import { useLineStages, type LineJudge as LineJudgeRow } from "../../../../hooks/useLineStages";
import { useTrialCards, useTrialHref } from "../../../../hooks/useSyncTrial";
import { startJudgingSetup } from "../../../../lib/line/setupJudging";
import { agoWords, usd, wrongShare } from "../../../../lib/line/flowStages";
import { StartSessionButton, improveJudgeWhat } from "../StartSessionButton";
import { useFinders } from "../views/finder/FindTable";
import { FinderPage } from "../views/finder/FinderPage";
import { dayWords } from "../../widgets";
import type { LineViewProps } from "../views/types";
import { Back, DayStrip, Section, StageHead, Version } from "./parts";
import { AgentReviews } from "./AgentReviews";

type JudgeTab = "findings" | "reviews" | "prompt" | "runs" | "versions";
const TABS: Array<[JudgeTab, string]> = [["findings", "Findings"], ["prompt", "Prompt"], ["runs", "Runs"], ["versions", "Versions"]];
/** An agent judge's page adds its reviews: the queue and every session, whole. */
const tabsOf = (j: LineJudgeRow): Array<[JudgeTab, string]> => (j.agent ? [TABS[0]!, ["reviews", "Reviews"], ...TABS.slice(1)] : TABS);

export function JudgesStage(props: LineViewProps & { projectId: string | null }) {
  const { workspace: ws, selection, select, href, projectId } = props;
  const st = useLineStages(projectId);
  const { rows } = useFinders(ws, { everyProcess: true });
  // Each judge's finder row (its findings, marks and wrong rate): a codecast judge files as source `judge:<name>`, so a
  // product's own judge of the same name (AgentWatch's "comms") is never taken for it.
  const finders = useMemo(() => new Map(rows.map((r) => [r.row.source, { key: r.row.key, r }])), [rows]);
  const finderOf = (j: LineJudgeRow) => finders.get(`judge:${j.name}`) ?? null;
  const now = ws.now;
  if (!st) return <div className="lw-skeleton" aria-busy>{[60, 90, 40].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
  // A name a removed judge shares (an older source's) opens the live one.
  const judge = selection.item ? st.judges.find((j) => j.name === selection.item && !j.removed_at) ?? st.judges.find((j) => j.name === selection.item) ?? null : null;
  if (judge) return <JudgePage {...props} j={judge} finder={finderOf(judge)?.key ?? null} wrong={finderOf(judge)?.r ?? null} />;

  const live = st.judges.filter((j) => !j.removed_at);
  const floor = live.some((j) => j.week_capped) ? "+" : "";
  const week = live.reduce((a, j) => ({ runs: a.runs + j.week.runs, filed: a.filed + j.week.filed, failed: a.failed + j.week.failed, usd: a.usd + j.week.cost_usd }), { runs: 0, filed: 0, failed: 0, usd: 0 });
  const open = (name: string) => select({ item: name });
  return (
    <div className="sd" data-line-stage="judges">
      <StageHead
        title="Judges"
        sub="Each reads one kind of moment against the expectations and files what broke"
        figures={[
          { label: "Judges", n: live.length },
          { label: "Reads this week", n: `${week.runs.toLocaleString("en-US")}${floor}` },
          { label: "Filed", n: week.filed },
          { label: "Failed", n: week.failed, tone: week.failed ? "bad" : "dim" },
          { label: "Cost this week", n: usd(week.usd) },
        ]}
      />
      <div className="sd-scroll"><table className="sd-table sd-judges" data-line-judges={live.length}>
        <thead><tr><th>Judge</th><th>Reads</th><th className="sd-n">Reads /wk</th><th className="sd-n">Filed</th><th className="sd-n">Failed</th><th className="sd-n">Wrong</th><th className="sd-n">Cost /wk</th></tr></thead>
        <tbody>
          {st.judges.map((j) => {
            const f = finderOf(j)?.r ?? null;
            return (
              <tr key={j.id} data-removed={j.removed_at ? "" : undefined} onClick={(e) => { if (!(e.target as Element).closest("a")) open(j.name); }} data-line-judge={j.name}>
                <th scope="row">
                  <a className="sd-name" href={href({ item: j.name })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); open(j.name); }}>{j.name}</a>
                  <Version v={j.version} current />
                  <span className="sd-pill" data-tone={j.mode === "live" ? "live" : "dim"}>{j.removed_at ? "removed" : j.mode}</span>
                </th>
                <td className="sd-dim">{j.moment_kind}</td>
                <td className="sd-n lw-num" title={j.week_capped ? `the newest ${j.week.runs} runs read all fall in this week` : undefined}>{j.week.runs}{j.week_capped ? "+" : ""}</td>
                <td className="sd-n lw-num">{j.week.filed}</td>
                <td className="sd-n lw-num" data-tone={j.week.failed ? "bad" : "dim"}>{j.week.failed}</td>
                <td className="sd-n lw-num" data-tone={f?.wrong ? "warn" : "dim"} title={f ? `${f.wrong ?? 0} of ${f.week} findings this week marked wrong` : undefined}>{f ? wrongShare(f.wrong ?? 0, f.week) ?? "–" : "–"}</td>
                <td className="sd-n lw-num">{usd(j.week.cost_usd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {live.map((j) => (
        <div key={j.id} className="sd-strip-row">
          <span className="sd-dim">{j.name}</span>
          <DayStrip days={j.days} now={now} label={`${j.name} reads`} />
          <span className="sd-dim">{j.all.last_at ? `last ${agoWords(j.all.last_at, now)} ago` : "never read"}</span>
        </div>
      ))}
    </div>
  );
}

function JudgePage({ j, finder, wrong, ...props }: LineViewProps & { projectId: string | null; j: LineJudgeRow; finder: string | null; wrong: { wrong: number | null; week: number } | null }) {
  const { workspace: ws, selection, select, href, projectId } = props;
  // The open tab rides the address (`steptab`), so a link opens on it and a re-render never resets it.
  const tabs = tabsOf(j);
  const tab: JudgeTab = tabs.some(([k]) => k === selection.tab) ? (selection.tab as JudgeTab) : "findings";
  const setTab = (t: JudgeTab) => select({ tab: t === "findings" ? null : t }, undefined, { replace: true });
  const now = ws.now;
  // Marks a person made wrong on this judge's findings: the cases "Improve this judge" starts from.
  const marked = wrong?.wrong ?? 0;
  return (
    <div className="sd" data-line-stage="judges" data-line-judge-page={j.name}>
      <Back label="Judges" onBack={() => select({ item: null, finding: null, tab: null })} href={href({ item: null, finding: null, tab: null })} />
      <StageHead
        title={<>{j.name}<Version v={j.version} current /><span className="sd-pill" data-tone={j.mode === "live" ? "live" : "dim"}>{j.removed_at ? "removed" : j.mode}</span></>}
        sub={`Reads ${j.moment_kind} moments · ${j.model}${j.agent ? " · an agent session" : ""} · ${j.source}`}
        figures={[
          { label: "Reads /wk", n: `${j.week.runs}${j.week_capped ? "+" : ""}` },
          { label: "Filed /wk", n: j.week.filed },
          { label: "Failed /wk", n: j.week.failed, tone: j.week.failed ? "bad" : "dim" },
          { label: "Marked wrong", n: wrong ? wrongShare(wrong.wrong ?? 0, wrong.week) ?? "0%" : "–", tone: marked ? "warn" : undefined },
          { label: "Cost /wk", n: usd(j.week.cost_usd) },
          { label: "Versions", n: j.versions.length, tone: "dim" },
        ]}
      >
        <div className="sd-acts">
          <div className="lw-seg" role="tablist" aria-label="Judge">
            {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-line-judge-tab={k}>{l}</button>)}
          </div>
          <span className="sd-spacer" />
          {projectId && (
            <StartSessionButton primary={marked > 0} what={improveJudgeWhat(j.name, marked)} start={() => startJudgingSetup(projectId, { judge: j.name })} data={{ "data-line-improve-judge": j.name }}>
              Improve this judge{marked ? ` · ${marked} marked wrong` : ""}
            </StartSessionButton>
          )}
        </div>
      </StageHead>
      {tab === "findings" && (finder
        ? <div className="sd-finder"><FinderPage {...props} selection={{ ...selection, source: finder }} /></div>
        : <div className="lw-empty"><b>No findings filed</b>{j.name} has filed nothing the line holds.</div>)}
      {tab === "reviews" && <AgentReviews projectId={projectId} judge={j.name} now={now} openMoment={(m) => select({ stage: "moments", item: m })} />}
      {tab === "prompt" && <Prompt j={j} />}
      {tab === "runs" && <Runs j={j} now={now} select={select} href={href} />}
      {tab === "versions" && <Versions j={j} projectId={projectId} />}
    </div>
  );
}

function Prompt({ j }: { j: LineJudgeRow }) {
  return (
    <Section title="Prompt" aside={<span className="lw-mono sd-dim">{j.path}</span>}>
      <dl className="sd-facts">
        <div><dt>Model</dt><dd>{j.model}</dd></div>
        {j.agent ? (
          <>
            <div><dt>Tools</dt><dd>{j.agent.tools.join(", ")}</dd></div>
            <div><dt>Works in</dt><dd className="lw-mono">{j.agent.cwd}, read only</dd></div>
            <div><dt>Turns</dt><dd className="lw-num">up to {j.agent.max_turns} · {Math.round(j.agent.timeout_ms / 60_000)} min</dd></div>
          </>
        ) : (
          <>
            <div><dt>Max tokens</dt><dd className="lw-num">{j.max_tokens.toLocaleString("en-US")}</dd></div>
            <div><dt>Grades</dt><dd title={j.parts?.join(", ")}>{j.parts?.length ? j.parts.join(", ") : "every part"}</dd></div>
          </>
        )}
        <div><dt>Published</dt><dd>{dayWords(j.published_at)}</dd></div>
      </dl>
      <pre className="sd-prompt" data-line-judge-prompt>{j.prompt}</pre>
    </Section>
  );
}

function Runs({ j, now, select, href }: { j: LineJudgeRow; now: number; select: LineViewProps["select"]; href: LineViewProps["href"] }) {
  // A run opens the moment it read, whole, on the Moments page.
  const go = (m: string) => select({ stage: "moments", item: m });
  return (
    <Section title="Newest runs" n={j.all.runs} aside={j.capped ? <span className="sd-dim">newest {j.all.runs} read</span> : null}>
      <ul className="sd-list">
        {j.recent.map((r) => (
          <li key={`${r.moment}:${r.at}`}>
            <a className="sd-row" href={href({ stage: "moments", item: r.moment })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); go(r.moment); }} data-line-judge-run={r.moment}>
              <span className="lw-mono sd-ref">{r.moment}</span>
              <span className="sd-row-t">{r.status === "ok" ? `${r.findings} found · ${r.filed} filed` : r.reason ?? r.status}</span>
              <span className="sd-pill" data-tone={r.status === "ok" ? (r.findings ? "warn" : "ok") : r.status === "failed" ? "bad" : "dim"}>{r.status === "ok" ? (r.findings ? "found" : "clean") : r.status}</span>
              <Version v={r.version} current={r.version === j.version} />
              <span className="sd-dim lw-num">{usd(r.cost_usd)}</span>
              <span className="sd-dim">{agoWords(r.at, now)}</span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Versions({ j, projectId }: { j: LineJudgeRow; projectId: string | null }) {
  // The fixes the judge route measured on this judge (judge_fix cards): the A/B each ran, and what was answered.
  const cards = useTrialCards({ all: true }).filter((c) => c.project_id === projectId && c.judge_fix && new RegExp(`(^|/)${j.name}\\.md$`).test(c.judge_fix.part.file));
  return (
    <>
      <Section title="Versions" n={j.versions.length}>
        <div className="sd-scroll"><table className="sd-table">
          <thead><tr><th>Version</th><th className="sd-n">Reads</th><th className="sd-n">Found</th><th className="sd-n">Filed</th><th className="sd-n">Failed</th><th className="sd-n">Cost</th><th className="sd-n">Read</th></tr></thead>
          <tbody>
            {j.versions.map((v) => (
              <tr key={v.version} data-current={v.version === j.version ? "" : undefined}>
                <td><Version v={v.version} current={v.version === j.version} /></td>
                <td className="sd-n lw-num">{v.runs}</td>
                <td className="sd-n lw-num">{v.findings}</td>
                <td className="sd-n lw-num">{v.filed}</td>
                <td className="sd-n lw-num" data-tone={v.failed ? "bad" : "dim"}>{v.failed}</td>
                <td className="sd-n lw-num">{usd(v.cost_usd)}</td>
                <td className="sd-n sd-dim">{v.first_at ? `${dayWords(v.first_at)} to ${dayWords(v.last_at!)}` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Section>
      <Section title="Fixes measured" n={cards.length}>
        {cards.length ? (
          <div className="sd-scroll"><table className="sd-table" data-line-judge-ab={cards.length}>
            <thead><tr><th>Card</th><th>Change</th><th className="sd-n" title="Ruled cases still found, published then edited (lower is better)">Ruled</th><th className="sd-n" title="Kept findings found again, published then edited (higher is better)">Controls</th><th>Verdict</th><th>Answer</th></tr></thead>
            <tbody>{cards.map((c) => <AbRow key={c._id} c={c as never} projectId={projectId} />)}</tbody>
          </table></div>
        ) : <p className="sd-note">No fix to this judge has been measured</p>}
      </Section>
    </>
  );
}

function AbRow({ c, projectId }: { c: { _id: string; short_id: string; status: string; answer?: { key?: string; label?: string } | null; judge_fix: NonNullable<ReturnType<typeof useTrialCards>[number]["judge_fix"]> }; projectId: string | null }) {
  const href = useTrialHref(projectId, c.short_id);
  const ab = c.judge_fix.ab;
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
  return (
    <tr data-verdict={ab.verdict}>
      <td><a className="lw-link lw-mono" href={href}>{c.short_id}</a></td>
      <td className="sd-row-t" title={c.judge_fix.change}>{c.judge_fix.change}</td>
      <td className="sd-n lw-num">{pct(ab.ruled.base, ab.ruled.runs)} → {pct(ab.ruled.arm, ab.ruled.runs)}</td>
      <td className="sd-n lw-num">{pct(ab.controls.base, ab.controls.runs)} → {pct(ab.controls.arm, ab.controls.runs)}</td>
      <td><span className="sd-pill" data-tone={ab.verdict === "better" ? "ok" : ab.verdict === "worse" ? "bad" : "dim"}>{ab.verdict.replace(/_/g, " ")}</span></td>
      <td className="sd-dim">{c.answer?.label ?? c.answer?.key ?? c.status}</td>
    </tr>
  );
}

"use client";
// Grouping (learning-loop.md LL9): how a finding becomes part of a problem.
// The rule is drawn as its ladder, each rung with what it placed this week: a
// finding joins the problem holding its key or its message, else its words
// are embedded and compared with the problems under the same expectation: one
// that reads the same joins outright, a few near ones go to the attach judge,
// none opens a new problem. Below: the newest placements, each to its
// problem; problems merged and split; findings withdrawn when a newer judging
// did not find them again; the problems holding the most findings.
import { useMemo } from "react";
import { useLineStages } from "../../../../hooks/useLineStages";
import { DAY, agoWords, isJudgeCase, placementMix, type PlacementKey } from "../../../../lib/line/flowStages";
import { problemListName } from "../../../../lib/line/problemTable";
import type { LineViewProps } from "../views/types";
import { Gap, Section, StageHead } from "./parts";

type Sig = { _id: string; source?: string; short_id?: string; title: string; attach?: string; created_at: number; project_id?: string | null; task_id?: string; judge?: string };
type Task = { _id: string; short_id?: string; title: string; status?: string; updated_at?: number; project_id?: string | null; cause?: { merged_into?: string; split_from?: string; named?: { name?: string } } };

const SHOWN = 25;

export function GroupingStage({ workspace: ws, select, href, projectId }: LineViewProps & { projectId: string | null }) {
  const st = useLineStages(projectId);
  const now = ws.now;
  const since = now - 7 * DAY;
  const signals = ws.everySignals as unknown as Sig[];
  const tasks = ws.rows.tasks as unknown as Task[];
  const byId = useMemo(() => new Map(tasks.map((t) => [t._id, t])), [tasks]);
  const inProject = useMemo(() => signals.filter((s) => !projectId || s.project_id === projectId), [signals, projectId]);
  const mine = useMemo(() => inProject.filter((s) => !isJudgeCase(s)).sort((a, b) => b.created_at - a.created_at), [inProject]);
  const cases = useMemo(() => inProject.filter((s) => isJudgeCase(s) && s.created_at >= since).length, [inProject, since]);
  const mix = useMemo(() => placementMix(mine, null, since), [mine, since]);
  const count = (k: PlacementKey) => mix.find((m) => m.key === k)?.n ?? 0;
  const placed = mix.reduce((n, m) => n + m.n, 0);
  const merged = useMemo(() => tasks.filter((t) => t.cause?.merged_into && (!projectId || t.project_id === projectId)).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)), [tasks, projectId]);
  const split = useMemo(() => tasks.filter((t) => t.cause?.split_from && (!projectId || t.project_id === projectId)), [tasks, projectId]);
  const heaviest = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of mine) if (s.task_id && s.created_at >= since) n.set(s.task_id, (n.get(s.task_id) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).flatMap(([id, k]) => (byId.get(id) ? [{ t: byId.get(id)!, n: k }] : []));
  }, [mine, since, byId]);
  const g = st?.grouping;
  const name = (t: Task) => problemListName({ title: t.title, name: t.cause?.named?.name ?? null });
  const problem = (id: string | undefined | null) => {
    const t = id ? byId.get(id) : null;
    if (!t) return <span className="sd-dim">no problem</span>;
    return <a className="sd-to" href={href({ view: "problems", case: t._id, run: null, stage: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ view: "problems", case: t._id, run: null, stage: null }); }}><span className="lw-mono">{t.short_id}</span> {name(t)}</a>;
  };

  const rungs: Array<{ when: string; then: string; n: number; tone?: string }> = g ? [
    { when: "Same key", then: "joins its problem", n: count("fingerprint") },
    { when: "Same message", then: "joins the problem holding it", n: count("message") },
    { when: `Reads the same, ≥ ${g.attach}`, then: "joins without a question", n: count("similar") },
    { when: `Near, ${g.ask} to ${g.attach}`, then: `attach judge picks among ${g.candidates}`, n: count("judge"), tone: "judge" },
    { when: `Nothing near, < ${g.ask}`, then: "opens a new problem", n: count("new"), tone: "new" },
    // Not the rule's: a person filed it onto the problem they chose.
    { when: "A person filed it", then: "onto the problem they chose", n: count("person") },
  ] : [];
  return (
    <div className="sd" data-line-stage="grouping">
      <StageHead
        title="Grouping"
        sub={g ? `Inside one expectation · words embedded with ${g.embedding_model} · near calls by ${g.attach_model}` : "How findings become problems"}
        figures={[
          { label: "Placed /wk", n: placed },
          { label: "Joined", n: count("fingerprint") + count("message") + count("similar") + count("judge") },
          { label: "New problems", n: count("new") },
          { label: "Held", n: count("held"), tone: count("held") ? "warn" : "dim" },
          { label: "Withdrawn /wk", n: st ? st.retired.week.toLocaleString("en-US") : "–", tone: "dim" },
          { label: "Judge cases /wk", n: cases, tone: cases ? "warn" : "dim" },
          { label: "Open problems", n: ws.open },
        ]}
      />
      <Section title="The rule">
        <ol className="sd-ladder" data-line-grouping-rule>
          {rungs.map((r) => (
            <li key={r.when} data-tone={r.tone}>
              <span className="sd-ladder-when">{r.when}</span>
              <span className="sd-ladder-then">{r.then}</span>
              <b className="lw-num">{r.n}</b>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Newest placements" n={mine.length}>
        <ul className="sd-list">
          {mine.slice(0, SHOWN).map((s) => (
            <li key={s._id} className="sd-row" data-line-placement={s.attach ?? "held"}>
              <span className="sd-row-t" title={s.title}>{s.title}</span>
              <span className="sd-pill" data-tone={s.attach === "new" ? "new" : s.attach === "judge" ? "judge" : !s.task_id ? "warn" : "dim"}>{PLACED[s.attach ?? "held"] ?? s.attach}</span>
              {problem(s.task_id)}
              <span className="sd-dim">{agoWords(s.created_at, now)}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Most findings this week" n={heaviest.length}>
        <ul className="sd-list">
          {heaviest.map(({ t, n }) => <li key={t._id} className="sd-row"><b className="lw-num sd-ref">{n}</b>{problem(t._id)}</li>)}
        </ul>
      </Section>
      <Section title="Merged" n={merged.length}>
        {merged.length ? (
          <ul className="sd-list">
            {merged.slice(0, SHOWN).map((t) => <li key={t._id} className="sd-row" data-line-merged={t.short_id}><span className="lw-mono sd-ref">{t.short_id}</span><span className="sd-row-t" title={t.title}>{name(t)}</span><span className="sd-dim">into</span>{problem(t.cause!.merged_into)}</li>)}
          </ul>
        ) : <p className="sd-note">No problem merged</p>}
        {split.length > 0 && <p className="sd-note">{split.length} split off another problem's key</p>}
      </Section>
      <Section title="Withdrawn" n={st?.retired.recent.length ?? 0} aside={<span className="sd-dim">a newer judging did not find them again</span>}>
        <ul className="sd-list">
          {(st?.retired.recent ?? []).map((r) => <li key={r.short_id} className="sd-row"><span className="sd-row-t" title={r.title}>{r.title}</span><span className="sd-dim" title={r.reason}>{r.reason}</span>{problem(r.task_id)}<span className="sd-dim">{agoWords(r.at, now)}</span></li>)}
        </ul>
      </Section>
      <Gap what="Move, merge or split from here" why="merges come from a run's dissolve station and the CLI; no web act yet" />
      <Gap what="Each rung's similarity score" why="the score a finding met is not stored on it" />
    </div>
  );
}

const PLACED: Record<string, string> = { fingerprint: "same key", message: "same message", similar: "read the same", judge: "attach judge", new: "new problem", person: "a person", held: "held" };

// The flows app's Flows view (docs/architecture/flows.md, the library model of
// Oct 23). On /flows: the team's live flow (the library flow switched on, its
// sources, its queue best score first, what is running, its switch), then the
// library as a tree (the spine on top, each variant under the flow it extends
// with what it changes), the segments flows are built from, and the flows the
// team's sessions used. A flow opens its detail in place. On a role's page
// (/flows/<owner>): that role's flow, drawn, with its facts and its counts.
import { useContext, useMemo, useState } from "react";
import Link from "next/link";
import { usePoolFlowRows, useSyncWorkflowRun, useWorkflowRuns } from "../../../../../hooks/useSyncWorkflows";
import { useOwnedFlows } from "../../../../../hooks/useOwnedFlows";
import { useLiveFlow, useSessionFlows, type LiveFlow, type SessionFlow } from "../../../../../hooks/useLiveFlow";
import { useInboxStore } from "../../../../../store/inboxStore";
import { appPool, flowBySlug, flowOfRun, flowRowPath, pushedFlow, type AppFlow } from "../../../../../lib/line/flowPool";
import { changesAnything, flowLibrary, libraryEntry, libraryFlows, type FlowLibrary, type LibraryEntry, type LibraryRow, type VariantChange } from "../../../../../lib/line/flowLibrary";
import { liveFlowLedger, liveQueue, type LiveQueueRow } from "../../../../../lib/line/liveFlow";
import { scoreBand } from "../../../../../lib/line/problemScore";
import { flowRunState } from "../../../../../lib/line/flowFence";
import { flowNeeds, flowOf, type OwnedFlow } from "../../../../../lib/line/ownedFlows";
import { lineWorkspaceHref } from "../../../../../lib/line/lineWorkspaceUrl";
import { FlowPageContext } from "../../../../../lib/line/flowPageContext";
import { lineSettingsHref } from "../../../../../lib/lineSettings";
import { ageShort } from "../../../../../lib/lineFlow";
import { FlowDiagram } from "../../../widgets/FlowDiagram";
import { FlowRunCard } from "../../../widgets/FlowFence";
import { ConsequentialSwitch } from "../../../../consequential/ConsequentialSwitch";
import type { LineViewProps } from "../types";
import "./flows.css";

type Run = { _id: string; status: string; run_kind?: string; current_node_id?: string | null; current_node_label?: string | null; fail_reason?: string | null; task_id?: string | null; task_short_id?: string | null; workflow_slug?: string; workflow_name?: string; user_id?: string; primary_conversation_id?: string | null; created_at: number; updated_at: number };

/** The queue rows the panel lists before "Show all". */
const QUEUE_SHOWN = 12;

export function FlowsView(props: LineViewProps) {
  const owner = useContext(FlowPageContext);
  if (owner) return <FlowOverview {...props} owner={owner} />;
  return props.selection.item ? <PoolFlow {...props} /> : <FlowsHome {...props} />;
}

/** The library a workspace reads, its live flow, and its runs by flow. */
function useLibrary(space: string | null | undefined) {
  const rows = usePoolFlowRows(space) as LibraryRow[];
  const live = useLiveFlow(space);
  const pool = useMemo(() => appPool(rows), [rows]);
  const spine = live ? live.flow : null;
  const lib = useMemo(() => flowLibrary(pool, rows, spine), [pool, rows, spine]);
  const flows = useMemo(() => libraryFlows(lib), [lib]);
  const where = useMemo(() => (r: Run) => !!flowOfRun(flows, r), [flows]);
  const runs = useWorkflowRuns(where) as Run[];
  const runsOf = useMemo(() => {
    const m = new Map<string, Run[]>();
    for (const r of runs) {
      const f = flowOfRun(flows, r);
      if (f) m.set(f.slug, [...(m.get(f.slug) ?? []), r]);
    }
    return m;
  }, [runs, flows]);
  return { lib, flows, live, runsOf };
}

function FlowsHome(props: LineViewProps) {
  const { select, space } = props;
  const { lib, live, runsOf } = useLibrary(space);
  const sessionFlows = useSessionFlows(space);
  const open = (slug: string) => select({ item: slug, run: null });
  return (
    <div className="flh" data-flows-home>
      {live ? <LivePanel {...props} live={live} runs={runsOf.get(live.flow.slug) ?? []} onOpenFlow={open} /> : null}
      <section data-flows-library>
        <h2 className="flv-h">Library<span className="lw-num">{libraryFlows({ lines: lib.lines, segments: [] }).length}</span></h2>
        <ul className="fll-tree">
          {lib.lines.map((e) => <LibraryBranch key={e.flow.slug} entry={e} runsOf={runsOf} picked={null} onPick={open} depth={0} />)}
        </ul>
      </section>
      <section data-flows-segments>
        <h2 className="flv-h">Segments<span className="lw-num">{lib.segments.length}</span></h2>
        <ul className="fll-shelf">
          {lib.segments.map((f) => (
            <li key={f.slug}><button type="button" className="fll-seg" onClick={() => open(f.slug)} data-flow-row={f.slug}><b>{f.label}</b>{f.stations.length > 1 ? <span>{f.stations.length} steps</span> : null}</button></li>
          ))}
        </ul>
      </section>
      {sessionFlows.length ? <SessionShelf flows={sessionFlows} library={lib} names={props.workspace.names} /> : null}
    </div>
  );
}

/** The live flow: what it runs, its switch and load, where it takes problems from, its queue and what is running. */
function LivePanel({ live, runs, onOpenFlow, workspace, href }: LineViewProps & { live: LiveFlow; runs: Run[]; onOpenFlow: (slug: string) => void }) {
  const queueSig = useInboxStore((s) => {
    const tasks = s.tasks as Record<string, any>;
    return live.queue.map((q) => { const t = tasks[q.task_id]; const sc = t?.cause?.scored; return t ? `${q.task_id}|${t.short_id}|${t.title}|${t.project_id ?? ""}|${t.cause?.signal_count ?? 0}|${t.cause?.named?.name ?? ""}|${sc?.score ?? ""}|${sc?.cluster_key ?? ""}|${sc?.cluster_name ?? ""}` : q.task_id; }).join("\n");
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature carries every field the rows read
  const queue = useMemo(() => liveQueue(live, useInboxStore.getState().tasks as Record<string, any>), [live, queueSig]);
  // What the engine counts as running (its load), so the list and the figure agree.
  const running = useMemo(() => {
    const ids = new Set(live.running);
    return runs.filter((r) => ids.has(r._id)).sort((a, b) => b.created_at - a.created_at);
  }, [runs, live.running]);
  const [all, setAll] = useState(false);
  const projectTitle = useMemo(() => new Map(workspace.projects.map((p) => [p._id, p.title ?? ""])), [workspace.projects]);
  const shown = all ? queue : queue.slice(0, QUEUE_SHOWN);
  const turnOn = () => useInboxStore.getState().setLiveFlowOn(live._id, true);
  const turnOff = () => useInboxStore.getState().setLiveFlowOn(live._id, false);
  const changedBy = live.changed_by ? workspace.names.get(live.changed_by) ?? null : null;
  // The switch starts and stops the team's runs: only a team admin flips it (convex liveFlows.setOn); anyone else reads its state.
  const admin = useInboxStore((s) => ((s.teams || []) as Array<{ _id: string; role?: string }>).some((t) => String(t._id) === live.team_id && (t.role === "admin" || t.role === "owner")));
  return (
    <section className="fll-live" data-live-flow={live._id} data-on={live.on ? "" : undefined}>
      <header className="fll-live-head">
        <span className="fll-live-k">Live</span>
        <button type="button" className="fll-live-name" onClick={() => onOpenFlow(live.flow.slug)} data-live-flow-open={live.flow.slug}>{live.flow.label}</button>
        {admin ? <ConsequentialSwitch
          on={live.on}
          ledger={liveFlowLedger(live, queue.length)}
          onTurnOn={turnOn}
          onTurnOff={turnOff}
          trigger={({ on, press, reviewing }) => (
            <button type="button" className="flh-on fll-switch" data-on={on ? "" : undefined} aria-pressed={on} aria-expanded={reviewing} onClick={press} data-live-flow-switch={on ? "on" : "off"}>{on ? "On" : "Off"}</button>
          )}
        /> : <span className="flh-on" data-on={live.on ? "" : undefined} title="A team admin switches it" data-live-flow-switch="read">{live.on ? "On" : "Off"}</span>}
        <span className="fll-live-figs">
          <span><b className="lw-num">{live.load.working}</b>/{live.load.cap} running</span>
          <span><b className="lw-num">{live.hands_today}</b>{live.caps.hands_per_day != null ? `/${live.caps.hands_per_day}` : ""} today</span>
          {live.watcher ? <span>watched by <b>@{live.watcher.handle}</b></span> : null}
          {changedBy && live.changed_at ? <span title={new Date(live.changed_at).toLocaleString()}>{live.on ? "on" : "off"} by {changedBy}, {ageShort(workspace.now - live.changed_at)} ago</span> : null}
        </span>
      </header>
      {live.waiting && live.on ? <p className="fll-live-wait" data-live-flow-waiting>{live.waiting}</p> : null}
      <div className="flv-facts">
        <Fact label="Takes from">{live.sources ? live.sources.map((s) => <span key={s} className="flv-chip">{s}</span>) : <span className="flv-chip">Every source</span>}</Fact>
      </div>
      <div className="fll-live-cols">
        <div>
          <h3 className="flv-h">Queue<span className="lw-num">{queue.length}</span><span className="fll-h-note">best score first</span></h3>
          {queue.length === 0 ? <p className="flv-none">Nothing waiting</p> : (
            <table className="flh-table fll-queue" data-live-queue>
              <thead><tr><th data-num="">#</th><th>Problem</th><th data-num="">Score</th><th>Family</th><th data-num="">Findings</th><th>Area</th><th>Waits on</th></tr></thead>
              <tbody>
                {shown.map((r, i) => <QueueRow key={r.taskId} row={r} n={i + 1} area={r.projectId ? projectTitle.get(r.projectId) ?? "" : ""} href={href({ view: "problems", case: r.ref ?? r.taskId, run: null })} />)}
              </tbody>
            </table>
          )}
          {queue.length > QUEUE_SHOWN ? <button type="button" className="fll-more" onClick={() => setAll(!all)} data-live-queue-all>{all ? "Show the first 12" : `Show all ${queue.length}`}</button> : null}
        </div>
        <div>
          <h3 className="flv-h">Running<span className="lw-num">{live.running.length}</span></h3>
          {live.running.filter((id) => !running.some((r) => r._id === id)).map((id) => <RunFeed key={id} id={id} />)}
          {running.length === 0 ? <p className="flv-none">{live.running.length ? "Loading" : "Nothing running"}</p> : (
            <ul className="fll-running" data-live-running>
              {running.slice(0, QUEUE_SHOWN).map((r) => (
                <li key={r._id}>
                  <Link href={href({ view: "problems", run: r._id, case: r.task_short_id ?? r.task_id ?? null })} className="fll-run" data-live-run={r._id}>
                    <span className="fll-run-ref">{r.task_short_id ?? "run"}</span>
                    <span className="fll-run-step">{r.current_node_label ?? r.current_node_id ?? r.status}</span>
                    <span className="fll-run-age">{ageShort(workspace.now - r.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** A run the engine counts as running that the store does not hold yet, fed by id. */
function RunFeed({ id }: { id: string }) {
  useSyncWorkflowRun(id);
  return null;
}

function QueueRow({ row: r, n, area, href }: { row: LiveQueueRow; n: number; area: string; href: string }) {
  return (
    <tr data-live-queue-row={r.ref ?? r.taskId}>
      <td data-num="" className="flh-dim">{n}</td>
      <td className="fll-q-name"><Link href={href}><span className="fll-q-ref">{r.ref ?? ""}</span>{r.name}</Link></td>
      <td data-num="" title={r.score?.reason}>{r.score ? <b className="fll-score" data-band={scoreBand(r.score.score)}>{r.score.score}</b> : <span className="flh-zero">–</span>}</td>
      <td className="flh-dim">{r.score?.family?.name ?? ""}</td>
      <td data-num="">{r.findings}</td>
      <td className="flh-dim">{area}</td>
      <td className="flh-dim">{r.waiting ?? ""}</td>
    </tr>
  );
}

/** One flow of the library and, under it, the flows that extend it, each with what it changes. */
function LibraryBranch({ entry: e, runsOf, picked, onPick, depth }: { entry: LibraryEntry; runsOf: Map<string, Run[]>; picked: string | null; onPick: (slug: string) => void; depth: number }) {
  const all = runsOf.get(e.flow.slug) ?? [];
  const live = all.filter((r) => r.status === "running").length;
  return (
    <li data-library-flow={e.flow.slug} data-depth={depth}>
      <button type="button" className="flv-row fll-row" aria-current={e.flow.slug === picked ? "true" : undefined} onClick={() => onPick(e.flow.slug)} data-flow-row={e.flow.slug}>
        <span className="flv-row-name">
          {e.flow.label}
          {e.spine ? <span className="fll-tag" data-tag="spine">Spine</span> : null}
          {e.base ? <span className="fll-tag">Variant</span> : null}
        </span>
        {e.change ? <ChangeChips change={e.change} /> : flowRowPath(e.flow) ? <span className="flv-row-path">{flowRowPath(e.flow)}</span> : null}
        <span className="flv-row-n">
          {live ? <b data-live>{live} running</b> : null}
          {all.length ? <span>{all.length} {all.length === 1 ? "run" : "runs"}</span> : null}
        </span>
      </button>
      {e.variants.length ? <ul className="fll-branch">{e.variants.map((v) => <LibraryBranch key={v.flow.slug} entry={v} runsOf={runsOf} picked={picked} onPick={onPick} depth={depth + 1} />)}</ul> : null}
    </li>
  );
}

/** What a variant changes, as chips: each step it changes (and how), adds or removes, and the sources it serves. */
function ChangeChips({ change: c }: { change: VariantChange }) {
  if (!changesAnything(c)) return <span className="flv-row-path">Same steps</span>;
  return (
    <span className="fll-changes" data-variant-changes="">
      {c.changed.map((s) => <span key={s.id} className="fll-ch" data-ch="changed" title={`${s.label}: ${s.what.join(", ")}`}>{s.label}<i>{s.what.join(", ")}</i></span>)}
      {c.added.map((s) => <span key={s.id} className="fll-ch" data-ch="added">+ {s.label}</span>)}
      {c.removed.map((s) => <span key={s.id} className="fll-ch" data-ch="removed">− {s.label}</span>)}
      {c.serves ? <span className="fll-ch" data-ch="serves" title={c.serves.join(" ")}>serves {c.serves.length}</span> : null}
    </span>
  );
}

/** The flows the team's sessions ran or defined: each with its runs, who ran it and its sessions, and Save into the
 *  library. */
function SessionShelf({ flows, library, names }: { flows: SessionFlow[]; library: FlowLibrary; names: ReadonlyMap<string, string> }) {
  const now = Date.now();
  return (
    <section data-flows-sessions>
      <h2 className="flv-h">Used in sessions<span className="lw-num">{flows.length}</span></h2>
      <table className="flh-table fll-sessions">
        <thead><tr><th>Flow</th><th data-num="">Steps</th><th data-num="">Runs</th><th>Last</th><th>Ran it</th><th>Sessions</th><th /></tr></thead>
        <tbody>
          {flows.map((f) => {
            const steps = pushedFlow({ _id: f._id, slug: f.name, name: f.name, nodes: f.nodes, edges: f.edges }).stations.length;
            const who = f.by.map((id) => names.get(id)).filter((n): n is string => !!n);
            const base = f.base ? libraryEntry(library, f.base)?.flow.label ?? f.base : null;
            return (
              <tr key={f._id} data-session-flow={f._id}>
                <td className="flh-name"><b>{f.label || f.name}</b>{base ? <span>extends {base}</span> : null}</td>
                <td data-num="">{steps}</td>
                <td data-num="">{f.run_count}{f.more ? "+" : ""}</td>
                <td className="flh-dim">{ageShort(now - f.last_at)}</td>
                <td className="flh-dim">{who.join(", ")}</td>
                <td className="fll-sess">{f.sessions.length ? <><Link className="flv-chip flv-chip-btn" href={`/conversation/${f.sessions[0]}`} data-session-flow-session={f.sessions[0]}>Newest</Link>{f.sessions.length > 1 ? <span className="flh-dim">{f.sessions.length} in all</span> : null}</> : null}</td>
                <td>{f.saved
                  ? <span className="flh-on" data-on="" data-session-flow-saved={f.saved.slug}>Saved v{f.saved.version}</span>
                  : <button type="button" className="flv-steps" onClick={() => useInboxStore.getState().saveSessionFlow(f._id, f.base ? { variant_of: f.base } : undefined)} data-session-flow-save={f._id}>Save</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** One flow of the library: drawn, what it changes against its base, the segments it is made of, the flows it is part
 *  of, and the changes that ran through it. */
function PoolFlow({ selection, select, workspace, space }: LineViewProps) {
  const { lib, flows, runsOf } = useLibrary(space);
  const picked = flowBySlug(flows, selection.item) ?? flowBySlug(flows, "change") ?? flows[0];
  const entry = libraryEntry(lib, picked.slug);
  const usedBy = flows.filter((f) => f.uses.includes(picked.slug));
  const pickedRuns = (runsOf.get(picked.slug) ?? []).slice().sort((a, b) => b.created_at - a.created_at);
  const openRun = selection.run ? pickedRuns.find((r) => r._id === selection.run) ?? null : null;
  const now = workspace.now;
  const pick = (slug: string) => select({ item: slug, run: null });

  return (
    <div className="flv" data-line-flows>
      <nav className="flv-list" aria-label="Flows">
        <button type="button" className="flv-back" onClick={() => select({ item: null, run: null })} data-flows-back>All flows</button>
        <section>
          <h2 className="flv-h">Library</h2>
          <ul className="fll-tree">{lib.lines.map((e) => <LibraryBranch key={e.flow.slug} entry={e} runsOf={runsOf} picked={picked.slug} onPick={pick} depth={0} />)}</ul>
        </section>
        <section>
          <h2 className="flv-h">Segments<span className="lw-num">{lib.segments.length}</span></h2>
          <ul>
            {lib.segments.map((f) => (
              <li key={f.slug}><button type="button" className="flv-row" aria-current={f.slug === picked.slug ? "true" : undefined} onClick={() => pick(f.slug)} data-flow-row={f.slug}><span className="flv-row-name">{f.label}</span></button></li>
            ))}
          </ul>
        </section>
      </nav>

      <article className="flv-main" data-flow={picked.slug}>
        <header className="flv-head">
          <span className="lw-flow-kind" data-kind={picked.kind}>{entry?.spine ? "Spine" : entry?.base ? "Variant" : picked.kind === "line" ? "Flow" : "Segment"}</span>
          <h1>{picked.label}</h1>
          <span className="flv-where">{picked.where === "shipped" ? "ships with codecast" : "in the team's library"}</span>
          {pickedRuns.length > 0 && (
            <button type="button" className="flv-steps" onClick={() => select({ view: "line", graph: picked.slug })} title="Each step's prompt, its decisions on past runs, and how often it sent work each way" data-flow-steps={picked.slug}>Steps</button>
          )}
        </header>
        {picked.description ? <p className="flv-desc">{picked.description}</p> : null}
        <div className="lw-flow flv-diagram"><FlowDiagram flow={picked} /></div>

        <div className="flv-facts">
          {entry?.base ? <Fact label="Extends"><FlowChip flow={flowBySlug(flows, entry.base)} slug={entry.base} onPick={pick} /></Fact> : null}
          {entry?.change && changesAnything(entry.change) ? <Fact label="Changes"><ChangeChips change={entry.change} /></Fact> : null}
          {entry?.variants.length ? <Fact label="Variants">{entry.variants.map((v) => <FlowChip key={v.flow.slug} flow={v.flow} slug={v.flow.slug} onPick={pick} />)}</Fact> : null}
          <Fact label="Takes">{picked.takes.map((t) => <span key={t} className="flv-chip">{t === "branch" ? "a branch or a session's edits" : t === "task" ? "a task" : t}</span>)}</Fact>
          {picked.uses.length ? <Fact label="Made of">{picked.uses.map((u) => <FlowChip key={u} flow={flowBySlug(flows, u)} slug={u} onPick={pick} />)}</Fact> : null}
          {usedBy.length ? <Fact label="Part of">{usedBy.map((f) => <FlowChip key={f.slug} flow={f} slug={f.slug} onPick={pick} />)}</Fact> : null}
        </div>

        <section className="flv-runs">
          <h2 className="flv-h">Changes run through it<span className="lw-num">{pickedRuns.length}</span></h2>
          {pickedRuns.length === 0 ? <p className="flv-none">None yet</p> : (
            <ul>
              {pickedRuns.slice(0, 30).map((r) => {
                const st = flowRunState(r, picked);
                return (
                  <li key={r._id}>
                    <button type="button" className="flv-run" aria-current={openRun?._id === r._id ? "true" : undefined} onClick={() => select({ run: openRun?._id === r._id ? null : r._id })} data-flow-run-row={r._id}>
                      <span className="lw-flow-state" data-tone={st.tone}>{st.words}</span>
                      <span className="flv-run-task">{r.task_short_id ?? (r.run_kind === "workflow" ? "in a session" : "no task")}</span>
                      <span className="flv-run-why">{st.why ?? ""}</span>
                      <span className="flv-run-age">{ageShort(now - r.created_at)}</span>
                    </button>
                    {openRun?._id === r._id ? <FlowRunCard runId={r._id} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </article>
    </div>
  );
}

/** What a flow holds now: decisions waiting on a person, problems ready to start, and problems being built. */
function useFlowCounts(workspace: LineViewProps["workspace"], flows: ReadonlyArray<OwnedFlow>) {
  return useMemo(() => {
    const needs = workspace.needs.filter((n) => n.counted);
    const rollup = new Map(workspace.allRollups.map((r) => [r.key, r]));
    const sum = (f: OwnedFlow, k: "ready" | "build") => f.projects.reduce((n, p) => n + (rollup.get(p.id)?.[k] ?? 0), 0);
    return new Map(flows.map((f) => [f.owner.handle, { decisions: flowNeeds(needs, f).length, queued: sum(f, "ready"), running: sum(f, "build") }]));
  }, [workspace.needs, workspace.allRollups, flows]);
}

/** One owned flow on its own page: its steps drawn, its facts, and what it holds now, each opening where it is acted on. */
function FlowOverview({ owner, workspace, select, href, space }: LineViewProps & { owner: string }) {
  const flows = useOwnedFlows(workspace);
  const flow = flowOf(flows, owner);
  const counts = useFlowCounts(workspace, flow ? [flow] : []).get(owner);
  const pool = useMemo(() => appPool([]), []);
  const { flows: library } = useLibrary(space);
  if (!flow) return <p className="flv-none" data-flow-missing={owner}>{flows.length ? `No flow is owned by @${owner}` : "Loading the flow"}</p>;
  const steps = flowBySlug(library, flow.steps) ?? flowBySlug(pool, flow.steps);
  return (
    <article className="flv-main flo" data-flow-overview={owner}>
      <div className="flo-counts">
        <Count n={counts?.decisions ?? 0} label="decisions" tone="ask" to={counts?.decisions ? lineWorkspaceHref(null, { view: "foryou", flow: owner }) : null} />
        <Count n={counts?.queued ?? 0} label="queued" to={counts?.queued ? href({ view: "problems", status: "notstarted" }) : null} />
        <Count n={counts?.running ?? 0} label="running" to={counts?.running ? href({ view: "problems", status: "running" }) : null} />
      </div>
      <div className="flv-facts">
        <Fact label="Owner"><Link className="flv-chip flv-chip-btn" href={`/org/${flow.owner.short_id}`}>@{flow.owner.handle}</Link></Fact>
        <Fact label="Starts"><Link className="flh-on" data-on={flow.on ? "" : undefined} href={lineSettingsHref({ section: "starts" })}>{flow.on ? "On" : "Off"}</Link></Fact>
        <Fact label="Takes from">{flow.projects.map((p) => <button key={p.id} type="button" className="flv-chip flv-chip-btn" onClick={() => select({ view: "problems", project: p.id })}>{p.title}</button>)}</Fact>
        <Fact label="Decides"><span className="flv-chip">{flow.deciderId ? workspace.names.get(flow.deciderId) ?? "A person" : "Nobody"}</span></Fact>
        <Fact label="Merge"><span className="flv-chip">{flow.merge ? "On" : "Off"}</span></Fact>
        {flow.reviewAgent ? <Fact label="Review on"><span className="flv-chip">{flow.reviewAgent}</span></Fact> : null}
      </div>
      <header className="flv-head">
        <h2 className="flv-h">Steps</h2>
        <span className="flv-where">{steps?.label ?? flow.steps}</span>
        <button type="button" className="flv-steps" onClick={() => select({ view: "line", graph: flow.steps })} data-flow-steps={flow.steps}>Open steps</button>
      </header>
      {steps ? <div className="lw-flow flv-diagram"><FlowDiagram flow={steps} /></div> : null}
    </article>
  );
}

function Count({ n, label, tone, to }: { n: number; label: string; tone?: "ask"; to: string | null }) {
  const body = <><b className="lw-num">{n}</b><span>{label}</span></>;
  return to ? <Link href={to} className="flo-count" data-tone={n > 0 ? tone : undefined}>{body}</Link> : <span className="flo-count" data-quiet="">{body}</span>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flv-fact"><span className="flv-fact-k">{label}</span><span className="flv-fact-v">{children}</span></div>;
}

function FlowChip({ flow, slug, onPick }: { flow: AppFlow | null; slug: string; onPick: (slug: string) => void }) {
  return <button type="button" className="flv-chip flv-chip-btn" onClick={() => onPick(slug)}>{flow?.label ?? slug}</button>;
}

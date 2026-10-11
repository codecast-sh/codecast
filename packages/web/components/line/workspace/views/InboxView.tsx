"use client";
// Inbox (line-workspace.md LW1): what waits on the viewer across the line, one
// row per thing, grouped by what to do (lib/line/lineInbox). A row names the
// thing itself (the problem, the question, why the run failed) and carries one
// action; clicking the row opens the problem's timeline (or filters to a
// project that cannot start). A problem holding on a person leads with what it
// asks; a new one is confirmed or dropped in place. Failed runs group by the
// station they stopped at and how (one line per cause, its problems under it
// when opened), so twenty runs that looped at the same step read as one thing
// to fix. j and k walk the rows, Enter opens, a acts.
import { Fragment, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEventListener } from "../../../../hooks/useEventListener";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { hasOpenModal } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { decisionHref } from "../../../../lib/decisionLinks";
import { ageShort } from "../../../../lib/lineFlow";
import { lineSettingsHref } from "../../../../lib/lineSettings";
import { lineProjectParam } from "../../../../lib/line/lineStations";
import { groupFailures, type FailureGroup, type InboxKind, type InboxRow } from "../../../../lib/line/lineInbox";
import { sourceChipWords } from "../../../../lib/line/stepRuns";
import { useLineAdmission } from "../../map/useLineAdmission";
import { answerProblem } from "./timeline/ProblemHead";
import type { LineViewProps } from "./types";

/** The tone each group carries: one accent per meaning. */
const TONE: Record<InboxKind, "ask" | "bad" | "warn" | "quiet"> = { decide: "ask", unapproved: "warn", confirm: "ask", question: "ask", review: "ask", failed: "bad", stalled: "warn", stuck: "quiet" };
const ACTION: Record<InboxKind, string> = { decide: "Decide", unapproved: "Review", confirm: "Confirm", question: "Answer", review: "Review", failed: "Open run", stalled: "Open run", stuck: "Settings" };

/** A line the keys walk: a row, or a failure cause standing for its runs. */
type Item = { key: string; row?: InboxRow; cause?: FailureGroup };

export function InboxView({ model, workspace, select, href, pinned }: LineViewProps) {
  const { projects, now, project, inbox: groups, sources } = workspace;
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const failures = useMemo(() => groupFailures(groups.find((g) => g.kind === "failed")?.rows ?? []), [groups]);
  const flat = useMemo<Item[]>(() => groups.flatMap((g) => g.kind !== "failed"
    ? g.rows.map((row) => ({ key: row.key, row }))
    : failures.flatMap((c) => [{ key: `cause:${c.key}`, cause: c }, ...(opened.has(c.key) ? c.rows.map((row) => ({ key: row.key, row })) : [])])), [groups, failures, opened]);
  const toggle = (k: string) => setOpened((was) => { const next = new Set(was); if (!next.delete(k)) next.add(k); return next; });
  const openStep = (c: FailureGroup) => { if (c.step) select({ view: "process", mode: "graph", step: c.step }); };
  const titles = useMemo(() => new Map(projects.map((p) => [p._id, p.title])), [projects]);
  const params = useMemo(() => new Map(projects.map((p) => [p._id, lineProjectParam(p)])), [projects]);
  const [cursor, setCursor] = useState<string | null>(null);
  const router = useRouter();
  const active = useTabActive();

  const taskHref = (r: InboxRow) => `/tasks/${r.ref ?? r.caseId}`;
  /** Where a row's one action goes: a link, or a select in the app. */
  const act = (r: InboxRow) => {
    if (r.kind === "decide" && r.cardId) router.push(decisionHref({ _id: r.cardId, short_id: r.cardRef ?? undefined } as never));
    else if ((r.kind === "failed" || r.kind === "stalled") && r.runId) select({ view: "runs", run: r.runId }, r.caseId);
    else if (r.kind === "question" && r.caseId) select({ view: "problems", case: r.caseId, run: null, ask: "1" });
    else if (r.kind === "confirm" && r.ref) answerProblem(r.ref, "confirmed");
    else if (r.kind === "review") router.push(taskHref(r));
    else if (r.kind === "unapproved" && r.caseId) select({ view: "problems", case: r.caseId, run: null });
    else if (r.kind === "stuck" && r.projectId) router.push(lineSettingsHref({ project: params.get(r.projectId) ?? r.projectId }));
  };
  const open = (r: InboxRow) => {
    if (r.caseId) select({ view: "problems", case: r.caseId, run: null });
    // Pinned to a project, a stuck row has no filter to narrow: it opens its settings, as its action does.
    else if (r.kind === "stuck" && r.projectId) { if (pinned) act(r); else select({ project: params.get(r.projectId) ?? r.projectId }); }
  };

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || !flat.length || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    const i = Math.max(-1, flat.findIndex((r) => r.key === cursor));
    const cur = i >= 0 ? flat[i] : null;
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCursor(flat[Math.min(flat.length - 1, i + 1)].key); }
    else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCursor(flat[Math.max(0, i - 1)].key); }
    else if (e.key === "Enter" && cur) { e.preventDefault(); if (cur.cause) toggle(cur.cause.key); else if (cur.row) open(cur.row); }
    else if (e.key === "a" && cur) { e.preventDefault(); if (cur.cause) openStep(cur.cause); else if (cur.row) act(cur.row); }
  });

  const rowOf = (r: InboxRow, nested?: boolean) => (
    <li key={r.key} className="lwi-row" data-nested={nested ? "" : undefined} data-ask={r.ask ? "" : undefined} data-cursor={r.key === cursor ? "" : undefined} data-line-inbox-row={r.kind} onMouseEnter={() => setCursor(r.key)}>
      <button type="button" className="lwi-main" onClick={() => open(r)} title={r.ask ? `${r.ask}\n${r.title}` : r.fail ? `${r.title}\n${r.fail.raw}` : r.detail ? `${r.title}\n${r.detail}` : r.title}>
        <span className="lwi-ref">{r.ref ?? ""}</span>
        <span className="lwi-title">{r.title}</span>
        {!nested && (r.ask ?? r.detail) && <span className="lwi-detail" data-ask={r.ask ? "" : undefined}>{r.ask ?? r.detail}</span>}
      </button>
      <span className="lwi-src">{(() => {
        const src = r.caseId ? sources.get(r.caseId) : undefined;
        return src ? <span className="lw-srcchip" title={src.findings ? `${src.findings} ${src.findings === 1 ? "finding" : "findings"}` : "Filed by hand"}>{sourceChipWords(src)}</span> : null;
      })()}</span>
      {r.kind === "stuck"
        ? <span className="lwi-meta lw-num" title={`${r.waiting} problems waiting`}>{r.waiting} waiting</span>
        : <span className="lwi-meta">{!project && r.projectId ? titles.get(r.projectId) ?? "" : ""}</span>}
      <span className="lwi-age lw-num">{r.at ? ageShort(now - r.at) : ""}</span>
      <span className="lwi-act">
        {r.kind === "stuck" && r.projectId && r.switchOff ? <TurnOn projectId={r.projectId} />
          : r.kind === "decide" && r.cardId ? <Link className="lw-act" data-primary="" href={decisionHref({ _id: r.cardId, short_id: r.cardRef ?? undefined } as never)}>{ACTION.decide}</Link>
          : r.kind === "review" ? <Link className="lw-act" href={taskHref(r)}>{ACTION[r.kind]}</Link>
          : r.kind === "confirm" && r.ref ? (
            <>
              <button type="button" className="lw-act" data-primary="" onClick={() => act(r)} data-line-inbox-confirm={r.ref}>Confirm</button>
              <button type="button" className="lw-act" onClick={() => answerProblem(r.ref!, "dropped")} data-line-inbox-drop={r.ref}>Not a problem</button>
            </>
          )
          : r.kind === "question" && r.caseId ? <a className="lw-act" data-primary="" href={href({ view: "problems", case: r.caseId, run: null, ask: "1" })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); act(r); }}>{ACTION.question}</a>
          : <button type="button" className="lw-act" onClick={() => act(r)}>{ACTION[r.kind]}</button>}
      </span>
    </li>
  );

  if (!groups.length) {
    return <div className="lw-empty" data-line-inbox="empty"><b>Nothing waits for you</b>{project ? project.title : "Every project"}</div>;
  }
  return (
    <div className="lwi" data-line-inbox={flat.length}>
      {groups.map((g) => (
        <section key={g.kind} className="lwi-group" data-tone={TONE[g.kind]} data-kind={g.kind} data-line-inbox-group={g.kind}>
          <h2 className="lwi-group-h"><span className="lw-dot" aria-hidden />{g.label}<span className="lw-num">{g.rows.length}</span></h2>
          <ul className="lwi-rows">
            {g.kind !== "failed" ? g.rows.map((r) => rowOf(r)) : failures.map((c) => {
              const st = c.step ? model.steps[c.step] : undefined;
              const k = `cause:${c.key}`;
              const isOpen = opened.has(c.key);
              const raws = [...new Set(c.rows.map((r) => r.fail?.raw).filter(Boolean))];
              return (
                <Fragment key={k}>
                  <li className="lwi-row lwi-cause" data-open={isOpen ? "" : undefined} data-cursor={k === cursor ? "" : undefined} data-line-inbox-cause={c.key} onMouseEnter={() => setCursor(k)}>
                    <button type="button" className="lwi-main" aria-expanded={isOpen} onClick={() => toggle(c.key)} title={raws.join("\n")}>
                      <ChevronRight className="lwi-caret" aria-hidden />
                      <span className="lw-kind lwi-cause-step" data-kind={st?.kind ?? "end"}>{st?.label ?? c.step ?? "Run"}</span>
                      <span className="lwi-cause-label">{c.label}</span>
                      <span className="lwi-cause-n lw-num">{c.rows.length} {c.rows.length === 1 ? "run" : "runs"}</span>
                    </button>
                    <span className="lwi-src" />
                    <span className="lwi-meta">{!project ? [...new Set(c.rows.map((r) => (r.projectId ? titles.get(r.projectId) : null)).filter(Boolean))].join(", ") : ""}</span>
                    <span className="lwi-age lw-num">{c.newest ? ageShort(now - c.newest) : ""}</span>
                    <span className="lwi-act">{c.step && st ? <button type="button" className="lw-act" onClick={() => openStep(c)} data-line-inbox-open-step={c.step}>Open step</button> : null}</span>
                  </li>
                  {isOpen && c.rows.map((r) => rowOf(r, true))}
                </Fragment>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The one fix for a project whose line is switched off: turn it on, in place. */
function TurnOn({ projectId }: { projectId: string }) {
  const admit = useLineAdmission(projectId);
  const a = admit.admission;
  if (!a?.role) return null;
  return (
    <button type="button" className="lw-act" data-primary="" aria-pressed={a.on} onClick={() => admit.setOn(!a.on)} data-line-inbox-turn-on={projectId}>
      {a.on ? "On" : "Turn on"}
    </button>
  );
}

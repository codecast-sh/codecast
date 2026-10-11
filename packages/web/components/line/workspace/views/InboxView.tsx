"use client";
// Inbox (line-workspace.md LW1): what waits on the viewer across the line, one
// row per thing, grouped by what to do (lib/line/lineInbox). A row names the
// thing itself (the problem, the question, why the run failed) and carries one
// action; clicking the row opens the problem's timeline (or filters to a
// project that cannot start). j and k walk the rows, Enter opens, a acts.
import { useMemo, useState } from "react";
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
import { buildLineInbox, type InboxKind, type InboxRow } from "../../../../lib/line/lineInbox";
import { useLineAdmission } from "../../map/useLineAdmission";
import type { LineViewProps } from "./types";

/** The tone each group carries: one accent per meaning. */
const TONE: Record<InboxKind, "ask" | "bad" | "warn" | "quiet"> = { decide: "ask", unapproved: "warn", question: "ask", review: "ask", failed: "bad", stalled: "warn", stuck: "quiet" };
const ACTION: Record<InboxKind, string> = { decide: "Decide", unapproved: "Review", question: "Answer", review: "Review", failed: "Open run", stalled: "Open run", stuck: "Settings" };

export function InboxView({ workspace, select, href }: LineViewProps) {
  const { rows: scoped, projects, rollups, admissions, now, project } = workspace;
  const groups = useMemo(() => buildLineInbox({ ...scoped, projects, rollups, admissions, now }), [scoped, projects, rollups, admissions, now]);
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
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
    else if (r.kind === "review") router.push(taskHref(r));
    else if (r.kind === "unapproved" && r.caseId) select({ view: "problems", case: r.caseId, run: null });
    else if (r.kind === "stuck" && r.projectId) router.push(lineSettingsHref({ project: params.get(r.projectId) ?? r.projectId }));
  };
  const open = (r: InboxRow) => {
    if (r.caseId) select({ view: "problems", case: r.caseId, run: null });
    else if (r.kind === "stuck" && r.projectId) select({ project: params.get(r.projectId) ?? r.projectId });
  };

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || !flat.length || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    const i = Math.max(-1, flat.findIndex((r) => r.key === cursor));
    const cur = i >= 0 ? flat[i] : null;
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCursor(flat[Math.min(flat.length - 1, i + 1)].key); }
    else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCursor(flat[Math.max(0, i - 1)].key); }
    else if (e.key === "Enter" && cur) { e.preventDefault(); open(cur); }
    else if (e.key === "a" && cur) { e.preventDefault(); act(cur); }
  });

  if (!groups.length) {
    return <div className="lw-empty" data-line-inbox="empty"><b>Nothing waits for you</b>{project ? project.title : "Every project"}</div>;
  }
  return (
    <div className="lwi" data-line-inbox={flat.length}>
      {groups.map((g) => (
        <section key={g.kind} className="lwi-group" data-tone={TONE[g.kind]} data-line-inbox-group={g.kind}>
          <h2 className="lwi-group-h"><span className="lw-dot" aria-hidden />{g.label}<span className="lw-num">{g.rows.length}</span></h2>
          <ul className="lwi-rows">
            {g.rows.map((r) => (
              <li key={r.key} className="lwi-row" data-cursor={r.key === cursor ? "" : undefined} data-line-inbox-row={r.kind} onMouseEnter={() => setCursor(r.key)}>
                <button type="button" className="lwi-main" onClick={() => open(r)}>
                  <span className="lwi-ref">{r.ref ?? ""}</span>
                  <span className="lwi-title">{r.title}</span>
                  {r.detail && <span className="lwi-detail">{r.detail}</span>}
                </button>
                {r.kind === "stuck"
                  ? <span className="lwi-meta lw-num" title={`${r.waiting} waiting`}>{r.waiting}</span>
                  : <span className="lwi-meta">{!project && r.projectId ? titles.get(r.projectId) ?? "" : ""}</span>}
                <span className="lwi-age lw-num">{r.at ? ageShort(now - r.at) : ""}</span>
                <span className="lwi-act">
                  {r.kind === "stuck" && r.projectId && r.switchOff ? <TurnOn projectId={r.projectId} />
                    : r.kind === "decide" && r.cardId ? <Link className="lw-act" data-primary="" href={decisionHref({ _id: r.cardId, short_id: r.cardRef ?? undefined } as never)}>{ACTION.decide}</Link>
                    : r.kind === "review" ? <Link className="lw-act" href={taskHref(r)}>{ACTION[r.kind]}</Link>
                    : r.kind === "question" && r.caseId ? <a className="lw-act" data-primary="" href={href({ view: "problems", case: r.caseId, run: null, ask: "1" })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); act(r); }}>{ACTION.question}</a>
                    : <button type="button" className="lw-act" onClick={() => act(r)}>{ACTION[r.kind]}</button>}
                </span>
              </li>
            ))}
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

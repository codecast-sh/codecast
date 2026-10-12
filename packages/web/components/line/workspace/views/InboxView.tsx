"use client";
// Inbox (line-workspace.md LW1): what waits on the viewer across the line, one
// row per thing, grouped by what to do (lib/line/lineInbox). A row names the
// thing itself (the problem, the question, why the run failed) and carries one
// action; clicking the row opens the problem's timeline (or filters to a
// project that cannot start). A problem holding on a person leads with what it
// asks; a new one is confirmed or dropped in place. Failed runs group by the
// station they stopped at and how (one line per cause, its problems under it
// when opened), so twenty runs that looped at the same step read as one thing
// to fix. A trial card (a trial run paused at its gate) carries its answers as
// buttons; Revise takes a note under the row; the row opens the card on /trial.
// j and k walk the rows, Enter opens, a acts.
import { Fragment, useMemo, useState } from "react";
import { ChevronRight, Flag } from "lucide-react";
import { useCollectionRows } from "../../../../hooks/useCollectionRows";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEventListener } from "../../../../hooks/useEventListener";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { hasOpenModal } from "../../../../shortcuts";
import { controlFocused, keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { ageShort } from "../../../../lib/lineFlow";
import { lineSettingsHref } from "../../../../lib/lineSettings";
import { lineFilterParam } from "../../../../lib/line/lineWorkspaceUrl";
import { groupFailures, type FailureGroup, type InboxKind, type InboxRow } from "../../../../lib/line/lineInbox";
import { sourceChipWords } from "../../../../lib/line/stepRuns";
import { setLineOn } from "../../map/useLineAdmission";
import type { LineAdmission } from "../../../../lib/lineFlow";
import { answerProblem } from "./timeline/ProblemHead";
import { useInboxStore } from "../../../../store/inboxStore";
import { useTrialCards } from "../../../../hooks/useSyncTrial";
import { verdictOfOption } from "@codecast/shared/contracts/changeCard";
import { TrialCardPanel } from "./TrialCardPanel";
import { LineDecision } from "../../widgets/LineDecision";
import "./trialCards.css";
import type { LineViewProps } from "./types";

/** The tone each group carries: one accent per meaning. */
const TONE: Record<InboxKind, "ask" | "bad" | "warn" | "quiet"> = { decide: "ask", trial: "ask", unapproved: "warn", confirm: "ask", question: "ask", review: "ask", failed: "bad", stalled: "warn", watching: "quiet", stuck: "quiet" };
const ACTION: Record<InboxKind, string> = { decide: "Decide", trial: "Open card", unapproved: "Review", confirm: "Confirm", question: "Answer", review: "Review", failed: "Open run", stalled: "Open run", watching: "Open", stuck: "Settings" };

/** Confirm asks that are one thing: a duplicate set, else problems whose findings cite one rule. Most findings first. */
type ConfirmGroup = { key: string; rows: InboxRow[]; findings: number };

/** A line the keys walk: a row, a failure cause standing for its runs, or a group of confirm asks. */
type Item = { key: string; row?: InboxRow; cause?: FailureGroup; confirm?: ConfirmGroup };

export function InboxView({ model, workspace, selection, select, href, pinned }: LineViewProps) {
  const { projects, now, project, inbox: groups, sources } = workspace;
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const failures = useMemo(() => groupFailures(groups.find((g) => g.kind === "failed")?.rows ?? []), [groups]);
  const confirms = useMemo<ConfirmGroup[]>(() => {
    const by = new Map<string, InboxRow[]>();
    for (const r of groups.find((g) => g.kind === "confirm")?.rows ?? []) {
      const o = r.caseId ? workspace.overlaps.get(r.caseId) : undefined;
      const k = o && o.set.length > 1 ? `dup:${o.primary}` : o?.rule ? `rule:${o.rule}` : r.key;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    return [...by].map(([key, rows]) => {
      const sorted = [...rows].sort((a, b) => (b.findings ?? 0) - (a.findings ?? 0) || (b.at ?? 0) - (a.at ?? 0));
      return { key, rows: sorted, findings: sorted.reduce((n, r) => n + (r.findings ?? 0), 0) };
    }).sort((a, b) => b.findings - a.findings || b.rows.length - a.rows.length);
  }, [groups, workspace.overlaps]);
  const flat = useMemo<Item[]>(() => groups.flatMap((g): Item[] => g.kind === "failed"
    ? failures.flatMap((c): Item[] => [{ key: `cause:${c.key}`, cause: c }, ...(opened.has(c.key) ? c.rows.map((row) => ({ key: row.key, row })) : [])])
    : g.kind === "confirm"
    ? confirms.flatMap((c): Item[] => (c.rows.length === 1 ? [{ key: c.rows[0].key, row: c.rows[0] }] : [{ key: `confirm:${c.key}`, confirm: c }, ...(opened.has(c.key) ? c.rows.map((row) => ({ key: row.key, row })) : [])]))
    : g.rows.map((row) => ({ key: row.key, row }))), [groups, failures, confirms, opened]);
  // A rule by the words of the expectation it names: the project's own expectation text, else a "Not met: …" title a judge filed under it.
  const expectations = useCollectionRows<{ _id: string; doc?: { items?: Array<{ id: string; text: string }> } }>("projectExpectations", { sig: expSig });
  const ruleNames = useMemo(() => {
    const out = new Map<string, string>();
    const short = (t: string) => { const first = t.match(/^.+?[,;:.](?=\s)/)?.[0].replace(/[,;:.]$/, "") ?? t; return first.length > 48 ? `${first.slice(0, 47).trimEnd()}…` : first; };
    for (const row of expectations) for (const it of row.doc?.items ?? []) if (!out.has(it.id)) out.set(it.id, short(it.text));
    for (const f of workspace.rows.signals as ReadonlyArray<{ subject?: string; title: string }>) {
      if (!f.subject || out.has(f.subject)) continue;
      const m = /^Not met:\s*(.+)$/.exec(f.title);
      if (m) out.set(f.subject, short(m[1]));
    }
    return out;
  }, [workspace.rows.signals, expectations]);
  const toggle = (k: string) => setOpened((was) => { const next = new Set(was); if (!next.delete(k)) next.add(k); return next; });
  const openStep = (c: FailureGroup) => { if (c.step) select({ view: "process", mode: "graph", step: c.step }); };
  const titles = useMemo(() => new Map(projects.map((p) => [p._id, p.title])), [projects]);
  // The project's address as the project filter writes it (lineFilterParam), so both name a project the same way.
  const params = useMemo(() => new Map(projects.map((p) => [p._id, lineFilterParam(p, projects)])), [projects]);
  const [cursor, setCursor] = useState<string | null>(null);
  const router = useRouter();
  const active = useTabActive();
  const trialAnswer = useInboxStore((s) => s.trialAnswer);
  /** The trial row whose Revise is open, taking its note. */
  const [revising, setRevising] = useState<string | null>(null);
  /** The trial row whose Ship waits for a second press: its card has a red check. */
  const [arming, setArming] = useState<string | null>(null);
  const cards = useTrialCards();
  const card = selection.card ? cards.find((c) => c.short_id === selection.card || c._id === selection.card) ?? null : null;
  const openCard = (ref: string) => select({ card: selection.card === ref ? null : ref, decision: null });
  // A fix decision opens in place beside the list (LineDecision): one named by ?decision=, or the
  // session decision a trial card is. TrialCardPanel stays for a trial card its station never posted.
  const decisionRef = selection.decision ?? card?.decision?.short_id ?? card?.decision?._id ?? null;
  const openDecision = (ref: string) => select({ decision: selection.decision === ref ? null : ref, card: null });
  const closeSide = () => select({ card: null, decision: null });

  const taskHref = (r: InboxRow) => `/tasks/${r.ref ?? r.caseId}`;
  /** Where a row's one action goes: a link, or a select in the app. */
  const act = (r: InboxRow) => {
    if (r.kind === "trial" && r.cardRef) openCard(r.cardRef);
    else if (r.kind === "decide" && r.cardId) openDecision(r.cardRef ?? r.cardId);
    else if ((r.kind === "failed" || r.kind === "stalled") && r.runId) select({ view: "runs", run: r.runId }, r.caseId);
    else if (r.kind === "question" && r.caseId) select({ view: "problems", case: r.caseId, run: null, ask: "1" });
    else if (r.kind === "confirm" && r.ref) answerProblem(r.ref, "confirmed");
    else if (r.kind === "review") router.push(taskHref(r));
    else if (r.kind === "unapproved" && r.caseId) select({ view: "problems", case: r.caseId, run: null });
    else if (r.kind === "stuck" && r.projectId) router.push(lineSettingsHref({ project: params.get(r.projectId) ?? r.projectId }));
  };
  const open = (r: InboxRow) => {
    if (r.kind === "trial" || (r.kind === "decide" && r.cardId)) act(r);
    else if (r.caseId) select({ view: "problems", case: r.caseId, run: null });
    // Pinned to a project, a stuck row has no filter to narrow: it opens its settings, as its action does.
    else if (r.kind === "stuck" && r.projectId) { if (pinned) act(r); else select({ project: params.get(r.projectId) ?? r.projectId }); }
  };

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!active || !flat.length || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
    // A focused control (a button, a link, a switch) takes Enter and Space itself: the cursor row's action never runs over it.
    if ((e.key === "Enter" || e.key === " ") && controlFocused(e.target)) return;
    const i = Math.max(-1, flat.findIndex((r) => r.key === cursor));
    const cur = i >= 0 ? flat[i] : null;
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCursor(flat[Math.min(flat.length - 1, i + 1)].key); }
    else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCursor(flat[Math.max(0, i - 1)].key); }
    else if (e.key === "Enter" && cur) { e.preventDefault(); if (cur.cause) toggle(cur.cause.key); else if (cur.confirm) toggle(cur.confirm.key); else if (cur.row) open(cur.row); }
    else if (e.key === "a" && cur) { e.preventDefault(); if (cur.cause) openStep(cur.cause); else if (cur.confirm) confirmAll(cur.confirm, "confirmed"); else if (cur.row) act(cur.row); }
    else if (e.key === "Escape" && (selection.card || selection.decision)) { e.preventDefault(); closeSide(); }
  });

  const confirmAll = (c: ConfirmGroup, how: "confirmed" | "dropped") => { for (const r of c.rows) if (r.ref) answerProblem(r.ref, how); };
  const rowOf = (r: InboxRow, nested?: boolean) => (
    <li key={r.key} className="lwi-row" aria-current={(r.kind === "trial" && r.cardRef === card?.short_id) || (r.kind === "decide" && !!decisionRef && (r.cardRef === decisionRef || r.cardId === decisionRef)) ? "true" : undefined} data-nested={nested ? "" : undefined} data-ask={r.ask ? "" : undefined} data-cursor={r.key === cursor ? "" : undefined} data-line-inbox-row={r.kind} onMouseEnter={() => setCursor(r.key)} onFocus={() => setCursor(r.key)}>
      <button type="button" className="lwi-main" onClick={() => open(r)} title={r.kind === "trial" ? `${r.cardRef} on ${r.ref ?? "a problem"}\n${r.ask}\n${r.title}` : r.ask ? `${r.ask}\n${r.title}` : r.fail ? `${r.title}\n${r.fail.raw}` : r.detail ? `${r.title}\n${r.detail}` : r.title}>
        <span className="lwi-ref">{(r.kind === "trial" ? r.cardRef : r.ref) ?? ""}</span>
        {r.findings != null && <Findings n={r.findings} />}
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
        {r.kind === "trial" && r.cardId && r.options?.length ? (
          <>
            {!!r.failing && <span className="lwt-red" title="Checks on the card that failed" data-line-trial-red={r.failing}>{r.failing} red</span>}
            {r.options.map((o) => {
              // Shipping past a red check takes a second press; the recommended answer leads.
              const risky = !!r.failing && verdictOfOption(o.label) === "ship";
              const armed = risky && arming === r.key;
              return (
                <button key={o.key} type="button" className="lw-act" data-primary={o.key === r.recommend ? "" : undefined} data-armed={armed ? "" : undefined} aria-expanded={isRevise(o.key) ? revising === r.key : undefined}
                  title={o.key === r.recommend ? "Recommended" : risky ? `${r.failing} check${r.failing === 1 ? "" : "s"} failed: press twice to ship` : undefined}
                  onBlur={() => { if (armed) setArming(null); }}
                  onClick={() => (isRevise(o.key) ? setRevising(revising === r.key ? null : r.key) : risky && !armed ? setArming(r.key) : (setArming(null), trialAnswer(r.cardId!, o.key, null)))} data-line-trial-answer={`${r.cardRef}:${o.key}`}>{armed ? `${o.label} anyway` : o.label}</button>
              );
            })}
          </>
        )
          : r.kind === "stuck" && r.projectId && r.switchOff ? <TurnOn admission={workspace.admissions.get(r.projectId)} projectId={r.projectId} />
          : r.kind === "watching" ? null
          : r.kind === "decide" && r.cardId ? <button type="button" className="lw-act" data-primary="" onClick={() => act(r)} data-line-inbox-decide={r.cardRef ?? r.cardId}>{ACTION.decide}</button>
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
  const list = (
    <div className="lwi" data-line-inbox={flat.length}>
      {groups.map((g) => (
        <section key={g.kind} className="lwi-group" data-tone={TONE[g.kind]} data-kind={g.kind} data-line-inbox-group={g.kind}>
          <h2 className="lwi-group-h"><span className="lw-dot" aria-hidden />{g.label}<span className="lw-num">{g.rows.length}</span>{g.kind === "confirm" && confirms.length < g.rows.length && <span className="lwi-group-sub lw-num">{confirms.length} groups</span>}</h2>
          <ul className="lwi-rows">
            {g.kind === "trial" ? g.rows.map((r) => (
              <Fragment key={r.key}>
                {rowOf(r)}
                {revising === r.key && r.cardId && <ReviseNote onSend={(note) => { trialAnswer(r.cardId!, "R", note); setRevising(null); }} onCancel={() => setRevising(null)} />}
              </Fragment>
            ))
            : g.kind === "confirm" ? confirms.map((c) => {
              if (c.rows.length === 1) return rowOf(c.rows[0]);
              const k = `confirm:${c.key}`;
              const isOpen = opened.has(c.key);
              const lead = c.rows[0];
              return (
                <Fragment key={k}>
                  <li className="lwi-row lwi-cause" data-open={isOpen ? "" : undefined} data-cursor={k === cursor ? "" : undefined} data-line-inbox-confirm-group={c.rows.length} onMouseEnter={() => setCursor(k)} onFocus={() => setCursor(k)}>
                    <button type="button" className="lwi-main" aria-expanded={isOpen} onClick={() => toggle(c.key)} title={c.rows.map((r) => `${r.ref} ${r.title}`).join("\n")}>
                      <ChevronRight className="lwi-caret" aria-hidden />
                      <Findings n={c.findings} />
                      <span className="lwi-cause-label">{lead.title}</span>
                      <span className="lwi-cause-n lw-num">{c.rows.length} problems</span>
                      <span className="lwi-detail" title={c.key.startsWith("rule:") ? c.key.slice(5) : undefined}>{c.key.startsWith("dup:") ? "same problem" : ruleNames.get(c.key.slice(5)) ?? c.key.slice(5).replace(/^ex-/, "")}</span>
                    </button>
                    <span className="lwi-src">{(() => { const src = lead.caseId ? sources.get(lead.caseId) : undefined; return src ? <span className="lw-srcchip">{sourceChipWords(src)}</span> : null; })()}</span>
                    <span className="lwi-meta" />
                    <span className="lwi-age lw-num">{lead.at ? ageShort(now - lead.at) : ""}</span>
                    <span className="lwi-act">
                      <button type="button" className="lw-act" data-primary="" onClick={() => confirmAll(c, "confirmed")} data-line-inbox-confirm-all={c.rows.length}>Confirm all</button>
                      <button type="button" className="lw-act" onClick={() => confirmAll(c, "dropped")}>Not a problem</button>
                    </span>
                  </li>
                  {isOpen && c.rows.map((r) => rowOf(r, true))}
                </Fragment>
              );
            })
            : g.kind !== "failed" ? g.rows.map((r) => rowOf(r)) : failures.map((c) => {
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
  if (decisionRef) {
    return (
      <div className="lwi-split" data-wide="" data-line-inbox-decision={decisionRef}>
        {list}
        <LineDecision key={decisionRef} id={decisionRef} onClose={closeSide}
          onProblem={(taskId) => select({ view: "problems", case: taskId, run: null, decision: null })}
          onRun={(runId, taskId) => select({ view: "runs", run: runId, decision: null }, taskId)} />
      </div>
    );
  }
  if (!card) return list;
  return (
    <div className="lwi-split" data-line-inbox-card={card.short_id}>
      {list}
      <TrialCardPanel card={card} now={now} onClose={() => select({ card: null })}
        onProblem={() => select({ view: "problems", case: card.task_id, run: null })} onRun={() => select({ view: "runs", run: card.run_id }, card.task_id)} />
    </div>
  );
}

/** Revise is the answer that takes words: the option keyed R (convex lineTrial). */
const isRevise = (key: string) => key.toUpperCase() === "R";

/** Revise's note, under its row: Enter sends, Esc closes. */
function ReviseNote({ onSend, onCancel }: { onSend: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  const send = () => { if (note.trim()) onSend(note.trim()); };
  return (
    <li className="lwt-note" data-line-trial-revise>
      <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What to change"
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }} />
      <button type="button" className="lw-act" data-primary="" disabled={!note.trim()} onClick={send}>Revise</button>
      <button type="button" className="lw-act" onClick={onCancel}>Cancel</button>
    </li>
  );
}

/** The one fix for a project whose line is switched off: turn it on, in place, through the workspace's own admission (useLineAdmissions). */
function TurnOn({ admission: a, projectId }: { admission: LineAdmission | undefined; projectId: string }) {
  if (!a?.role) return null;
  return (
    <button type="button" className="lw-act" data-primary="" aria-pressed={a.on} onClick={() => setLineOn(a.role!.id, !a.on)} data-line-inbox-turn-on={projectId}>
      {a.on ? "On" : "Turn on"}
    </button>
  );
}

const expSig = (r: { _id: string; doc?: { items?: unknown[] } }) => `${r._id}|${r.doc?.items?.length ?? 0}`;

/** A problem's findings as a badge: the glyph says what the number counts. */
function Findings({ n }: { n: number }) {
  return <span className="lwi-n lw-num" title={`${n} ${n === 1 ? "finding" : "findings"}`}><Flag aria-hidden className="lwi-n-glyph" />{n}</span>;
}

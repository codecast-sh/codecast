// The hover card of a deploy reference, and a merged change's production
// reach on its pill and in its card (EntityIdPill): did it finish, fail or is
// it still going, since when, and which deploy each target runs.
import React, { useContext, useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { actionsRunKey } from "@codecast/shared/contracts/deploys";
import { deployNoteHeadline } from "@codecast/shared/contracts/lineDeploy";
import { EntityIdPill } from "../EntityIdPill";
import { ShortId } from "../ShortId";
import { fmtClock } from "../triggerCadence";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { useDeployReach } from "../../hooks/useDeployReach";
import { FAILED_ICON, REACH_ICON, TONE_TEXT, deployLook } from "../../lib/deploys/deployLook";
import { REACH_LOOK, deployAgo, deployElapsed, deployHeadline, deployStepLabel, reachTime, replacedLine } from "../../lib/deploys/deployPill";
import { deploysFocusHref, focusOfRef } from "../../lib/deploys/focus";
import { entityRoute } from "../../lib/entityLinks";
import { findEntityInStore } from "../../lib/liveEntities";
import { HoverCardClose } from "../../lib/hoverCardsOff";
import { RevealHostCtx } from "../../lib/revealHost";
import { useInboxStore } from "../../store/inboxStore";

// A step's dot: done is filled, the running one a ring, so the two part in
// either theme without color alone.
const STEP_DOT: Record<string, string> = {
  completed: "bg-sol-green",
  running: "ring-[1.5px] ring-inset ring-sol-yellow",
  failed: "bg-sol-red",
  pending: "ring-1 ring-inset ring-sol-text-dim/60",
};

// A deploy reference answers: did it finish, fail, or is it still going, and
// since when; then where it went, which version, who sent it, the step it is
// on and what it carried. Its own links (the carried fixes, the run on
// GitHub), so it is not wrapped in the card's one link.
export function DeployHoverContent({ deploy: d, href, onOpen, showOpen }: { deploy: any; href: string; onOpen: (e: React.MouseEvent) => void; showOpen: boolean }) {
  const steps: Array<{ id: string; status: string; started_at?: number; completed_at?: number }> = d.steps ?? [];
  const current = steps.find((x) => x.status === "running") ?? steps.find((x) => x.status === "failed") ?? null;
  const stepTime = (t: number) => (current?.started_at ? deployElapsed((current.status === "running" ? t : current.completed_at ?? t) - current.started_at) : null);
  const ended = (d.status === "failed" || d.status === "cancelled") && d.finished_at ? d.finished_at : null;
  const replaced = d.replaced_by as { short_id: string; sha?: string | null; at: number; rollback?: boolean } | null | undefined;
  const now = useNowWhen((t) => `${deployHeadline(d, t, fmtClock)}|${stepTime(t) ?? ""}|${ended ? deployAgo(ended, t) : ""}|${replaced ? deployAgo(replaced.at, t) : ""}`, 15_000);
  const { state, tone: toneName, Icon, iconClass } = deployLook(d, now);
  const tone = TONE_TEXT[toneName];
  const by = state === "replaced" && replaced ? replacedLine(replaced, now) : null;
  const startedBy = typeof d.started_by === "string" ? d.started_by : d.started_by?.name;
  const facts = [d.target, d.repository].filter(Boolean) as string[];
  // A deploy the line sent lists what it carried; one from the Deploys page's feed lists the tasks its commits named.
  const carried: string[] = (d.carries ?? []).map((c: any) => c.task_short_id).filter(Boolean);
  const fixes = d.carries?.length ?? d.tasks?.length ?? 0;
  const refs = carried.length ? carried : (d.tasks ?? []).map((t: any) => t.short_id).filter(Boolean);
  const run = actionsRunKey(d.url) || /^https:\/\/github\.com\//i.test(d.url ?? "") ? d.url : null;
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-start gap-2">
        <Icon className={`w-3.5 h-3.5 flex-shrink-0 mt-[3px] ${tone} ${iconClass}`} />
        <div className="min-w-0 flex-1">
          {/* What replaced it is a deploy of its own, linked, so the line is not inside the card's link. */}
          <div className={`text-sm font-medium leading-snug ${state === "replaced" || state === "cancelled" || (state === "waiting" && toneName !== "orange") ? "text-sol-text" : tone}`}>
            {by && replaced ? (
              <>
                {by.verb}{" "}
                <Link href={entityRoute("deploy", replaced.short_id) ?? "#"} onClick={onOpen} title={replaced.short_id} className="font-mono underline decoration-current/30 underline-offset-2 hover:decoration-current">{by.label}</Link>
                <span className="font-normal text-sol-text-muted"> · {by.ago}</span>
              </>
            ) : (
              <Link href={href} onClick={onOpen} className="no-underline">{deployHeadline(d, now, fmtClock)}</Link>
            )}
          </div>
          <Link href={href} onClick={onOpen} className="block no-underline cursor-pointer">
            <div className="flex items-center gap-1.5 mt-1 text-meta text-sol-text-muted min-w-0">
              {facts.map((f, i) => (
                <React.Fragment key={f}>
                  {i > 0 && <span className="text-sol-text-dim/60">·</span>}
                  <span className={i === 0 ? "text-sol-text-secondary font-medium shrink-0" : "truncate"}>{f}</span>
                </React.Fragment>
              ))}
              {d.sha && (
                <>
                  <span className="text-sol-text-dim/60">·</span>
                  <span className="font-mono shrink-0">{d.sha.slice(0, 7)}</span>
                </>
              )}
            </div>
            <div className="mt-0.5 text-meta text-sol-text-dim truncate">
              {startedBy ? `started by ${startedBy} · ` : "started "}{fmtClock(d.created_at, now)}
              {ended ? ` · ended ${deployAgo(ended, now)}` : ""}
            </div>
          </Link>
        </div>
      </div>
      {(steps.length > 0 || (state === "failed" && d.note)) && <Link href={href} onClick={onOpen} className="block no-underline cursor-pointer space-y-2">
        {steps.length > 0 && (
          <div className="flex items-center gap-2 pl-[22px] text-meta">
            <span className="inline-flex items-center gap-1">
              {steps.map((x) => (
                <span key={x.id} title={`${deployStepLabel(x.id)} · ${STEP_WORD[x.status] ?? x.status}`} className={`block w-1.5 h-1.5 rounded-full ${STEP_DOT[x.status] ?? STEP_DOT.pending}`} />
              ))}
            </span>
            {current && (
              <span className={current.status === "failed" ? "text-sol-red" : "text-sol-text-muted"}>
                {deployStepLabel(current.id)}
                {stepTime(now) ? ` · ${stepTime(now)}` : ""}
              </span>
            )}
          </div>
        )}
        {state === "failed" && d.note && <p title={d.note} className="pl-[22px] text-meta text-sol-red line-clamp-3 leading-relaxed">{deployNoteHeadline(d.note)}</p>}
      </Link>}
      {fixes > 0 && (
        <RevealHostCtx.Provider value={null}>
          <div className="flex items-baseline gap-1.5 pl-[22px] text-meta text-sol-text-muted min-w-0 flex-wrap">
            <span>carries {fixes} {fixes === 1 ? "fix" : "fixes"}</span>
            {refs.slice(0, 2).map((r: string) => <EntityIdPill key={r} shortId={r} compact />)}
            {refs.length > 2 && <span className="text-sol-text-dim">+{refs.length - 2}</span>}
          </div>
        </RevealHostCtx.Provider>
      )}
      <div className="flex items-center gap-3 pt-1 border-t border-sol-border/40 text-meta text-sol-text-dim">
        <ShortId id={d.short_id} className="mr-auto" />
        {run && (
          <a href={run} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 no-underline text-sol-text-dim hover:text-sol-text">
            View run on GitHub <ArrowUpRight className="w-2.5 h-2.5" />
          </a>
        )}
        {showOpen && (
          <Link href={href} onClick={onOpen} className="inline-flex items-center gap-0.5 no-underline text-sol-text-dim hover:text-sol-text">
            Open <ArrowUpRight className="w-2.5 h-2.5" />
          </Link>
        )}
      </div>
    </div>
  );
}

const STEP_WORD: Record<string, string> = { completed: "done", running: "running", failed: "failed", pending: "waiting" };

/** A deploy in a target's reach row: its sha, else its dp-N, linking to it. A row cached before reach carried the sha looks it up. */
function ReachDeployLink({ deploy }: { deploy: { short_id: string; sha?: string | null } }) {
  const sha = useMemo(
    () => deploy.sha ?? (findEntityInStore(useInboxStore.getState(), "deploy", deploy.short_id) as { sha?: string | null } | undefined)?.sha,
    [deploy.sha, deploy.short_id],
  );
  const closeCard = useContext(HoverCardClose);
  return (
    <Link href={entityRoute("deploy", deploy.short_id) ?? "#"} onClick={() => closeCard?.()} title={deploy.short_id} className="font-mono no-underline text-sol-text-muted hover:text-sol-text hover:underline">
      {sha ? sha.slice(0, 7) : deploy.short_id}
    </Link>
  );
}

// Where a merged pull request or main commit stands in production, one row
// per deploy target it touches: the target, the state, the deploy (its sha,
// linking to it) and the time that state began. Its own links, so the card
// draws it between its own.
export function ProductionReach({ refId }: { refId: string }) {
  const reach = useDeployReach(refId, false);
  const targets = reach?.targets ?? [];
  // Each target opens Deploys there with this change highlighted.
  const link = focusOfRef(refId);
  const now = useNowWhen((t) => targets.map((x) => { const at = reachTime(x); return at ? deployAgo(at.at, t) : ""; }).join("|"), 15_000);
  if (!targets.length) return null;
  return (
    <div className="pl-[22px]">
      <div className="text-mark uppercase tracking-wide text-sol-text-dim mb-0.5">Production</div>
      <div className="grid grid-cols-[auto_auto_auto_1fr] items-baseline gap-x-2 gap-y-0.5 text-meta">
        {targets.map((t) => {
          const look = REACH_LOOK[t.state];
          const Icon = REACH_ICON[t.state];
          const time = reachTime(t);
          return (
            <React.Fragment key={t.target}>
              {link ? <Link href={deploysFocusHref({ repository: link.repository, target: t.target, focus: link.focus })} className="text-sol-text-secondary font-medium whitespace-nowrap hover:underline" data-reach-target={t.target}>{t.target}</Link> : <span className="text-sol-text-secondary font-medium whitespace-nowrap">{t.target}</span>}
              <span className={`inline-flex items-baseline gap-1 whitespace-nowrap ${TONE_TEXT[look.tone]}`}>
                <Icon aria-hidden className={`w-3 h-3 shrink-0 self-center ${t.state === "failed" ? FAILED_ICON : ""}`} />
                {look.word}
              </span>
              <span>{t.deploy && <ReachDeployLink deploy={t.deploy} />}</span>
              <span className="text-sol-text-dim whitespace-nowrap text-right">{time ? `${time.verb ? `${time.verb} ` : ""}${deployAgo(time.at, now)}` : ""}</span>
              {t.now && t.state !== "live" && t.state !== "going_out" && (
                <span className="col-start-2 col-span-3 text-sol-text-dim">now runs <ReachDeployLink deploy={t.now} /></span>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

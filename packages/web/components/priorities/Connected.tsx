// An open milestone: everything it is connected to, grouped by kind under a
// labelled count. Sessions sort the way the sidebar files them (needs you,
// working, sleeping, idle, then the most recent), closed ones last: on the
// list folded under "› n closed", on the priority's own page (`flat`) listed
// with the rest, the shipped ones first. A settled session whose work reached
// main reads Shipped, with Done's mark (lib/priorityList sessionRowStatus). Then
// tasks in the app's task-status vocabulary (dropped struck through), pull
// requests, branches, plans and deploys. Each row opens its thing; the owner
// fixes a session's link from its ⋯.
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, Map as MapIcon, Workflow } from "lucide-react";
import type { PriorityPlanRef } from "@codecast/shared/contracts/priorities";
import { entityRoute } from "@codecast/shared/entities";
import { isClosedSession, orderByState } from "@codecast/shared/contracts/priorityDerive";
import { SessionStatusMark } from "../inbox/SessionStatusMark";
import { Mark } from "../Mark";
import { taskStatusMarkId } from "../../lib/marks/work";
import { taskVisual } from "../TaskStatusBadge";
import { useEntityResolution } from "../../lib/entityDisplay";
import { ago, sessionRowStatus, type MilestoneModel, type PriorityModel, type SessionLine } from "../../lib/priorityList";
import { SESSION_STATUS, type SessionStatus } from "../../lib/sessionStatus";
import { cn } from "../../lib/utils";
import { branchesOf, type LinkLookups } from "../../hooks/usePriorityModels";
import { SessionMenu } from "./controls";
import { DeployMark, UnknownTaskMark } from "./parts";

const stop = (e: React.MouseEvent) => e.stopPropagation();
const age = (t: number, now: number) => { const a = ago(t, now); return a === "just now" ? a : `${a} ago`; };
const LABEL = "text-mark font-semibold uppercase tracking-wide text-sol-text-dim";
/** A row: 28px, 44px under a coarse pointer. */
const ROW = "flex min-h-7 min-w-0 items-center gap-2 [@media(pointer:coarse)]:min-h-11";
/** A row's link fills the row, so a press anywhere on its 44px opens it. */
const ROW_LINK = "flex min-w-0 flex-1 items-center gap-2 self-stretch";
/** A title on one line on a mouse; on a narrow list or a touch screen it wraps onto a second, as milestone titles do. */
const TITLE_WRAP = "[@container(max-width:40rem)]:line-clamp-2 [@container(max-width:40rem)]:whitespace-normal [@media(pointer:coarse)]:line-clamp-2 [@media(pointer:coarse)]:whitespace-normal";


/** A workflow step's title as what it works on: "Review · ct-9 tidy" reads "Review: <task title>", never its id. */
function useSessionLabel(s: Pick<SessionLine, "title">): string {
  const m = /^([A-Z][A-Za-z]+) · ((?:ct|pl)-\d+)\s*(.*)$/.exec(s.title);
  const ref = useEntityResolution(m?.[2] ?? "", m ? (m[2].startsWith("pl-") ? "plan" : "task") : undefined);
  if (!m) return s.title || "Untitled session";
  const named = (ref.entity as { title?: string } | null)?.title;
  return `${m[1]}: ${named || m[3] || "work"}`;
}

export function Connected({ model, m, now, lookups, flat }: {
  model: PriorityModel;
  m: MilestoneModel;
  now: number;
  lookups: LinkLookups;
  /** The priority's own page: closed sessions listed after the live ones, not folded. */
  flat?: boolean;
}) {
  const [closedOpen, setClosedOpen] = useState(false);
  const rows = orderByState(m.sessions).map((s) => ({ s, ...sessionRowStatus(s) }));
  const live = rows.filter((r) => !isClosedSession(r.s));
  // Shipped before merely closed; each keeps the sidebar's order (sort is stable).
  const closed = rows.filter((r) => isClosedSession(r.s)).sort((a, b) => Number(!a.shipped) - Number(!b.shipped));
  const plans: Array<{ plan: PriorityPlanRef; partOf?: boolean }> = [
    // Only a plan of the milestone's own: the priority's plan would repeat under every milestone.
    ...(m.plan && m.plan.short_id !== model.plan?.short_id ? [{ plan: m.plan }] : []),
    ...m.partOf.map((plan) => ({ plan, partOf: true })),
  ];
  const branches = branchesOf(m, lookups);
  const deploys = lookups.deploysOf(m, model.row.workspace);
  const menu = (s: SessionLine) => (model.row.mine && s.mine ? <SessionMenu row={model.row} s={s} stepKey={m.key} /> : undefined);
  const nSessions = m.sessions.length + m.more;
  const empty = nSessions + m.tasks.length + m.prs.length + branches.length + plans.length + deploys.length === 0;
  return (
    <ul data-connected className="mb-2 ml-3 border-l border-sol-border/60 py-1 pl-4" onClick={stop}>
      <Group kind="sessions" label="Sessions" n={nSessions}>
        {(flat ? [...live, ...closed] : live).map((r) => <SessionItem key={r.s.conversation_id} {...r} now={now} menu={menu(r.s)} />)}
        {!flat && closed.length > 0 && (
          <li>
            <button type="button" data-closed-sessions aria-expanded={closedOpen} onClick={() => setClosedOpen((o) => !o)} className={cn(ROW, "text-meta text-sol-text-dim hover:text-sol-text")}>
              <ChevronRight className={cn("size-3 transition-transform", closedOpen && "rotate-90")} aria-hidden />{closed.length} closed
            </button>
            {closedOpen && <ul>{closed.map((r) => <SessionItem key={r.s.conversation_id} {...r} now={now} menu={menu(r.s)} />)}</ul>}
          </li>
        )}
        {m.more > 0 && (
          <li className={ROW}>
            {/* A count, not a way in: no page lists them yet. */}
            <span data-older-sessions className="text-meta text-sol-text-dim">+{m.more} older {m.more === 1 ? "session" : "sessions"}</span>
          </li>
        )}
      </Group>
      <Group kind="tasks" label="Tasks" n={m.tasks.length}>{m.tasks.map((t) => <TaskItem key={t} id={t} />)}</Group>
      <Group kind="prs" label="Pull requests" n={m.prs.length}>{m.prs.map((p) => <PrItem key={p} pr={p} state={lookups.prState(p)} />)}</Group>
      <Group kind="branches" label="Branches" n={branches.length}>
        {branches.map((b) => <Item key={b} data-branch={b} icon={<Mark id="git.branch" labeled><GitBranch className="size-3.5 text-sol-text-dim" aria-hidden /></Mark>} title={<span className="font-mono text-meta">{b}</span>} />)}
      </Group>
      <Group kind="plans" label="Plans" n={plans.length}>
        {plans.map(({ plan, partOf }) => (
          <Item key={plan.short_id} href={`/plans/${plan.short_id}`} icon={<Mark id="entity.plan" labeled><MapIcon className="size-3.5 text-sol-text-dim" aria-hidden /></Mark>} title={plan.title} meta={`${partOf ? "part of · " : ""}${plan.done}/${plan.total}`} />
        ))}
      </Group>
      <Group kind="deploys" label="Deploys" n={deploys.length}>
        {deploys.map((d) => (
          <Item key={d.id} href={(d.short_id && entityRoute("deploy", d.short_id)) || "/deploys"} icon={<DeployMark status={d.status} labeled />} title={d.target} meta={`${d.status} · ${age(d.at, now)}`} />
        ))}
      </Group>
      {empty && <li className="py-1 text-meta text-sol-text-dim">Nothing connected yet</li>}
    </ul>
  );
}

/** A group: its label and count, then its rows; nothing when it has none. */
function Group({ kind, label, n, children }: { kind: string; label: string; n: number; children: ReactNode }) {
  if (!n) return null;
  return (
    <li data-group={kind} className="pt-1.5 first:pt-0">
      <div className={cn("flex h-5 items-center gap-1.5", LABEL)}>{label}<span className="font-normal tabular-nums">{n}</span></div>
      <ul>{children}</ul>
    </li>
  );
}

function Item({ icon, title, meta, href, menu, ...data }: { icon: ReactNode; title: ReactNode; meta?: ReactNode; href?: string; menu?: ReactNode } & Record<`data-${string}`, string>) {
  const body = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span data-item-title className={cn("min-w-0 truncate text-ui text-sol-text", TITLE_WRAP)}>{title}</span>
      {meta && <span className="shrink-0 whitespace-nowrap text-meta text-sol-text-dim">{meta}</span>}
    </>
  );
  return (
    <li {...data} className={cn(ROW, "group/session")}>
      {href ? <Link href={href} className={cn(ROW_LINK, "decoration-sol-text-dim/50 hover:underline")}>{body}</Link> : body}
      {menu}
    </li>
  );
}

function SessionItem({ s, mark, shipped, now, menu }: { s: SessionLine; mark: SessionStatus; shipped: boolean; now: number; menu?: ReactNode }) {
  const label = useSessionLabel(s);
  const asks = mark === "needs_you";
  // Every row draws its inbox's mark; a workflow run says what it is with a small glyph beside its word.
  return (
    <Item
      data-session-row={s.conversation_id}
      data-state={s.state}
      data-row-mark={mark}
      data-shipped={shipped || undefined}
      href={s.href}
      icon={<SessionStatusMark status={mark} size={12} labeled />}
      title={label}
      meta={<>
        {s.workflow && <Mark id="inbox.flow" className="mr-1 align-[-2px]"><Workflow data-workflow-hint className="size-3 text-sol-text-dim" aria-label="Workflow run" /></Mark>}
        <span className={asks ? "font-medium text-sol-yellow" : undefined}>{shipped ? "Shipped" : SESSION_STATUS[mark].word}</span> · {age(s.last_active_at, now)}
      </>}
      menu={menu}
    />
  );
}

/** A task in the task-status vocabulary; dropped is struck through. Until its row loads it has no status to draw: a neutral dot, never Open. */
function TaskItem({ id }: { id: string }) {
  const r = useEntityResolution(id, "task");
  const t = r.entity as { title?: string; status?: string } | null;
  const v = taskVisual(t?.status);
  const Icon = v.icon;
  const closed = t?.status === "done" || t?.status === "dropped";
  return (
    <Item
      href={`/tasks/${id}`}
      icon={t
        ? <Mark id={taskStatusMarkId(t.status)}><span className={v.color} data-task-status={t.status ?? "open"}><Icon className="size-3.5" /></span></Mark>
        : <UnknownTaskMark />}
      title={<span className={cn(closed && "text-sol-text-dim", t?.status === "dropped" && "line-through decoration-sol-text-dim/60")}>{t?.title || id}</span>}
    />
  );
}

const PR = {
  open: { Icon: GitPullRequest, color: "text-sol-green" },
  merged: { Icon: GitMerge, color: "text-sol-violet" },
  closed: { Icon: GitPullRequestClosed, color: "text-sol-red" },
} as const;

function PrItem({ pr, state }: { pr: string; state?: string }) {
  const [repo, n] = pr.split("#");
  const st = state === "merged" || state === "closed" ? state : "open";
  const { Icon, color } = PR[st];
  return (
    <li className={ROW}>
      <Link href={entityRoute("pr", pr) ?? `/pr/${repo}/${n}`} data-pr={pr} className={cn(ROW_LINK, "hover:underline")}>
        <span className="flex size-4 shrink-0 items-center justify-center"><Mark id={`pr.${st}`} labeled><Icon className={cn("size-3.5", color)} aria-hidden /></Mark></span>
        <span className="text-ui tabular-nums text-sol-text">#{n}</span>
        <span className="min-w-0 truncate text-meta text-sol-text-dim">{repo.split("/")[1]} · {st}</span>
      </Link>
    </li>
  );
}

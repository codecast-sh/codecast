// The pull request a session is shepherding, as one chip.
//
// The inbox card and the thread state panel above the composer both show it,
// so it lives here once. The number says which PR; the glyph after it says
// what the PR is waiting for (its word is the tooltip, never a label on the
// chip), and its color says whether that is the reader's problem.
// Green means nothing is blocking, red means something broke, orange and
// yellow mean it is waiting on a person or on CI. In the panel, a merged one
// also shows how far it has gone toward production, as the reach's glyph.
import React, { useState } from "react";
import Link from "next/link";
import { GitPullRequest } from "lucide-react";
import { accentSoft, accentVar, prPath, shepherdStyle, type ExternalEventAccent } from "../lib/externalEvents";
import { CI_WORDS, LINKED_PR_LOOK, showsCi, type LinkedPr, type LinkedPrCi } from "../lib/sessionPullRequests";
import type { PrStatus } from "../store/inboxStore";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { KEEP_DRAG_OFF_CARD, KEEP_OFF_CARD } from "../lib/keepOffCard";
import { repoObjectId } from "../lib/entityLinks";
import { useDeployReach } from "../hooks/useDeployReach";
import { REACH_LOOK, type DeployTone } from "../lib/deploys/deployPill";
import { REACH_ICON } from "../lib/deploys/deployLook";
import { PR_STATE_GLYPH } from "../lib/prStateGlyph";

const TONE_ACCENT: Record<DeployTone, ExternalEventAccent> = { green: "green", yellow: "yellow", red: "red", orange: "orange", muted: "muted", dim: "muted" };

export function PrStatusChip({
  status,
  size = "card",
  className = "",
  look,
  ci = null,
  hover,
  plain = false,
}: {
  status: PrStatus | null | undefined;
  size?: "card" | "panel";
  className?: string;
  /** The state (a PR_STATE_GLYPH key), its word for the tooltip, and its color, when the chip shows a pull request's own state rather than its shepherd's. */
  look?: { state: string; label: string; accent: ExternalEventAccent };
  /** A checks dot after the number. */
  ci?: LinkedPrCi;
  hover?: string;
  /** Draw the face only, for a row that is itself the link. */
  plain?: boolean;
}) {
  if (!status) return null;
  const state = look?.state ?? status.state ?? "open";
  const { label, accent } = look ?? shepherdStyle(status.state);
  const glyph = PR_STATE_GLYPH[state] ?? {};
  const Pr = glyph.pr ?? GitPullRequest;
  const After = glyph.after;
  const icon = size === "panel" ? "w-3 h-3" : "w-2.5 h-2.5";
  const href = prPath({ repository: status.repository, number: status.number });
  const body = (
    <>
      <Pr aria-hidden className={`${icon} shrink-0`} />
      <span className="tabular-nums">#{status.number}</span>
      {ci && !After && <span data-pr-ci={ci} aria-hidden className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: accentVar(CI_WORDS[ci].accent) }} />}
      {After && <After aria-hidden data-pr-state={state} className={`${icon} shrink-0`} strokeWidth={state === "ci_red" || state === "failing" ? 3 : 2.25} />}
      {label && <span className="sr-only">{label}</span>}
      {/* The panel above the composer reads a merged pull request's reach live. A card,
          drawn from props alone, shows none: the row it would read can be days old. */}
      {size === "panel" && status.state === "merged" && (
        <ChipReach refId={repoObjectId({ type: "pr", repository: status.repository, number: status.number })} className={icon} />
      )}
    </>
  );
  const chip = `inline-flex items-center gap-[3px] px-1 py-0 rounded border font-semibold text-meta ${className}`;
  const style = {
    color: accentVar(accent),
    background: accentSoft(accent, 12),
    borderColor: accentSoft(accent, 35),
  };
  const title = hover ?? `${status.repository} #${status.number}${status.title ? ` — ${status.title}` : ""}${look ? "" : `\n${shepherdStyle(status.state).phrase}`}`;
  if (!href || plain) {
    return (
      <span className={chip} style={style} title={title}>
        {body}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className={`${chip} hover:brightness-110`}
      style={style}
      title={title}
      // The chip sits inside a clickable session card; opening the PR must not
      // also open the session behind it.
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </Link>
  );
}

/** A merged pull request's reach on the panel's chip: its glyph in its tone, its word for screen readers, or nothing. */
function ChipReach({ refId, className }: { refId: string; className: string }) {
  const reach = useDeployReach(refId);
  if (!reach) return null;
  const look = REACH_LOOK[reach.state];
  const Icon = REACH_ICON[reach.state];
  return (
    <span data-pr-reach={reach.state} className="inline-flex items-center" style={{ color: accentVar(TONE_ACCENT[look.tone]) }}>
      <Icon aria-hidden className={`${className} shrink-0`} />
      <span className="sr-only">{look.word}</span>
    </span>
  );
}

function linkedPrHover(pr: LinkedPr): string {
  const state = LINKED_PR_LOOK[pr.state].label;
  const ci = showsCi(pr) && pr.ci ? `, ${CI_WORDS[pr.ci].words}` : "";
  const how = pr.tier === "committed" ? "Has this session's commits" : "This session was on its branch";
  return `${pr.repository} #${pr.number}${pr.title ? ` — ${pr.title}` : ""}\n${state[0].toUpperCase()}${state.slice(1)}${ci}\n${how}`;
}

function LinkedChip({ pr, size, plain }: { pr: LinkedPr; size: "card" | "panel"; plain?: boolean }) {
  const look = LINKED_PR_LOOK[pr.state];
  const failing = pr.ci === "failure" && pr.state === "open";
  return (
    <PrStatusChip
      size={size}
      plain={plain}
      className={`shrink-0 ${pr.tier === "observed" ? "border-dashed opacity-75" : ""}`}
      status={{ pr_id: pr.id, repository: pr.repository, number: pr.number, title: pr.title, state: pr.state, at: 0 }}
      look={failing ? { state: "failing", label: "failing", accent: "red" } : { state: pr.state, ...look }}
      ci={showsCi(pr) ? pr.ci : null}
      hover={linkedPrHover(pr)}
    />
  );
}

/**
 * Every pull request a session links (lib/sessionPullRequests), one chip each:
 * its state in the word and color, its checks as a dot while it is open, a
 * dashed edge when the session only sat on its branch. The one the session
 * shepherds is left out, since its own chip says more. Past `max`, a count
 * opens the whole list.
 */
export function LinkedPrChips({
  prs,
  shepherdedId,
  size = "card",
  max = 2,
  className = "",
  inCard = true,
}: {
  prs: readonly LinkedPr[];
  shepherdedId?: string | null;
  size?: "card" | "panel";
  max?: number;
  className?: string;
  /** Drawn inside a draggable session card, whose drag a press here must not start. */
  inCard?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shown = shepherdedId ? prs.filter((p) => p.id !== String(shepherdedId)) : prs;
  if (!shown.length) return null;
  // Where chips have room (max of two or more), a count that stands for one
  // chip takes the chip's place; a tight row keeps the count.
  const limit = max >= 2 && shown.length === max + 1 ? shown.length : max;
  const head = shown.slice(0, limit);
  const rest = shown.slice(limit);
  return (
    <span data-linked-prs={shown.length} className={`inline-flex items-center gap-1 min-w-0 ${className}`}>
      {head.map((pr) => <LinkedChip key={pr.id} pr={pr} size={size} />)}
      {rest.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-linked-prs-more={rest.length}
              {...(inCard ? KEEP_DRAG_OFF_CARD : KEEP_OFF_CARD)}
              aria-label={`${shown.length} linked pull requests`}
              title={`${shown.length} linked pull requests`}
              className="shrink-0 inline-flex items-center gap-0.5 px-1 rounded text-meta tabular-nums text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight"
            >
              <GitPullRequest aria-hidden className="w-2.5 h-2.5" />
              +{rest.length}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1.5rem))] p-1" {...KEEP_OFF_CARD}>
            <div className="max-h-[min(22rem,60vh)] overflow-y-auto" data-linked-prs-list>
              {/* "panel" so a merged row reads its reach live, as the chips beside the count do:
                  the list mounts only while open, so the read is fresh, not a card's stale row. */}
              {shown.map((pr) => (
                <PrListRow key={pr.id} repository={pr.repository} number={pr.number} title={pr.title} onOpen={() => setOpen(false)} chip={<LinkedChip pr={pr} size="panel" plain />} />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}

/** A row of the full list: the chip, then the title. */
function PrListRow({ repository, number, title, chip, onOpen }: { repository: string; number: number; title?: string | null; chip: React.ReactNode; onOpen: () => void }) {
  const href = prPath({ repository, number });
  const row = "flex items-center gap-2 px-2 py-1 rounded min-w-0";
  const body = (
    <>
      {chip}
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-sol-text-secondary">{title ?? repository}</span>
    </>
  );
  return href
    ? <Link href={href} draggable={false} onClick={(e) => { e.stopPropagation(); onOpen(); }} className={`${row} hover:bg-sol-bg-highlight`}>{body}</Link>
    : <div className={row}>{body}</div>;
}

/**
 * The panel above the composer: every pull request the session touches, as
 * one stack. The lead (the shepherded one, else the most pressing link) shows
 * its chip; the rest sit behind it as card edges in their own colors, with a
 * count. Alone, the chip is the link; stacked, a press opens the whole list.
 */
export function PrStack({ shepherd, prs }: { shepherd: PrStatus | null | undefined; prs: readonly LinkedPr[] }) {
  const [open, setOpen] = useState(false);
  const total = (shepherd ? 1 : 0) + prs.length;
  if (!total) return null;
  const lead = shepherd ? <PrStatusChip status={shepherd} size="panel" plain={total > 1} /> : <LinkedChip pr={prs[0]} size="panel" plain={total > 1} />;
  if (total === 1) return <span className="shrink-0 inline-flex">{lead}</span>;
  const behind = (shepherd ? prs : prs.slice(1)).slice(0, 2);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-pr-stack={total}
          aria-label={`${total} pull requests`}
          title={`${total} pull requests`}
          className="group/stack shrink-0 inline-flex items-center gap-1 rounded hover:brightness-110"
        >
          <span className="relative inline-flex">
            {behind.map((pr, i) => {
              const accent = LINKED_PR_LOOK[pr.state].accent;
              const step = (behind.length - i) * 2;
              return (
                <span
                  key={pr.id}
                  aria-hidden
                  className="absolute inset-0 rounded border transition-transform duration-150 ease-out"
                  style={{ transform: `translate(${step}px, -${step}px)`, borderColor: accentSoft(accent, 30), background: "var(--sol-bg)", zIndex: i }}
                />
              );
            })}
            <span className="relative" style={{ zIndex: behind.length }}>{lead}</span>
          </span>
          <span className="pl-1 text-meta tabular-nums text-sol-text-dim group-hover/stack:text-sol-text-muted">+{total - 1}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1.5rem))] p-1">
        <div className="max-h-[min(22rem,60vh)] overflow-y-auto" data-pr-stack-list>
          {shepherd && (
            <PrListRow repository={shepherd.repository} number={shepherd.number} title={shepherd.title} onOpen={() => setOpen(false)} chip={<PrStatusChip status={shepherd} plain />} />
          )}
          {prs.map((pr) => (
            <PrListRow key={pr.id} repository={pr.repository} number={pr.number} title={pr.title} onOpen={() => setOpen(false)} chip={<LinkedChip pr={pr} size="card" plain />} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

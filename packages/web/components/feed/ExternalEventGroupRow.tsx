// One row for a day's events on one thread of work: a pull request, or a
// branch. The feed shows the thread as a sentence of counts ("3 checks failed
// · merges cleanly · PR updated · rebased") with the pills the members share,
// and opens into the member rows on a click. A thread with a single event is
// that event's own row, so a quiet day reads exactly as before.
import React, { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { EntityIdPill } from "../EntityIdPill";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { relTimeShort, formatDateFull } from "../../lib/utils";
import {
  accentSoft,
  accentVar,
  commitPath,
  externalEventRowToExternalEvent,
  externalEventStyle,
  prPath,
  shortSha,
  type ExternalEventGroup,
} from "../../lib/externalEvents";
import { AccentWord, ActorFace, ExternalEventRow, Pill } from "./ExternalEventRow";

const MAX_FACES = 3;

export function ExternalEventGroupRow({
  group,
  onNavigate,
  className = "",
}: {
  group: ExternalEventGroup;
  onNavigate?: (path: string) => void;
  className?: string;
}) {
  const now = useCoarseNow(60_000);
  const [open, setOpen] = useState(false);
  const events = useMemo(() => group.events.map(externalEventRowToExternalEvent), [group.events]);

  if (events.length === 1) {
    return <ExternalEventRow event={events[0]} density="feed" onNavigate={onNavigate} className={className} />;
  }

  const lead = group.phrases[0];
  // The rail wears the color of the phrase that leads: red for failures,
  // green for a clean merge, and the ordinary blue of moving code otherwise.
  const leadKind = lead.kind === "pr_check_failed" ? "pr_check" : lead.kind;
  const style = externalEventStyle(leadKind);
  const accent = lead.accent ?? style.accent;
  const Icon = style.icon;

  const actors = uniqueBy(events.map((e) => e.actor).filter(Boolean), (a) => a!.user_id ?? a!.login ?? a!.name ?? "");
  const sessions = uniqueBy(events.map((e) => e.refs.session_id).filter((id): id is string => !!id), (id) => id);
  const pr = events.find((e) => e.refs.pr)?.refs.pr;
  const commit = events.find((e) => e.refs.commit)?.refs.commit;
  const branch = group.events.find((e) => e.branch)?.branch;
  const newest = events[0];
  const oldest = events[events.length - 1];

  return (
    <div className={`group relative ${className}`} data-event-group={group.key}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="flex items-start gap-2 px-1 py-1 rounded outline-none cursor-pointer focus-visible:ring-1 focus-visible:ring-sol-blue/50 hover:bg-sol-bg-alt/30 transition-colors"
      >
        <span
          className="mt-[1px] w-[17px] h-[17px] rounded-full flex items-center justify-center flex-shrink-0 border"
          style={{ background: accentSoft(accent), borderColor: accentSoft(accent, 40) }}
        >
          <Icon className="w-2.5 h-2.5" style={{ color: accentVar(accent) }} />
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap text-[11px] leading-5">
            {actors.length > 0 ? (
              <span className="inline-flex items-center flex-shrink-0 self-center">
                <span className="inline-flex items-center -space-x-1">
                  {actors.slice(0, MAX_FACES).map((a, i) => (
                    <ActorFace key={a!.user_id ?? a!.login ?? i} actor={a} size={14} />
                  ))}
                </span>
                {actors.length === 1 && (actors[0]!.name || actors[0]!.login) ? (
                  <span className="ml-1 text-sol-text-muted">{actors[0]!.name || actors[0]!.login}</span>
                ) : actors.length > MAX_FACES ? (
                  <span className="ml-1 text-sol-text-dim">+{actors.length - MAX_FACES}</span>
                ) : null}
              </span>
            ) : null}
            {group.phrases.map((p, i) => (
              <React.Fragment key={p.kind}>
                {i > 0 ? <span className="text-sol-text-dim/50">·</span> : null}
                {p.accent ? (
                  <AccentWord accent={p.accent}>{p.text}</AccentWord>
                ) : (
                  <span className="text-sol-text">{p.text}</span>
                )}
              </React.Fragment>
            ))}
            {branch ? (
              <span className="font-mono text-[10px] text-sol-text-dim/80 flex-shrink-0 truncate max-w-[16rem]">{branch}</span>
            ) : null}
            <span className="inline-flex items-center gap-0.5 text-[10px] text-sol-text-dim flex-shrink-0">
              <ChevronRight className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} />
              {events.length} events
            </span>
            <span
              className="ml-auto text-[10px] text-sol-text-dim tabular-nums flex-shrink-0 pl-1"
              title={`${formatDateFull(oldest.at)} to ${formatDateFull(newest.at)}`}
            >
              {relTimeShort(newest.at, now)}
            </span>
          </div>

          <div className="flex items-center gap-1 flex-wrap mt-1 empty:mt-0" onClick={(e) => e.stopPropagation()}>
            {sessions.slice(0, 2).map((id) => (
              <EntityIdPill key={id} id={id} type="session" />
            ))}
            {pr ? (
              <Pill href={prPath(pr)} onNavigate={onNavigate} title={pr.repository}>
                #{pr.number}
              </Pill>
            ) : null}
            {commit ? (
              <Pill href={commitPath(commit)} onNavigate={onNavigate} title={commit.sha}>
                <span className="font-mono">{shortSha(commit.sha)}</span>
              </Pill>
            ) : null}
          </div>
        </div>
      </div>

      {open ? (
        <div className="ml-[25px] mt-0.5 pl-2 border-l border-sol-border/20 space-y-0.5">
          {events.map((event) => (
            <ExternalEventRow key={event.id} event={event} density="feed" onNavigate={onNavigate} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export default ExternalEventGroupRow;

// One row for every event that came from outside codecast.
//
// A git push in a transcript, a failed check in the team feed, a review on a
// task page and (later) a Linear issue move all render through this. The
// surface decides the density; the event decides everything else.
//
// The look is deliberately quiet. This row sits between two messages in a
// transcript, so it reads as a margin note: a tinted dot on the rail, one line
// of text, and pills only for the objects the reader might want to open. The
// color carries the meaning that matters at a glance — a red dot is a failed
// check, and nothing else on the row has to shout.
import React, { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { AvatarImg } from "../../lib/avatarCache";
import { hueFor, initials } from "../../lib/avatarInitials";
import { EntityIdPill } from "../EntityIdPill";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { relTimeShort, formatDateFull } from "../../lib/utils";
import {
  accentSoft,
  accentVar,
  commitPath,
  eventAccent,
  externalEventStyle,
  filePath,
  prPath,
  shortSha,
  type ExternalEvent,
  type ExternalEventRef,
} from "../../lib/externalEvents";

export type ExternalEventDensity = "transcript" | "feed" | "card" | "compact";

export type ExternalEventRowProps = {
  event: ExternalEvent;
  density: ExternalEventDensity;
  showActor?: boolean;
  onNavigate?: (path: string) => void;
  /** Refs the surface already IS — a task page does not need a task pill. */
  omitRefs?: Array<keyof ExternalEventRef>;
  className?: string;
};

// A pill: same chrome for every ref kind, so a row of them reads as one row.
function Pill({
  children,
  href,
  external,
  onNavigate,
  title,
}: {
  children: React.ReactNode;
  href?: string | null;
  external?: boolean;
  onNavigate?: (path: string) => void;
  title?: string;
}) {
  const cls =
    "inline-flex items-center gap-1 px-1.5 h-[18px] rounded border border-sol-border/25 bg-sol-bg-alt/50 text-[10px] text-sol-text-muted hover:text-sol-text hover:border-sol-border/50 transition-colors max-w-[16rem] truncate";
  if (!href) return <span className={cls} title={title}>{children}</span>;
  if (external) {
    return (
      <a className={cls} href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  if (onNavigate) {
    return (
      <button type="button" className={cls} title={title} onClick={() => onNavigate(href)}>
        {children}
      </button>
    );
  }
  return (
    <Link className={cls} href={href} title={title}>
      {children}
    </Link>
  );
}

function ActorFace({ actor, size }: { actor: ExternalEvent["actor"]; size: number }) {
  const name = actor?.name || actor?.login || "";
  const px = { width: size, height: size };
  const fallback = (
    <span
      className="inline-flex items-center justify-center rounded-full text-[8px] font-medium text-white flex-shrink-0"
      style={{ ...px, background: hueFor(name || "?") }}
    >
      {initials(name, 1)}
    </span>
  );
  if (!actor) return null;
  return (
    <AvatarImg
      src={actor.avatar_url}
      alt={name}
      className="rounded-full flex-shrink-0"
      style={px}
      fallback={fallback}
    />
  );
}

/** The one word a check or a review adds, in its own color. */
function OutcomeWord({ event }: { event: ExternalEvent }) {
  const meta = event.meta ?? {};
  const word =
    (typeof meta.conclusion === "string" && meta.conclusion) ||
    (typeof meta.review_state === "string" && meta.review_state.toLowerCase()) ||
    (typeof meta.status === "string" && meta.status) ||
    "";
  if (!word) return null;
  const accent = eventAccent(event);
  return (
    <span
      className="px-1 rounded text-[10px] font-medium flex-shrink-0"
      style={{ color: accentVar(accent), background: accentSoft(accent, 12) }}
    >
      {word.replace(/_/g, " ")}
    </span>
  );
}

export function ExternalEventRow({
  event,
  density,
  showActor = true,
  onNavigate,
  omitRefs,
  className = "",
}: ExternalEventRowProps) {
  const now = useCoarseNow(60_000);
  const [expanded, setExpanded] = useState(false);
  const style = externalEventStyle(event.kind);
  const accent = eventAccent(event);
  const Icon = style.icon;
  const compact = density === "compact";
  const card = density === "card";
  const meta = event.meta ?? {};

  const omitted = useMemo(() => new Set(omitRefs ?? []), [omitRefs]);
  const has = useCallback(
    (key: keyof ExternalEventRef) => !omitted.has(key) && event.refs[key] !== undefined,
    [omitted, event.refs],
  );

  // The row's own destination: the codecast page for the thing that changed,
  // falling back to the provider's page when we host no view of it.
  const primaryHref =
    prPath(event.refs.pr) ?? commitPath(event.refs.commit) ?? event.refs.issue?.url ?? event.url ?? null;
  const primaryIsExternal = !primaryHref?.startsWith("/");

  const open = useCallback(() => {
    if (!primaryHref) return;
    if (primaryIsExternal) window.open(primaryHref, "_blank", "noopener,noreferrer");
    else if (onNavigate) onNavigate(primaryHref);
    else window.location.assign(primaryHref);
  }, [primaryHref, primaryIsExternal, onNavigate]);

  const actorName = event.actor?.name || event.actor?.login;
  const summary = event.summary;
  const showSummary = summary && !compact && (density !== "feed" || expanded || summary.length < 90);

  // Push events say how much moved; a check says which check.
  const detail = useMemo(() => {
    const bits: string[] = [];
    if (typeof meta.check_name === "string" && meta.check_name) bits.push(meta.check_name);
    if (typeof meta.commit_count === "number" && meta.commit_count > 0) {
      bits.push(`${meta.commit_count} commit${meta.commit_count === 1 ? "" : "s"}`);
    }
    if (typeof meta.files_changed === "number" && meta.files_changed > 0) {
      bits.push(`${meta.files_changed} file${meta.files_changed === 1 ? "" : "s"}`);
    }
    if (typeof meta.behind_by === "number" && meta.behind_by > 0) bits.push(`${meta.behind_by} behind`);
    return bits.join(" · ");
  }, [meta]);

  const branch = typeof meta.branch === "string" ? meta.branch : undefined;

  return (
    <div
      data-event-kind={event.kind}
      data-event-source={event.source}
      tabIndex={0}
      role="group"
      aria-label={`${style.verb} ${event.title}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={[
        "group relative flex items-start gap-2 outline-none",
        "focus-visible:ring-1 focus-visible:ring-sol-blue/50 rounded",
        card ? "border border-sol-border/20 bg-sol-card/60 rounded-md px-2.5 py-2" : "px-1 py-1",
        className,
      ].join(" ")}
    >
      {/* The rail: a tinted disc carrying the kind's icon. */}
      <span
        className="mt-[1px] w-[17px] h-[17px] rounded-full flex items-center justify-center flex-shrink-0 border"
        style={{ background: accentSoft(accent), borderColor: accentSoft(accent, 40) }}
      >
        <Icon className="w-2.5 h-2.5" style={{ color: accentVar(accent) }} />
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap text-[11px] leading-5">
          {showActor && event.actor ? (
            <span className="inline-flex items-center gap-1 flex-shrink-0 self-center">
              <ActorFace actor={event.actor} size={14} />
              {actorName ? <span className="text-sol-text-muted">{actorName}</span> : null}
            </span>
          ) : null}
          <span className="text-sol-text-dim flex-shrink-0">{style.verb}</span>
          {primaryHref ? (
            primaryIsExternal ? (
              <a
                href={primaryHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sol-text hover:text-sol-link truncate min-w-0"
              >
                {event.title}
              </a>
            ) : (
              <Link href={primaryHref} className="text-sol-text hover:text-sol-link truncate min-w-0">
                {event.title}
              </Link>
            )
          ) : (
            <span className="text-sol-text truncate min-w-0">{event.title}</span>
          )}
          <OutcomeWord event={event} />
          {detail ? <span className="text-sol-text-dim/80 flex-shrink-0">{detail}</span> : null}
          {branch ? (
            <span className="font-mono text-[10px] text-sol-text-dim/80 flex-shrink-0">{branch}</span>
          ) : null}
          <span
            className="ml-auto text-[10px] text-sol-text-dim tabular-nums flex-shrink-0 pl-1"
            title={formatDateFull(event.at)}
          >
            {relTimeShort(event.at, now)}
          </span>
        </div>

        {summary && !compact ? (
          <div
            className={`text-[11px] text-sol-text-muted leading-5 ${showSummary ? "whitespace-pre-wrap" : "truncate"} ${
              density === "feed" ? "cursor-pointer" : ""
            }`}
            onClick={density === "feed" ? () => setExpanded((v) => !v) : undefined}
            title={density === "feed" && !expanded ? "Click to expand" : undefined}
          >
            {summary}
          </div>
        ) : null}

        {compact ? null : (
          <div className="flex items-center gap-1 flex-wrap mt-1 empty:mt-0">
            {has("session_id") ? (
              <EntityIdPill id={event.refs.session_id} type="session" />
            ) : null}
            {has("task_id") || has("task_short_id") ? (
              <EntityIdPill shortId={event.refs.task_short_id} id={event.refs.task_id} type="task" />
            ) : null}
            {has("plan_id") ? <EntityIdPill id={event.refs.plan_id} type="plan" /> : null}
            {has("project_id") ? <EntityIdPill id={event.refs.project_id} type="project" /> : null}
            {has("pr") ? (
              <Pill href={prPath(event.refs.pr)} onNavigate={onNavigate} title={event.refs.pr!.repository}>
                #{event.refs.pr!.number}
              </Pill>
            ) : null}
            {has("commit") ? (
              <Pill
                href={commitPath(event.refs.commit)}
                onNavigate={onNavigate}
                title={event.refs.commit!.sha}
              >
                <span className="font-mono">{shortSha(event.refs.commit!.sha)}</span>
              </Pill>
            ) : null}
            {has("file") ? (
              <Pill href={filePath(event.refs.file)} onNavigate={onNavigate} title={event.refs.file!.path}>
                <span className="font-mono truncate">
                  {event.refs.file!.path.split("/").pop()}
                  {event.refs.file!.line ? `:${event.refs.file!.line}` : ""}
                </span>
              </Pill>
            ) : null}
            {has("issue") ? (
              <Pill href={event.refs.issue!.url} external title={event.refs.issue!.provider}>
                {event.refs.issue!.key}
              </Pill>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default ExternalEventRow;

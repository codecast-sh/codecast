import type React from "react";
import { AvatarImg } from "../lib/avatarCache";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AlertTriangle, ArrowUp, Minus, ArrowDown } from "lucide-react";
import { taskVisual } from "./TaskStatusBadge";
import {
  entityRoute,
  isConvexId,
  entityTypeFromId,
  entityReferenceLabel, entityShortLabel,
  parseRepoObjectId,
  type EntityType,
} from "../lib/entityLinks";
import { repoObjectRefOf, repoObjectTitle } from "../lib/repoObjects";
import { findEntityInStore, resolveAssigneeInfo } from "../lib/liveEntities";
import { taskPeople } from "../lib/entityDisplay";
import { useInboxStore } from "../store/inboxStore";
import { FormattedSummary } from "./FormattedSummary";
import { sessionCardSummary } from "../lib/sessionSummary";
import { stripTranscriptTags } from "../lib/notificationText";

const api = _api as any;

// The shared vocabulary of inline object references: status/priority/type maps,
// the small display atoms (avatars, summaries, relative time), and the
// resolution hook that turns a raw id into a live entity. EntityIdPill (the
// inline pill + hover card) and EntityObjectCard (the shared-object preview
// card) both build on exactly these, so an object reads the same wherever it
// appears.

/** `3 files +12 -4` — the change footprint of a pull request or commit. Nothing when nothing is known. */
export function DiffStat({
  additions,
  deletions,
  files,
  className = "",
}: {
  additions?: number | null;
  deletions?: number | null;
  files?: number | null;
  className?: string;
}) {
  if (additions == null && deletions == null && files == null) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[10px] ${className}`}>
      {files != null && <span className="text-sol-text-dim">{files} file{files === 1 ? "" : "s"}</span>}
      {additions != null && additions > 0 && <span className="text-sol-green">+{additions}</span>}
      {deletions != null && deletions > 0 && <span className="text-sol-red">-{deletions}</span>}
    </span>
  );
}

/** The separator between facts on one line. */
export function MetaDot() {
  return <span className="text-[color-mix(in_srgb,var(--sol-text-dim)_60%,transparent)]">·</span>;
}

export type DottedPart = { key: string; node: React.ReactNode; shrink?: boolean };

/**
 * Facts on one wrapping line, dot-separated. Each item is bundled with its
 * leading dot in one non-breaking span, so the line wraps BETWEEN items and a
 * dot can never dangle at a line end; a `shrink` item truncates, every other
 * item keeps its width.
 */
export function DottedRow({ parts, className = "" }: { parts: DottedPart[]; className?: string }) {
  if (parts.length === 0) return null;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-sol-text-muted ${className}`}>
      {parts.map((p, i) => (
        <span key={p.key} className={`inline-flex items-center gap-1.5 ${p.shrink ? "min-w-0" : "flex-shrink-0"}`}>
          {i > 0 && <MetaDot />}
          {p.node}
        </span>
      ))}
    </div>
  );
}

function Person({ person, size }: { person: { name?: string; image?: string | null }; size: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <AuthorAvatar name={person.name} avatar={person.image} size={size} />
      <span className="truncate">{person.name}</span>
    </span>
  );
}

/**
 * Who holds a task and who filed it, on one line: the assignee first, then
 * "filed by" the creator. One person who filed a task for themselves is named
 * once (the tooltip says both roles), never twice. Nothing when nobody is known.
 */
export function TaskPeople({ task, size = 12, className = "" }: { task: any; size?: number; className?: string }) {
  const { creator, assignee, samePerson } = taskPeople(task);
  if (!creator && !assignee) return null;
  const title = samePerson
    ? `Filed by and assigned to ${assignee?.name}`
    : [assignee ? `Assigned to ${assignee.name}` : "Unassigned", creator ? `filed by ${creator.name}` : null].filter(Boolean).join(", ");
  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-sol-text-muted ${className}`} title={title}>
      {assignee ? <Person person={assignee} size={size} /> : <span className="text-sol-text-dim">Unassigned</span>}
      {creator && !samePerson && (
        <span className="inline-flex min-w-0 items-center gap-1 text-sol-text-dim">
          filed by <Person person={creator} size={size} />
        </span>
      )}
    </span>
  );
}

// A teammate's avatar for session references: the author's image, or a colored
// initial circle as fallback.
export function AuthorAvatar({
  name,
  avatar,
  size = 14,
}: {
  name?: string | null;
  avatar?: string | null;
  size?: number | string;
}) {
  const dim = { width: size, height: size };
  const fallbackSize = typeof size === "number" ? Math.round(size * 0.55) : "0.55em";
  return (
    <AvatarImg
      src={avatar}
      alt={name ?? "author"}
      className="rounded-full object-cover ring-1 ring-sol-border/60"
      style={dim}
      fallback={
        <span
          className="inline-flex items-center justify-center rounded-full bg-sol-blue/20 text-sol-blue font-semibold leading-none ring-1 ring-sol-border/60"
          style={{ ...dim, fontSize: fallbackSize }}
        >
          {(name?.charAt(0) || "?").toUpperCase()}
        </span>
      }
    />
  );
}

// Summary + a bit of context for a session reference card: the coalesced
// one-line summary (idle_summary/subtitle, with Goal:/Next: labels bolded) plus
// the last message preview. Reused by the hover popover, the preview card, and
// the inline expand so "opening" a session reference shows what it's about,
// not just its metadata.
export function SessionSummaryBlock({
  session,
  className = "",
  clamp = true,
}: {
  session: any;
  className?: string;
  /** false renders the whole summary/preview — the expanded object card. */
  clamp?: boolean;
}) {
  const summary = sessionCardSummary(session);
  // The raw preview is a transcript slice: strip machine framing, and drop
  // the row when nothing readable survives (a preview that is ALL framing).
  const preview = stripTranscriptTags(session.last_message_preview ?? "");
  const showPreview = preview && preview !== summary;
  const role = session.last_message_role;
  if (!summary && !showPreview) return null;
  return (
    <div className={`space-y-1 ${className}`}>
      {summary && (
        <p className={`text-[11px] text-sol-text-muted leading-relaxed ${clamp ? "line-clamp-3" : ""} whitespace-pre-line`}>
          <FormattedSummary text={summary} />
        </p>
      )}
      {showPreview && (
        <div className="flex items-start gap-1 text-[10px] text-sol-text-dim leading-snug">
          <span className="flex-shrink-0 font-mono text-sol-cyan/60">{role && role !== "user" ? `${role}:` : ">"}</span>
          <span className={`${clamp ? "line-clamp-2" : "whitespace-pre-wrap"} min-w-0`}>{preview}</span>
        </div>
      )}
    </div>
  );
}

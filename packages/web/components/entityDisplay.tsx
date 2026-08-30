import React, { useMemo } from "react";
import { useQuery } from "convex/react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { AvatarImg } from "../lib/avatarCache";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AlertTriangle, ArrowUp, Minus, ArrowDown } from "lucide-react";
import { taskVisual } from "./TaskStatusBadge";
import {
  entityRoute,
  isConvexId,
  entityTypeFromId,
  entityReferenceLabel,
  type EntityType,
} from "../lib/entityLinks";
import { findEntityInStore, resolveAssigneeInfo } from "../lib/liveEntities";
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

// Task status glyph/color/label come from the canonical TASK_STATUS vocabulary
// (TaskStatusBadge, via `taskVisual`). The maps below cover PLAN statuses only.
export const STATUS_COLOR: Record<string, string> = {
  draft: "text-gray-400",
  done: "text-sol-green",
  dropped: "text-gray-500",
  active: "text-sol-green",
  paused: "text-sol-yellow",
  abandoned: "text-gray-500",
};

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  done: "Done",
  dropped: "Dropped",
  active: "Active",
  paused: "Paused",
  abandoned: "Abandoned",
};

export const PRIORITY_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  urgent: { icon: AlertTriangle, color: "text-red-400", label: "Urgent" },
  high: { icon: ArrowUp, color: "text-orange-400", label: "High" },
  medium: { icon: Minus, color: "text-sol-yellow", label: "Medium" },
  low: { icon: ArrowDown, color: "text-sol-blue", label: "Low" },
};

export const TYPE_LABEL: Record<EntityType, string> = {
  task: "Task",
  plan: "Plan",
  session: "Session",
  doc: "Doc",
  project: "Project",
  trigger: "Trigger",
};

/**
 * Pick the right `webGet` argument for an id: a full Convex id resolves by
 * `{ id }`, a short id by `{ short_id }`. Sessions store a 7-char short id, so
 * we trim to that when the id is short. doc/project only ever carry Convex ids.
 */
export function entityQueryArgs(type: EntityType, id: string): { short_id?: string; id?: string } {
  // Only a genuine 32-char Convex id may be resolved by `{ id }` (db.get). A
  // longer-than-short-id but non-Convex string (e.g. a garbled /plans/<id> URL)
  // would otherwise be sent to db.get and throw "Invalid ID length"; routing it
  // through the by_short_id index instead just resolves to null.
  if (isConvexId(id)) return { id };
  if (type === "session") return { short_id: id.slice(0, 7).toLowerCase() };
  if (type === "task" || type === "plan" || type === "trigger") return { short_id: id.toLowerCase() };
  return { id };
}

// Creator (only when it isn't the viewer) and assignee (only when it differs
// from the creator) for task reference surfaces. Names resolve through the same
// roster helper the task page uses; read non-reactively — these cards mount
// fresh, so a subscription would only add churn.
export function taskPeople(task: any) {
  const s = useInboxStore.getState() as any;
  const me = s.currentUser;
  const members = s.teamMembers;
  const myId = me?._id?.toString?.();
  const creatorId = task.user_id?.toString?.();
  const creator =
    creatorId && creatorId !== myId
      ? resolveAssigneeInfo(creatorId, task.creator, members, me)
      : null;
  const assigneeId = task.assignee?.toString?.();
  const assignee =
    assigneeId && assigneeId !== creatorId
      ? resolveAssigneeInfo(assigneeId, task.assignee_info, members, me)
      : null;
  return { creator, assignee };
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
  size?: number;
}) {
  const dim = { width: size, height: size };
  return (
    <AvatarImg
      src={avatar}
      alt={name ?? "author"}
      className="rounded-full object-cover ring-1 ring-sol-border/60"
      style={dim}
      fallback={
        <span
          className="inline-flex items-center justify-center rounded-full bg-sol-blue/20 text-sol-blue font-semibold leading-none ring-1 ring-sol-border/60"
          style={{ ...dim, fontSize: Math.round(size * 0.55) }}
        >
          {(name?.charAt(0) || "?").toUpperCase()}
        </span>
      }
    />
  );
}

export function abbrevModel(model?: string | null): string | null {
  if (!model) return null;
  if (model.includes("fable")) return "Fable";
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  return null;
}

export function relativeTime(ts?: number | null): string | null {
  if (!ts) return null;
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 5) return `${mins}m ago`;
  return "just now";
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

export type EntityResolution = {
  /** The id with any `doc:` prefix stripped — what queries and routes take. */
  rawId: string;
  /** Resolved type, or null while resolveIdType is in flight / for non-entities. */
  type: EntityType | null;
  /** The live row: server answer when it has landed, local store seed before. */
  entity: any;
  /** True once the server has answered (entity may still be null = no access). */
  served: boolean;
  status: string | undefined;
  /** What the reference is CALLED — title, else short id, else type name. */
  label: string;
  /** In-app route for the object (falls back to the raw id pre-resolution). */
  href: string;
};

/**
 * One id in, one live entity out — the resolution every reference surface
 * shares. Local-first: seeds synchronously from the store (non-reactive read;
 * the live webGet subscription is what keeps the row fresh), so a reference to
 * a row this client already holds paints its title on the first frame.
 */
export function useEntityResolution(rawRef: string, typeProp?: EntityType): EntityResolution {
  // `id` keeps its original case (Convex ids are case-sensitive); short-id and
  // prefix matching lowercase internally.
  const trimmed = rawRef.trim();
  // A `doc:<convexId>` reference carries its type in the string itself.
  const isDocRef = !typeProp && /^doc:/i.test(trimmed);
  const rawId = isDocRef ? trimmed.slice(4) : trimmed;
  const looksConvex = isConvexId(rawId);
  // A full Convex id carries no type prefix (and can even start with "jx", so
  // prefix sniffing misclassifies it) — resolve its table server-side instead.
  // Prefix detection is for short ids only.
  // No-throw: this resolver gates every other query, and a reference must
  // degrade to plain text — not crash the view — when the backend doesn't have
  // the function yet (client/deploy skew).
  const { data: resolvedType } = useQueryNoThrow(api.entities.resolveIdType, !typeProp && !isDocRef && looksConvex ? { id: rawId } : "skip");
  const type: EntityType | null =
    typeProp ?? (isDocRef ? "doc" : looksConvex ? resolvedType ?? null : entityTypeFromId(rawId));
  const isTask = type === "task";
  const isPlan = type === "plan";
  const isSession = type === "session";
  const isTrigger = type === "trigger";

  const queryArgs = type ? entityQueryArgs(type, rawId) : null;
  const task = useQuery(api.tasks.webGet, isTask && queryArgs ? queryArgs : "skip");
  const plan = useQuery(api.plans.webGet, isPlan && queryArgs ? queryArgs : "skip");
  const session = useQuery(api.conversations.webGet, isSession && queryArgs ? queryArgs : "skip");
  // No-throw: agentTasks.webGet is newer than some deployed clients, and a
  // conversation must not crash on a trigger reference just because the backend
  // hasn't caught up — the reference degrades to its short id, then fills in.
  const { data: trigger } = useQueryNoThrow(api.agentTasks.webGet, isTrigger && queryArgs ? queryArgs : "skip");
  // docs/projects are only ever addressed by a full Convex id.
  const doc = useQuery(api.docs.webGet, type === "doc" && looksConvex ? { id: rawId } : "skip");
  const project = useQuery(api.projects.webGet, type === "project" && looksConvex ? { id: rawId } : "skip");
  const served = isTask ? task : isPlan ? plan : isSession ? session : isTrigger ? trigger : type === "doc" ? doc : type === "project" ? project : undefined;

  // Local-first: the client usually already holds this row, so paint the title
  // on the FIRST frame instead of flashing the raw id until the query answers.
  // Read once and non-reactively (getState, not a subscription) — a reference
  // must not re-render on the churn of a collection with thousands of rows; the
  // live query above is what keeps the label fresh.
  const seed = useMemo(
    () => (type ? findEntityInStore(useInboxStore.getState(), type, rawId) : undefined),
    [type, rawId],
  );
  const entity: any = served ?? seed;

  // One label rule for every type, shared with mobile: the reference reads as
  // the object's NAME, and the id moves to the detail surfaces. A trigger
  // prefers its display_title — the generated short name, not the whole
  // prompt's first line.
  const resolvedTitle: string | undefined =
    (isTrigger ? entity?.display_title : undefined) || entity?.title || entity?.display_title || entity?.name;
  const label = entityReferenceLabel({
    title: resolvedTitle,
    shortId: entity?.short_id,
    rawId,
    typeLabel: type ? TYPE_LABEL[type] : null,
  });

  // Route that opens this entity. Prefer the resolved Convex id; fall back to
  // the raw id so the link still works in the brief window before the query
  // resolves.
  const href = entityRoute(type ?? "session", entity?._id ?? rawId) ?? "#";

  return { rawId, type, entity, served: served !== undefined, status: entity?.status, label, href };
}

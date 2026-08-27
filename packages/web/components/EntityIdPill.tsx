import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { AvatarImg } from "../lib/avatarCache";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import {
  Target,
  ArrowUpRight,
  AlertTriangle,
  ArrowUp,
  Minus,
  ArrowDown,
  MessageSquare,
  FolderOpen,
  FileText,
  Folder,
  Zap,
} from "lucide-react";
import { taskVisual } from "./TaskStatusBadge";
import { Popover, PopoverContent, PopoverAnchor } from "./ui/popover";
import { stripMarkdown, docContentPreview } from "../lib/notificationText";
import {
  parseEntityUrl,
  parsePublishedPageUrl,
  entityRoute,
  isConvexId,
  isEntityId,
  entityTypeFromId,
  entityMentionRegex,
  entityReferenceLabel,
  type EntityType,
} from "../lib/entityLinks";
import { findEntityInStore, resolveAssigneeInfo } from "../lib/liveEntities";
import { useInboxStore } from "../store/inboxStore";
import { DocEmbed } from "./DocEmbed";
import { FilePathLink } from "./FilePathLink";
import { filePathMention, parseFilePathHref } from "../lib/filePathLinks";
import { PublishedPageEmbed, PublishedPagePill } from "./PublishedPageEmbed";
import { FormattedSummary } from "./FormattedSummary";
import { useOpenLinkedSession } from "../hooks/useOpenLinkedSession";
import { sessionCardSummary } from "../lib/sessionSummary";
import { describeTaskCadence, taskStateLabel } from "./triggerCadence";

const api = _api as any;

export { isEntityId };

// Task status glyph/color/label come from the canonical TASK_STATUS vocabulary
// (TaskStatusBadge, via `taskVisual`) — the StatusCircle "fill" icons, so a
// task reads the same here as on the board. The maps below cover PLAN statuses
// only.

const STATUS_COLOR: Record<string, string> = {
  draft: "text-gray-400",
  done: "text-sol-green",
  dropped: "text-gray-500",
  active: "text-sol-green",
  paused: "text-sol-yellow",
  abandoned: "text-gray-500",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  done: "Done",
  dropped: "Dropped",
  active: "Active",
  paused: "Paused",
  abandoned: "Abandoned",
};

const PRIORITY_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  urgent: { icon: AlertTriangle, color: "text-red-400", label: "Urgent" },
  high: { icon: ArrowUp, color: "text-orange-400", label: "High" },
  medium: { icon: Minus, color: "text-sol-yellow", label: "Medium" },
  low: { icon: ArrowDown, color: "text-sol-blue", label: "Low" },
};

const TYPE_LABEL: Record<EntityType, string> = {
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
function entityQueryArgs(type: EntityType, id: string): { short_id?: string; id?: string } {
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
// from the creator) for the task hover card. Names resolve through the same
// roster helper the task page uses; read non-reactively — the card mounts
// fresh on each hover, so a subscription would only add churn.
function taskPeople(task: any) {
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

function PersonRow({ label, person }: { label: string; person: { name?: string; image?: string | null } }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-gray-500 w-14 flex-shrink-0">{label}</span>
      <AuthorAvatar name={person.name} avatar={person.image} size={12} />
      <span className="text-[10px] text-gray-400 truncate">{person.name}</span>
    </div>
  );
}

function TaskHoverContent({ task }: { task: any }) {
  const { icon: StatusIcon, color: statusColor, label: statusLabel } = taskVisual(task.status);
  const priority = PRIORITY_CONFIG[task.priority];
  const { creator, assignee } = taskPeople(task);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${statusColor}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {task.title || task.short_id}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
            {priority && (
              <>
                <span className="text-gray-600">·</span>
                <span className={`inline-flex items-center gap-0.5 text-[10px] ${priority.color}`}>
                  <priority.icon className="w-2.5 h-2.5" />
                  {priority.label}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {task.description && (
        <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed pl-[22px]">
          {stripMarkdown(task.description).slice(0, 200)}
        </p>
      )}

      {task.plan && (
        <div className="flex items-center gap-1.5 pl-[22px]">
          <Target className="w-2.5 h-2.5 text-sol-cyan flex-shrink-0" />
          <span className="text-[10px] text-sol-cyan truncate">{task.plan.title}</span>
        </div>
      )}

      {(creator || assignee) && (
        <div className="space-y-1 pl-[22px]">
          {creator && <PersonRow label="Creator" person={creator} />}
          {assignee && <PersonRow label="Assignee" person={assignee} />}
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{task.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

function PlanHoverContent({ plan }: { plan: any }) {
  const statusColor = STATUS_COLOR[plan.status || "active"] || "text-gray-400";
  const statusLabel = STATUS_LABEL[plan.status] || plan.status;

  const tasks = plan.tasks || [];
  const doneCount = tasks.filter((t: any) => t.status === "done").length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Target className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${statusColor}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {plan.title || plan.short_id}
          </div>
          <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
        </div>
      </div>

      {plan.goal && (
        <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed pl-[22px]">
          {stripMarkdown(plan.goal).slice(0, 200)}
        </p>
      )}

      {total > 0 && (
        <div className="flex items-center gap-2 pl-[22px]">
          <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full bg-sol-green transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] text-gray-500 font-mono">
            {doneCount}/{total}
          </span>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="space-y-0.5 pl-[22px] max-h-[120px] overflow-y-auto">
          {tasks.slice(0, 6).map((t: any) => {
            const { icon: Icon, color } = taskVisual(t.status);
            return (
              <div key={t._id} className="flex items-center gap-1.5 py-0.5 text-[10px]">
                <Icon className={`w-2.5 h-2.5 flex-shrink-0 ${color}`} />
                <span className={`truncate ${t.status === "done" ? "line-through text-gray-500" : "text-gray-400"}`}>
                  {t.title}
                </span>
              </div>
            );
          })}
          {tasks.length > 6 && (
            <div className="text-[10px] text-gray-500 pt-0.5">+{tasks.length - 6} more</div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{plan.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

// A teammate's avatar for session references: the author's image, or a colored
// initial circle as fallback. Rendered in the pill and hover header only when a
// session isn't the current user's (webGet returns author_* for foreign rows).
function AuthorAvatar({
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

function abbrevModel(model?: string | null): string | null {
  if (!model) return null;
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  return null;
}

function relativeTime(ts?: number | null): string | null {
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
// the last message preview. Reused by the hover popover and the inline expand so
// "opening" a session reference shows what it's about, not just its metadata.
function SessionSummaryBlock({ session, className = "" }: { session: any; className?: string }) {
  const summary = sessionCardSummary(session);
  const preview = session.last_message_preview?.trim();
  const showPreview = preview && preview !== summary;
  const role = session.last_message_role;
  if (!summary && !showPreview) return null;
  return (
    <div className={`space-y-1 ${className}`}>
      {summary && (
        <p className="text-[11px] text-sol-text-muted leading-relaxed line-clamp-3 whitespace-pre-line">
          <FormattedSummary text={summary} />
        </p>
      )}
      {showPreview && (
        <div className="flex items-start gap-1 text-[10px] text-sol-text-dim leading-snug">
          <span className="flex-shrink-0 font-mono text-sol-cyan/60">{role && role !== "user" ? `${role}:` : ">"}</span>
          <span className="line-clamp-2 min-w-0">{preview}</span>
        </div>
      )}
    </div>
  );
}

// Exported for reuse beyond the hover popover — the browser-handoff notice
// (BrowserHandoffToast) embeds the same card so a handed-off session previews
// identically to a session reference.
export function SessionHoverContent({ session }: { session: any }) {
  const isActive = session.status === "active";
  const model = abbrevModel(session.model);
  const projectName = session.project_path?.split("/").pop() ?? null;
  const timeAgo = relativeTime(session.updated_at);
  // webGet returns author_* only when the session belongs to a teammate.
  const isForeign = !!(session.author_name || session.author_avatar);

  const metaParts = [
    session.message_count != null ? `${session.message_count} msgs` : null,
    model,
    timeAgo,
  ].filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <div className="relative flex-shrink-0 mt-0.5">
          {isForeign ? (
            <AuthorAvatar name={session.author_name} avatar={session.author_avatar} size={16} />
          ) : (
            <MessageSquare className="w-3.5 h-3.5 text-sol-blue" />
          )}
          {isActive && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-sol-green border border-sol-bg" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {session.title || session.short_id}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] font-medium ${isActive ? "text-sol-green" : "text-gray-400"}`}>
              {isActive ? "Active" : session.status || "Stopped"}
            </span>
            {session.agent_type && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-[10px] text-gray-400">{session.agent_type}</span>
              </>
            )}
            {isForeign && session.author_name && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-[10px] text-sol-text-muted truncate">{session.author_name}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <SessionSummaryBlock session={session} className="pl-[22px]" />

      {metaParts.length > 0 && (
        <div className="flex items-center gap-2 pl-[22px] text-[10px] text-gray-500 font-mono">
          {metaParts.map((p, i) => (
            <span key={i}>{p}</span>
          ))}
        </div>
      )}

      {projectName && (
        <div className="flex items-center gap-1.5 pl-[22px]">
          <FolderOpen className="w-2.5 h-2.5 text-gray-500 flex-shrink-0" />
          <span className="text-[10px] text-gray-400 font-mono truncate">{projectName}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{session.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

// What a trigger reference has to answer at a glance: what it does, when it
// fires next, and whether its last run went badly. Cadence and state wording
// come from triggerCadence — the same helpers the /triggers rows and the
// conversation strip use, so one trigger reads identically everywhere.
function TriggerHoverContent({ trigger }: { trigger: any }) {
  const cadence = describeTaskCadence(trigger);
  const state = taskStateLabel(trigger, Date.now());
  const failing = trigger.last_run_failed || trigger.last_run_needs_attention;
  const stateColor =
    trigger.status === "paused"
      ? "text-sol-yellow"
      : failing
        ? "text-sol-red"
        : "text-sol-orange";

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Zap className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${stateColor}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {trigger.display_title || trigger.title || trigger.short_id}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] font-medium ${stateColor}`}>{cadence}</span>
            <span className="text-gray-600">·</span>
            <span className="text-[10px] text-gray-400">{state}</span>
          </div>
        </div>
      </div>

      {(trigger.display_summary || trigger.prompt) && (
        <p className="text-[11px] text-gray-400 line-clamp-3 leading-relaxed pl-[22px]">
          {stripMarkdown(trigger.display_summary || trigger.prompt).slice(0, 220)}
        </p>
      )}

      {trigger.last_run_at && (
        <div className="pl-[22px] text-[10px] text-gray-500">
          <span className={failing ? "text-sol-red" : ""}>
            {failing ? "Last run failed" : "Last run"} {relativeTime(trigger.last_run_at)}
          </span>
          {trigger.run_count > 0 && <span className="text-gray-600"> · {trigger.run_count} runs</span>}
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{trigger.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

const MENTION_RE = entityMentionRegex();

function MentionPill({ name, entityId }: { name: string; entityId?: string }) {
  if (entityId?.startsWith("doc:") && entityId.length > 4) {
    return <EntityIdPill type="doc" id={entityId.slice(4)} />;
  }
  if (entityId?.startsWith("label:")) {
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[11px] font-medium leading-[1.4] bg-sol-magenta/10 text-sol-magenta border border-sol-magenta/20 align-baseline">
        @{name}
      </span>
    );
  }
  const namePill = (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[11px] font-medium leading-[1.4] bg-sol-blue/10 text-sol-blue border border-sol-blue/20 align-baseline">
      @{name}
    </span>
  );
  if (entityId && isEntityId(entityId)) {
    return <EntityIdPill shortId={entityId} fallback={namePill} />;
  }
  return namePill;
}

export function renderWithMentions(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const name = match[1].trim();
    const entityId = match[2];
    parts.push(<MentionPill key={match.index} name={name} entityId={entityId} />);
    lastIndex = MENTION_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}

export function EntityAwareCode({ children, className, ...props }: any) {
  const text = String(children);
  // The fallback keeps a non-entity Convex-shaped string (message id, hash)
  // rendered as the inline code it was written as.
  if (!className && isEntityId(text)) {
    return <EntityIdPill shortId={text} fallback={<code className={className} {...props}>{children}</code>} />;
  }
  const code = <code className={className} {...props}>{children}</code>;
  // `lib/foo.ts:38` in backticks — the commonest way an agent names a file.
  // The code span keeps its look; the link wraps it.
  const mention = className ? null : filePathMention(text);
  if (mention) return <FilePathLink path={mention.path} line={mention.line}>{code}</FilePathLink>;
  return code;
}

export function EntityAwareLink({ href, children, ...props }: any) {
  {
    // Transclusion: ![[doc:<id>]] arrives as a link whose TEXT is
    // "embed:doc:<id>" (the embed:// href is dropped by react-markdown's url
    // sanitizer, same as entity:// below). Renders the doc body in full.
    const embedText = typeof children === "string" ? children : Array.isArray(children) ? children.map(String).join("") : String(children ?? "");
    if (embedText.startsWith("embed:doc:") && embedText.length > 10) {
      return <DocEmbed id={embedText.slice(10)} />;
    }
    // A publish URL alone on its own line, hoisted by remarkEntityIds into
    // "embed:artifact:<slug>|<caption>" — the page renders inline.
    if (embedText.startsWith("embed:artifact:")) {
      const payload = embedText.slice("embed:artifact:".length);
      const sep = payload.indexOf("|");
      const slug = sep === -1 ? payload : payload.slice(0, sep);
      const caption = sep === -1 ? undefined : payload.slice(sep + 1);
      if (slug) return <PublishedPageEmbed slug={slug} caption={caption} />;
    }
  }
  if (href?.startsWith("entity://")) {
    const ref = href.slice(9);
    if (ref.startsWith("doc:")) return <EntityIdPill type="doc" id={ref.slice(4)} />;
    return <EntityIdPill shortId={ref} />;
  }
  // A file mention remarkEntityIds turned into a /files?path= link: re-resolve
  // it here, where the conversation's working directory is in context.
  const fileRef = parseFilePathHref(href);
  if (fileRef) return <FilePathLink path={fileRef.path} line={fileRef.line}>{children}</FilePathLink>;
  if (href?.startsWith("mention://")) {
    const name = decodeURIComponent(href.slice(10));
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[11px] font-medium leading-[1.4] bg-sol-blue/10 text-sol-blue border border-sol-blue/20 align-baseline">
        @{name}
      </span>
    );
  }
  const text = typeof children === "string" ? children : Array.isArray(children) ? children.map(String).join("") : String(children ?? "");
  // Docs have no short id, so a doc reference carries "doc:<convexId>" in the
  // link text (the entity:// href is stripped by react-markdown's url
  // sanitizer). This is the markdown twin of the entity:// branch above.
  if (text.startsWith("doc:") && text.length > 4) {
    return <EntityIdPill type="doc" id={text.slice(4)} />;
  }
  if (isEntityId(text)) {
    // Fallback preserves the original link for a Convex-shaped id that turns
    // out not to be one of our entities (entity:// hrefs arrive stripped, so
    // this degrades to plain text for those).
    return (
      <EntityIdPill
        shortId={text}
        fallback={<a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>}
      />
    );
  }
  // A pasted/linked codecast object URL (e.g. https://codecast.sh/tasks/<id>)
  // becomes a rich, in-app pill instead of an external link.
  const entityRef = parseEntityUrl(href);
  if (entityRef) {
    return <EntityIdPill type={entityRef.type} id={entityRef.id} />;
  }
  // A publish URL inside a sentence: a compact titled pill. The block-embed
  // case (URL alone on its line) never reaches here — remarkEntityIds hoists
  // it into an embed:// link first.
  const page = parsePublishedPageUrl(href);
  if (page) {
    return <PublishedPagePill slug={page.slug} href={href} label={text && text !== href ? text : undefined} />;
  }
  return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
}

function genericTitle(entity: any): string {
  return entity.display_title || entity.title || entity.name || entity.short_id || "Untitled";
}

// Doc hover shows a real peek at the document body, not just metadata — a
// multi-line plain-text preview with paragraph shape, faded out at the bottom.
function DocHoverContent({ doc }: { doc: any }) {
  const preview = docContentPreview(doc.content);
  const typeLabel = doc.doc_type ? doc.doc_type.charAt(0).toUpperCase() + doc.doc_type.slice(1) : "Doc";
  const timeAgo = relativeTime(doc.updated_at);

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <FileText className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-sol-green" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{genericTitle(doc)}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] font-medium text-sol-green">{typeLabel}</span>
            {timeAgo && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-[10px] text-gray-400">{timeAgo}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {preview && (
        <div className="relative pl-[22px] max-h-44 overflow-hidden">
          <p className="text-[11px] text-gray-400 leading-relaxed whitespace-pre-line">{preview}</p>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-sol-bg to-transparent" />
        </div>
      )}

      <div className="flex items-center justify-end pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

function GenericHoverContent({ entity, type }: { entity: any; type: EntityType }) {
  const Icon = type === "doc" ? FileText : Folder;
  const summary = entity.description || entity.goal || entity.summary;
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Icon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-sol-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{genericTitle(entity)}</div>
          <span className="text-[10px] font-medium text-sol-text-dim">{TYPE_LABEL[type]}</span>
        </div>
      </div>
      {summary && (
        <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed pl-[22px]">
          {stripMarkdown(summary).slice(0, 200)}
        </p>
      )}
      <div className="flex items-center justify-end pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}


export function EntityIdPill({ shortId, type: typeProp, id: idProp, fallback }: { shortId?: string; type?: EntityType; id?: string; fallback?: React.ReactNode }) {
  // `id` keeps its original case (Convex ids are case-sensitive); short-id and
  // prefix matching lowercase internally.
  const rawRef = (idProp ?? shortId ?? "").trim();
  // A `doc:<convexId>` reference carries its type in the string itself.
  const isDocRef = !typeProp && /^doc:/i.test(rawRef);
  const rawId = isDocRef ? rawRef.slice(4) : rawRef;
  const looksConvex = isConvexId(rawId);
  // A full Convex id carries no type prefix (and can even start with "jx", so
  // prefix sniffing misclassifies it) — resolve its table server-side instead.
  // Prefix detection is for short ids only.
  // No-throw: this resolver gates every other query in the pill, and a pill
  // must degrade to plain text — not crash the conversation view — when the
  // backend doesn't have the function yet (client/deploy skew).
  const { data: resolvedType } = useQueryNoThrow(api.entities.resolveIdType, !typeProp && !isDocRef && looksConvex ? { id: rawId } : "skip");
  const type: EntityType | null =
    typeProp ?? (isDocRef ? "doc" : looksConvex ? resolvedType ?? null : entityTypeFromId(rawId));
  const isTask = type === "task";
  const isPlan = type === "plan";
  const isSession = type === "session";
  const isTrigger = type === "trigger";

  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryArgs = type ? entityQueryArgs(type, rawId) : null;
  const task = useQuery(api.tasks.webGet, isTask && queryArgs ? queryArgs : "skip");
  const plan = useQuery(api.plans.webGet, isPlan && queryArgs ? queryArgs : "skip");
  const session = useQuery(api.conversations.webGet, isSession && queryArgs ? queryArgs : "skip");
  // No-throw: agentTasks.webGet is newer than some deployed clients, and a
  // conversation must not crash on a trigger reference just because the backend
  // hasn't caught up — the pill degrades to its short id, then fills in.
  const { data: trigger } = useQueryNoThrow(api.agentTasks.webGet, isTrigger && queryArgs ? queryArgs : "skip");
  // docs/projects are only ever addressed by a full Convex id.
  const doc = useQuery(api.docs.webGet, type === "doc" && looksConvex ? { id: rawId } : "skip");
  const project = useQuery(api.projects.webGet, type === "project" && looksConvex ? { id: rawId } : "skip");
  const served = isTask ? task : isPlan ? plan : isSession ? session : isTrigger ? trigger : type === "doc" ? doc : type === "project" ? project : undefined;

  // Local-first: the client usually already holds this row, so paint the title
  // on the FIRST frame instead of flashing the raw id until the query answers.
  // Read once and non-reactively (getState, not a subscription) — a pill must
  // not re-render on the churn of a collection with thousands of rows; the live
  // query above is what keeps the label fresh.
  const seed = useMemo(
    () => (type ? findEntityInStore(useInboxStore.getState(), type, rawId) : undefined),
    [type, rawId],
  );
  const entity: any = served ?? seed;
  const status = entity?.status;

  // A task pill's icon is the StatusCircle at the task's status, in the
  // status's own color — the pill chrome stays one consistent task color
  // (violet) while the disc's fill and tint say where the work stands.
  //
  // Resolved unconditionally, because it is also the LAST branch of the icon
  // chain below, and that branch catches more than tasks: a reference whose
  // type is still null (a Convex id waiting on resolveIdType, or one belonging
  // to no entity table) lands there too. Those renders are thrown away by the
  // `!type` guard further down, but the guard sits below the hooks and so runs
  // after this — every value it protects has to stand on its own until then.
  const taskV = taskVisual(status);
  const Icon = isSession
    ? MessageSquare
    : isPlan
      ? Target
      : isTrigger
        ? Zap
        : type === "doc"
          ? FileText
          : type === "project"
            ? Folder
            : taskV.icon;

  const colors = isSession
    ? "bg-sol-blue/10 text-sol-blue border-sol-blue/20 hover:bg-sol-blue/20"
    : isPlan
      ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/20 hover:bg-sol-cyan/20"
      : isTrigger
        ? "bg-sol-orange/10 text-sol-orange border-sol-orange/20 hover:bg-sol-orange/20"
        : type === "doc"
          ? "bg-sol-green/10 text-sol-green border-sol-green/20 hover:bg-sol-green/20"
          : type === "project"
            ? "bg-sol-text-dim/10 text-sol-text-muted border-sol-text-dim/20 hover:bg-sol-text-dim/20"
            : "bg-sol-violet/10 text-sol-violet border-sol-violet/20 hover:bg-sol-violet/20";

  // One label rule for every type, shared with mobile: the pill reads as the
  // object's NAME, and the id moves to the hover card. A trigger prefers its
  // display_title — the generated short name, not the whole prompt's first line.
  const resolvedTitle: string | undefined =
    (isTrigger ? entity?.display_title : undefined) || entity?.title || entity?.display_title || entity?.name;
  const pillLabel = entityReferenceLabel({
    title: resolvedTitle,
    shortId: entity?.short_id,
    rawId,
    typeLabel: type ? TYPE_LABEL[type] : null,
  });

  // Route that opens this entity. Prefer the resolved Convex id; fall back to
  // the raw id so the link still works in the brief window before the query
  // resolves. The pill IS the click target — one click navigates ("click
  // through"), exactly like any other link.
  const href = entityRoute(type ?? "session", entity?._id ?? rawId) ?? "#";

  const cancelHover = useCallback(() => {
    if (hoverTimeout.current) {
      clearTimeout(hoverTimeout.current);
      hoverTimeout.current = null;
    }
  }, []);

  // Always cancel any pending timer before scheduling the next one. The flicker
  // ("disappears then comes back") was a stale close-timer surviving re-entry
  // into the card: it fired and hid the popover even though the cursor was now
  // inside it.
  const openSoon = useCallback(() => {
    cancelHover();
    hoverTimeout.current = setTimeout(() => setHoverOpen(true), 200);
  }, [cancelHover]);

  const closeSoon = useCallback(() => {
    cancelHover();
    hoverTimeout.current = setTimeout(() => setHoverOpen(false), 150);
  }, [cancelHover]);

  const closeNow = useCallback(() => {
    cancelHover();
    setHoverOpen(false);
  }, [cancelHover]);

  // Session pills route through the same open-resolution as every other linked
  // session (useOpenLinkedSession): on a task/doc/plan surface the conversation
  // swaps into the companion pane instead of replacing the whole stage, and on
  // the inbox it becomes the current selection. Plain left-click only — modified
  // clicks and unresolved entities keep the href's full-page navigation.
  const openLinkedSession = useOpenLinkedSession();
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      closeNow();
      if (!isSession || !entity?._id) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openLinkedSession(entity);
    },
    [closeNow, isSession, entity, openLinkedSession],
  );

  // Clear any in-flight timer if the pill unmounts (e.g. on navigation).
  useEffect(() => cancelHover, [cancelHover]);

  // Unknown id shape, or a Convex id that resolved to no entity table (message
  // id, random hash) — render the caller's original element, or the raw text.
  // Also the transient state while resolveIdType is in flight.
  if (!type) return fallback !== undefined ? <>{fallback}</> : <span>{rawId}</span>;

  return (
    <Popover open={hoverOpen} onOpenChange={setHoverOpen}>
      <PopoverAnchor asChild>
        <Link
          href={href}
          onClick={handleClick}
          onMouseEnter={openSoon}
          onMouseLeave={closeSoon}
          className={`not-prose inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono leading-[1.4] no-underline ${colors} border transition-colors cursor-pointer align-baseline`}
        >
          <span className="relative flex-shrink-0">
            {isSession && (session?.author_name || session?.author_avatar) ? (
              <AuthorAvatar name={session.author_name} avatar={session.author_avatar} size={14} />
            ) : (
              <Icon className={`w-3 h-3 ${isTask ? taskV.color : ""}`} />
            )}
            {((isSession && status === "active") || (isTrigger && status === "running")) && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-sol-green" />
            )}
          </span>
          <span>{pillLabel}</span>
        </Link>
      </PopoverAnchor>
      <PopoverContent
        className={`${type === "doc" ? "w-80" : "w-64"} bg-sol-bg border border-sol-border shadow-xl p-0 relative`}
        side="top"
        align="start"
        sideOffset={6}
        onMouseEnter={openSoon}
        onMouseLeave={closeSoon}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Invisible bridge over the offset gap to the pill: keeps the cursor
            "inside" the card while crossing it, so moving up to click never
            dismisses the popover. */}
        <span aria-hidden className="absolute inset-x-0 top-full h-2" />
        <Link
          href={href}
          onClick={handleClick}
          className="block p-3 no-underline cursor-pointer"
        >
          {entity ? (
            isTask ? <TaskHoverContent task={entity} />
            : isPlan ? <PlanHoverContent plan={entity} />
            : isSession ? <SessionHoverContent session={entity} />
            : isTrigger ? <TriggerHoverContent trigger={entity} />
            : type === "doc" ? <DocHoverContent doc={entity} />
            : <GenericHoverContent entity={entity} type={type} />
          ) : (
            <div className="text-[11px] text-gray-500">{pillLabel}</div>
          )}
        </Link>
      </PopoverContent>
    </Popover>
  );
}

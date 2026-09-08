import React, { useState, useCallback, useRef, useEffect, useContext } from "react";
import Link from "next/link";
import {
  Target,
  ArrowUpRight,
  MessageSquare,
  FolderOpen,
  FileText,
  Folder,
  Zap,
  GitPullRequest,
  GitCommitHorizontal,
} from "lucide-react";
import { taskVisual } from "./TaskStatusBadge";
import { Popover, PopoverContent, PopoverAnchor } from "./ui/popover";
import { stripMarkdown, docContentPreview } from "../lib/notificationText";
import {
  parseEntityUrl,
  parsePublishedPageUrl,
  isEntityId,
  entityMentionRegex,
  MESSAGE_REF_PREFIX,
  CONTEXTUAL_PR_REF_PREFIX,
  parseContextualPrRef,
  repoObjectId,
  type EntityType,
} from "../lib/entityLinks";
import { SharedMessageCard, SharedMessagePill } from "./SharedMessageCard";
import { AuthorAvatar, DiffStat } from "./entityDisplay";
import {
  PRIORITY_CONFIG,
  STATUS_COLOR,
  STATUS_LABEL,
  TYPE_LABEL,
  relativeTime,
  taskPeople,
  useEntityResolution,
} from "../lib/entityDisplay";
import { prState, repoObjectRefOf } from "../lib/repoObjects";
import { githubLocationHref } from "../lib/repoNavigation";
import { EntityObjectCard } from "./EntityObjectCard";
import { DocEmbed } from "./DocEmbed";
import { DatePill } from "./DatePill";
import { FilePathLink } from "./FilePathLink";
import { FilePathContext, filePathMention, parseFilePathHref } from "../lib/filePathLinks";
import { PublishedPageEmbed, PublishedPagePill } from "./PublishedPageEmbed";
import { useOpenLinkedSession } from "../hooks/useOpenLinkedSession";
import { REF_NTH_ATTR, REF_NAMED_ATTR, REF_SUFFIX_ATTR } from "../lib/remarkEntityIds";
import { useIsEstablishedRef } from "../hooks/entityMentionScope";
import { describeTaskCadence, taskStateLabel } from "./triggerCadence";
import { SessionHoverContent } from "./SessionHoverContent";
import { DocDates } from "./DocDates";

export { SessionHoverContent };

// `date:<iso>` optionally trailed by `|<label>` — the payload remarkEntityIds
// writes for a serialized date pill (`@[<label> date:<iso>]`).
function parseDateRef(text: string): { iso: string; label?: string } | null {
  const m = text.match(/^date:(\d{4}-\d{2}-\d{2})(?:\|(.*))?$/i);
  if (!m) return null;
  return { iso: m[1], label: m[2] || undefined };
}

// Status/priority/type vocabulary, the display atoms (AuthorAvatar,
// SessionSummaryBlock, relativeTime, taskPeople) and the id→entity resolution
// hook all live in entityDisplay.tsx, shared with EntityObjectCard — one
// implementation, so an object reads the same as a pill, a hover card, and a
// shared-object card.

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

// A pull request reference answers: what it is, whether it is open, merged or
// closed, who opened it, which branch goes where, and how big it is.
function PullRequestHoverContent({ pr }: { pr: any }) {
  const state = prState(pr.state);
  const when = relativeTime(pr.merged_at ?? pr.updated_at);
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <GitPullRequest className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${state.color}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{pr.title || `#${pr.number}`}</div>
          <div className="flex items-center gap-2 mt-1 text-[10px]">
            <span className={`font-medium ${state.color}`}>{state.label}</span>
            {pr.author_github_username && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-gray-400 truncate">{pr.author_github_username}</span>
              </>
            )}
            {when && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-gray-400">{when}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {pr.body && (
        <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed pl-[22px]">
          {stripMarkdown(pr.body).slice(0, 200)}
        </p>
      )}

      {(pr.head_ref || pr.additions != null || pr.changed_files != null) && (
        <div className="flex items-center gap-2 pl-[22px] text-[10px] font-mono text-gray-500 min-w-0">
          {pr.head_ref && (
            <span className="truncate">
              <span className="text-sol-green">{pr.head_ref}</span>
              {pr.base_ref && (
                <>
                  <span className="text-gray-600"> → </span>
                  <span className="text-sol-blue">{pr.base_ref}</span>
                </>
              )}
            </span>
          )}
          <DiffStat additions={pr.additions} deletions={pr.deletions} files={pr.changed_files} className="ml-auto" />
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono truncate">{repoObjectRefOf("pr", pr)}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5 flex-shrink-0">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

// A commit reference answers: its subject, who wrote it and when, the branch
// it landed on, and the body when the message has one.
function CommitHoverContent({ commit }: { commit: any }) {
  const lines = String(commit.message ?? "").split("\n");
  const subject = lines[0]?.trim();
  const body = lines.slice(1).join("\n").trim();
  const when = relativeTime(commit.timestamp);
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <GitCommitHorizontal className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-sol-yellow" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{subject || commit.sha.slice(0, 7)}</div>
          <div className="flex items-center gap-2 mt-1 text-[10px] min-w-0">
            {commit.author_name && <span className="text-gray-400 truncate">{commit.author_name}</span>}
            {when && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-gray-400">{when}</span>
              </>
            )}
            {commit.branch && (
              <>
                <span className="text-gray-600">·</span>
                <span className="text-gray-400 font-mono truncate">{commit.branch}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {body && (
        <p className="text-[11px] text-gray-400 line-clamp-3 leading-relaxed pl-[22px] whitespace-pre-line">
          {body.slice(0, 220)}
        </p>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono inline-flex items-center gap-2 min-w-0">
          <span className="truncate">{commit.repository ? `${commit.repository}@` : ""}{commit.sha.slice(0, 7)}</span>
          <DiffStat additions={commit.insertions} deletions={commit.deletions} files={commit.files_changed} />
        </span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5 flex-shrink-0">
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
  if (entityId?.startsWith("date:")) {
    const date = parseDateRef(entityId);
    if (date) return <DatePill iso={date.iso} label={name} />;
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

export function TextWithMentions({ text }: { text: string }) {
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
  return <>{parts.length > 0 ? parts : [text]}</>;
}

// The remark plugin numbers each mention within one markdown body
// (`data-ref-nth`) and marks the ones the author spelled out as
// `@[Title id]` (`data-ref-named`). Read them off the element props here, and
// strip them so the plain-element fallbacks do not leak them into the DOM.
function takeMentionProps(props: any): { mention: MentionInfo; rest: any } {
  const { [REF_NTH_ATTR]: nth, [REF_NAMED_ATTR]: named, [REF_SUFFIX_ATTR]: suffix, ...rest } = props ?? {};
  return {
    mention: { nth: Number(nth) || undefined, named: named != null && named !== false, suffix: typeof suffix === "string" ? suffix : undefined },
    rest,
  };
}

export function EntityAwareCode({ children, className, ...allProps }: any) {
  const text = String(children);
  const { mention: mentionInfo, rest: props } = takeMentionProps(allProps);
  // The fallback keeps a non-entity Convex-shaped string (message id, hash)
  // rendered as the inline code it was written as.
  if (!className && isEntityId(text)) {
    return <EntityIdPill shortId={text} mention={mentionInfo} fallback={<code className={className} {...props}>{children}</code>} />;
  }
  const code = <code className={className} {...props}>{children}</code>;
  // `lib/foo.ts:38` in backticks — the commonest way an agent names a file.
  // The code span keeps its look; the link wraps it.
  const mention = className ? null : filePathMention(text);
  if (mention) return <FilePathLink path={mention.path} line={mention.line}>{code}</FilePathLink>;
  return code;
}

/**
 * A pull request named by number alone (`pr:#N|<as written>`, minted by
 * remarkEntityIds) completes to `owner/repo#N` from the conversation's
 * repository and wears a pill that reads as the text written. With no
 * repository in context it is not a reference at all and prints back verbatim.
 */
function contextualPrReference(payload: string, repository: string | null | undefined, mention?: MentionInfo): React.ReactNode | null {
  const ref = parseContextualPrRef(payload);
  if (!ref) return null;
  if (!repository) return <>{ref.label}</>;
  return (
    <EntityIdPill
      type="pr"
      id={repoObjectId({ type: "pr", repository, number: ref.number })}
      certain
      label={ref.label}
      mention={mention}
    />
  );
}

export function EntityAwareLink({ href, children, ...allProps }: any) {
  const { mention, rest: props } = takeMentionProps(allProps);
  // The conversation this link sits in, when there is one: its repository is
  // what a bare `#3263` refers to.
  const pathCtx = useContext(FilePathContext);
  {
    // Transclusion: ![[doc:<id>]] arrives as a link whose TEXT is
    // "embed:doc:<id>" (the embed:// href is dropped by react-markdown's url
    // sanitizer, same as entity:// below). Renders the doc body in full.
    const embedText = typeof children === "string" ? children : Array.isArray(children) ? children.map(String).join("") : String(children ?? "");
    if (embedText.startsWith("embed:doc:") && embedText.length > 10) {
      return <DocEmbed id={embedText.slice(10)} />;
    }
    // A references-only paragraph or list, promoted by remarkEntityCards: the
    // text payload is `card:<count>:<ref>`, and the reference renders as a
    // browsable preview card instead of a pill. Count = how many cards share
    // the row, so a lone card can be richer than one in a group.
    //
    // The marker class gates authenticity: this renderer is shared by every
    // markdown surface, but only links the plugin itself rewrote carry
    // `entity-card-ref` — a hand-typed `[card:1:…](url)` in a doc stays an
    // ordinary link instead of smuggling a block card into a <p>.
    const fromCardPlugin = typeof (props as any).className === "string" && (props as any).className.includes("entity-card-ref");
    const cardMatch = fromCardPlugin ? /^card:(\d+):(.+)$/.exec(embedText) : null;
    if (cardMatch) {
      const count = Math.max(1, Number(cardMatch[1]) || 1);
      // A conversation message is its own reference kind (see entityLinks:
      // MESSAGE_REF_PREFIX) — no entity table, so it has its own card.
      if (cardMatch[2].startsWith(MESSAGE_REF_PREFIX)) return <SharedMessageCard refId={cardMatch[2]} count={count} />;
      return <EntityObjectCard refId={cardMatch[2]} count={count} />;
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
    if (ref.startsWith("doc:")) return <EntityIdPill type="doc" id={ref.slice(4)} mention={mention} />;
    if (ref.startsWith(MESSAGE_REF_PREFIX)) return <SharedMessagePill refId={ref} />;
    const date = parseDateRef(ref);
    if (date) return <DatePill iso={date.iso} label={date.label} />;
    if (ref.startsWith(CONTEXTUAL_PR_REF_PREFIX)) {
      const pr = contextualPrReference(ref, pathCtx?.repository, mention);
      if (pr !== null) return pr;
    }
    return <EntityIdPill shortId={ref} mention={mention} />;
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
    return <EntityIdPill type="doc" id={text.slice(4)} mention={mention} />;
  }
  // A message reference's text payload (`msg:<token or id>`), same convention.
  if (text.startsWith(MESSAGE_REF_PREFIX) && text.length > MESSAGE_REF_PREFIX.length) {
    return <SharedMessagePill refId={text} />;
  }
  // A date pill's text payload (`date:<iso>|<label>`), same stripped-href
  // convention as doc refs above.
  {
    const date = parseDateRef(text);
    if (date) return <DatePill iso={date.iso} label={date.label} />;
  }
  // A pull request named by number alone (`pr:#N|<as written>`), same
  // convention: completed from the conversation's repository, or the text back.
  if (text.startsWith(CONTEXTUAL_PR_REF_PREFIX)) {
    const pr = contextualPrReference(text, pathCtx?.repository, mention);
    if (pr !== null) return pr;
  }
  if (isEntityId(text)) {
    // Fallback preserves the original link for a Convex-shaped id that turns
    // out not to be one of our entities. An entity:// href arrives stripped
    // (empty), and an anchor with no href opens a blank tab, so that case
    // degrades to the plain text instead.
    return (
      <EntityIdPill
        shortId={text}
        mention={mention}
        fallback={href ? <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a> : <>{children}</>}
      />
    );
  }
  // A pasted/linked codecast object URL (e.g. https://codecast.sh/tasks/<id>)
  // becomes a rich, in-app pill instead of an external link.
  const entityRef = parseEntityUrl(href);
  if (entityRef) {
    // A GitHub pull request or commit URL is the same object as its codecast
    // page, so it renders as that pill and opens there. A URL leaves no doubt
    // about what it names, so the pill stands even before codecast holds the
    // row (no installation yet, not synced): it reads as the author's own link
    // text, or the `owner/repo#N` reference, and the page it opens offers the
    // GitHub link when the row is missing.
    const repoObject = entityRef.type === "pr" || entityRef.type === "commit";
    return (
      <EntityIdPill
        type={entityRef.type}
        id={entityRef.id}
        mention={mention}
        certain={repoObject}
        label={repoObject && text && text !== href ? text : undefined}
      />
    );
  }
  // A publish URL inside a sentence: a compact titled pill. The block-embed
  // case (URL alone on its line) never reaches here — remarkEntityIds hoists
  // it into an embed:// link first.
  const page = parsePublishedPageUrl(href);
  if (page) {
    return <PublishedPagePill slug={page.slug} href={href} label={text && text !== href ? text : undefined} />;
  }
  // A GitHub link to a place in a repository — a file, a tree, a compare, the
  // repository itself — opens the codecast page for it, in this window.
  const internal = githubLocationHref(href);
  if (internal) {
    return <Link href={internal} className={(props as any).className}>{children}</Link>;
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

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <FileText className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-sol-green" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{genericTitle(doc)}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[10px] font-medium text-sol-green">{typeLabel}</span>
            {doc.created_at && (
              <>
                <span className="text-gray-600">·</span>
                <DocDates doc={doc} variant="full" className="text-[10px] text-gray-400" />
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


/** Where a mention sits in its message: its ordinal, whether the author
 *  wrote the name out (`@[Title id]`), and a possessive glued to it.
 *  Stamped by remarkEntityIds. */
export type MentionInfo = { nth?: number; named?: boolean; suffix?: string };

export function EntityIdPill({
  shortId,
  type: typeProp,
  id: idProp,
  fallback,
  mention,
  compact: compactProp,
  certain = false,
  label: labelProp,
}: {
  shortId?: string;
  type?: EntityType;
  id?: string;
  fallback?: React.ReactNode;
  mention?: MentionInfo;
  /** Force the short-name form (a surface too narrow for a title). */
  compact?: boolean;
  /** The reference certainly names a pull request or commit — it came from a
   *  URL, or from a number in a conversation bound to the repository — so it
   *  wears the pill even before codecast holds the row. A bare
   *  `owner/repo#12` in prose is not certain: it is also the shape of a file
   *  path with a line hash, so it stays text until the row is in hand. */
  certain?: boolean;
  /** What the reference reads as until the row resolves (the text as written);
   *  the object's title still wins once it is in hand. */
  label?: string;
}) {
  // All resolution — type sniffing/server resolve, webGet queries, the
  // local-first store seed, label and route — is the shared hook.
  const rawRef = (idProp ?? shortId ?? "").trim();
  const resolution = useEntityResolution(rawRef, typeProp);
  const { rawId, type, entity, status, href } = resolution;
  const fullLabel = !entity && labelProp ? labelProp : resolution.label;
  const shortLabel = !entity && labelProp ? labelProp : resolution.shortLabel;
  // A reader needs the title once. A repeat mention in the same message — or
  // a mention of an object the surrounding chrome already named (the sender
  // of a "message from" card) — shows the object's short NAME instead, so
  // prose that names one session four times reads as a sentence, not a wall
  // of titles. An author who spelled the name out (`@[Title id]`) always gets
  // the full form: they asked for the name in the sentence.
  const establishedByRaw = useIsEstablishedRef(rawId);
  const establishedByShortId = useIsEstablishedRef(entity?.short_id);
  const established = establishedByRaw || establishedByShortId;
  const compact = compactProp ?? (!mention?.named && ((mention?.nth ?? 1) > 1 || established));
  const pillLabel = compact ? shortLabel : fullLabel;
  const isTask = type === "task";
  const isPlan = type === "plan";
  const isSession = type === "session";
  const isTrigger = type === "trigger";
  const isPr = type === "pr";
  const isCommit = type === "commit";

  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

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
            : isPr
              ? GitPullRequest
              : isCommit
                ? GitCommitHorizontal
                : taskV.icon;

  const colors = isSession
    ? "bg-sol-blue/[0.08] text-sol-blue hover:bg-sol-blue/[0.16]"
    : isPlan
      ? "bg-sol-cyan/[0.08] text-sol-cyan hover:bg-sol-cyan/[0.16]"
      : isTrigger
        ? "bg-sol-orange/[0.08] text-sol-orange hover:bg-sol-orange/[0.16]"
        : type === "doc"
          ? "bg-sol-green/[0.08] text-sol-green hover:bg-sol-green/[0.16]"
          : type === "project"
            ? "bg-sol-text-dim/[0.08] text-sol-text-muted hover:bg-sol-text-dim/[0.16]"
            : isPr
              ? "bg-sol-green/[0.08] text-sol-green hover:bg-sol-green/[0.16]"
              : isCommit
                ? "bg-sol-yellow/[0.08] text-sol-yellow hover:bg-sol-yellow/[0.16]"
                : "bg-sol-violet/[0.08] text-sol-violet hover:bg-sol-violet/[0.16]";

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
  // session (useOpenLinkedSession): the conversation takes the stage, and on
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
  const suffix = mention?.suffix;
  if (!type) return fallback !== undefined ? <>{fallback}{suffix}</> : <span>{rawId}{suffix}</span>;
  // A pull request or commit reference written as bare text wears a pill only
  // once its row is in hand. `owner/repo#12` is also the shape of a file path
  // with a line hash, and `owner/repo@1234567` of a version pin, so one that
  // names nothing codecast knows stays the text it was written as. A certain
  // reference (a URL, a number in a repository bound conversation) is exempt:
  // it pills and opens the codecast page, which handles a missing row itself.
  if ((isPr || isCommit) && !entity && !certain) return fallback !== undefined ? <>{fallback}</> : <span>{rawId}</span>;

  // Quiet chrome: the reference sits IN the sentence — same size as the
  // prose, no border, a faint tint of the type's color, the way a mention
  // reads in chat. The icon and the color say "this is an object"; the box
  // that used to say it was what turned a paragraph with four references
  // into a row of stamps.
  return (
    <>
    <Popover open={hoverOpen} onOpenChange={setHoverOpen}>
      <PopoverAnchor asChild>
        <Link
          href={href}
          onClick={handleClick}
          onMouseEnter={openSoon}
          onMouseLeave={closeSoon}
          className={`not-prose entity-ref${compact ? " entity-ref-compact" : ""} inline-flex items-center gap-[0.2em] px-[0.2em] rounded-[0.2em] text-[1em] font-medium leading-none no-underline ${colors} transition-colors cursor-pointer align-baseline hover:underline decoration-current/40 underline-offset-2`}
          title={compact && fullLabel !== pillLabel ? fullLabel : undefined}
        >
          <span className="relative flex-shrink-0 opacity-80 inline-flex items-center">
            {isSession && (entity?.author_name || entity?.author_avatar) ? (
              <AuthorAvatar name={entity.author_name} avatar={entity.author_avatar} size="1em" />
            ) : (
              <Icon className={`w-[1em] h-[1em] block ${isTask ? taskV.color : ""}`} />
            )}
            {((isSession && status === "active") || (isTrigger && status === "running")) && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-sol-green" />
            )}
          </span>
          <span>{pillLabel}</span>
        </Link>
      </PopoverAnchor>
      <PopoverContent
        className={`${type === "doc" ? "w-80" : isPr || isCommit ? "w-72" : "w-64"} bg-sol-bg border border-sol-border shadow-xl p-0 relative`}
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
            : isPr ? <PullRequestHoverContent pr={entity} />
            : isCommit ? <CommitHoverContent commit={entity} />
            : <GenericHoverContent entity={entity} type={type} />
          ) : (
            <div className="text-[11px] text-gray-500">{pillLabel}</div>
          )}
        </Link>
      </PopoverContent>
    </Popover>
    {/* The possessive sits against the label, not a padding-width away. */}
    {suffix && <span className="-ml-[3px]">{suffix}</span>}
    </>
  );
}

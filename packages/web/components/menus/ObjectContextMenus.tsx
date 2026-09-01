"use client";

import * as React from "react";
import {
  Archive,
  Bot,
  Check,
  Clock,
  Copy,
  CornerDownRight,
  Cpu,
  ExternalLink,
  EyeOff,
  FileText,
  Forward,
  Link as LinkIcon,
  Moon,
  Pencil,
  Pin,
  PinOff,
  Square,
  Star,
  Tag,
  Trash2,
  User,
  CircleDot,
  ArrowUp,
} from "lucide-react";
import { toast } from "sonner";
import { CtxItem, CtxHeader, CtxSeparator, CtxSub, CtxSubTrigger, CtxSubContent } from "../ui/context-menu";
import {
  PRIORITY_OPTIONS,
  PLAN_STATUS_OPTIONS,
  DOC_TYPE_OPTIONS,
  type EntityOption,
} from "./entityOptions";
import { statusByKey, statusEntityOptions, statusWriteFields, taskStatusKey, useTeamTaskStatusList } from "../../lib/taskStatuses";
import {
  useInboxStore,
  sortLabels,
  convBucketMap,
  type InboxSession,
  type TaskItem,
  type DocItem,
} from "../../store/inboxStore";
import { closeTaskWithGuard, setTaskParent } from "../../lib/taskActions";
import { undoableArchiveDoc, undoableHideSession, undoableDeferSession, undoableDormantSession } from "../../store/undoActions";
import { copyToClipboard, shareOrigin, cn } from "../../lib/utils";
import { openForwardToChat } from "../../lib/forwardToChat";
import { useTeamFeature } from "../../lib/teamFeatures";
import { getLabelColor } from "../../lib/labelColors";
import { canControlModel } from "../../lib/modelSwitch";

// Menu CONTENT per object type — the items every right-click surface renders
// inside a <ContextMenu>. Verbs call the same store actions the command
// palette calls, so the two can never disagree; enumerable picks (status,
// priority, type) are inline submenus, while search-shaped picks (assign to a
// big roster, labels, parent, model) hand off to the palette's drill-in mode.
//
// Payload rule: components read the store imperatively inside handlers
// (useInboxStore.getState()) and take one-shot snapshots for submenu data —
// a menu lives for seconds, so it never needs live subscriptions.

const openPaletteMode = (targets: any[], targetType: "task" | "doc" | "plan" | "session", mode: string) =>
  useInboxStore.getState().openPalette({ targets, targetType, mode });

/** "Send to chat…" next to an object's Copy link — same URL, forwarded through
 *  the palette's channel picker. Renders nothing when the team has chat off. */
export function ForwardCtxItem({ url, label }: { url: string; label: string }) {
  const chatOn = useTeamFeature("chat");
  if (!chatOn) return null;
  return (
    <CtxItem icon={Forward} onSelect={() => openForwardToChat({ url, label })}>
      Send to chat…
    </CtxItem>
  );
}

function OptionSubmenu({
  icon,
  label,
  options,
  currentKey,
  onPick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  options: EntityOption[];
  currentKey?: string;
  onPick: (key: string) => void;
}) {
  return (
    <CtxSub>
      <CtxSubTrigger icon={icon}>{label}</CtxSubTrigger>
      <CtxSubContent className="min-w-[180px]">
        {options.map((o) => (
          <CtxItem
            key={o.key}
            icon={o.icon}
            iconClassName={o.color}
            className={!o.icon ? o.color : undefined}
            trailing={currentKey === o.key ? <Check className="size-3.5 text-sol-cyan" /> : undefined}
            onSelect={() => onPick(o.key)}
          >
            {o.label}
          </CtxItem>
        ))}
      </CtxSubContent>
    </CtxSub>
  );
}

// ---------------------------------------------------------------- tasks

export function TaskMenuItems({
  tasks,
  onOpen,
}: {
  tasks: TaskItem[];
  /** Single-task open; surfaces route differently (list vs project scope). */
  onOpen?: (task: TaskItem) => void;
}) {
  const single = tasks.length === 1 ? tasks[0] : null;
  const count = tasks.length;
  const bulkLabel = single ? single.short_id : `${count} tasks`;
  // One-shot roster snapshot: the assign submenu doesn't need live presence.
  const members = React.useMemo(() => useInboxStore.getState().teamMembers ?? [], []);
  // The team's status vocabulary (a context-menu selection is always one
  // workspace's rows, so the first task's team speaks for the set).
  const taskStatuses = useTeamTaskStatusList((tasks[0] as any)?.team_id);
  const statusOptions = React.useMemo(() => statusEntityOptions(taskStatuses), [taskStatuses]);

  const applyAll = (fields: Record<string, any>) => {
    const { updateTask } = useInboxStore.getState();
    for (const t of tasks) updateTask(t.short_id, fields);
  };

  const setStatus = (key: string) => {
    const target = statusByKey(taskStatuses, key);
    if (!target) return;
    const fields = statusWriteFields(target);
    // Terminal moves route through the close gateway so a parent with open
    // subtasks gets the shared dialog instead of a stranded local Done.
    if (fields.status === "done" || fields.status === "dropped") {
      let deferred = false;
      for (const t of tasks) {
        if (closeTaskWithGuard(t.short_id, fields.status, undefined, fields.status_id).needsConfirm) deferred = true;
      }
      if (!deferred) toast.success(`${bulkLabel} → ${target.name}`);
    } else {
      applyAll(fields);
      toast.success(`${bulkLabel} → ${target.name}`);
    }
  };

  const hasParent = tasks.some((t) => (t as any).parent_id);

  return (
    <>
      {single && <CtxHeader title={single.title || single.short_id} id={single.short_id} />}
      {!single && <CtxHeader title={`${count} tasks selected`} />}
      {single && onOpen && (
        <>
          <CtxItem icon={ExternalLink} onSelect={() => onOpen(single)}>Open</CtxItem>
          <CtxItem icon={ExternalLink} onSelect={() => window.open(`/tasks/${single._id}`, "_blank")}>
            Open in new tab
          </CtxItem>
          <CtxSeparator />
        </>
      )}
      <OptionSubmenu
        icon={CircleDot}
        label="Status"
        options={statusOptions}
        currentKey={single ? taskStatusKey(single as any, taskStatuses) : undefined}
        onPick={setStatus}
      />
      <OptionSubmenu
        icon={ArrowUp}
        label="Priority"
        options={PRIORITY_OPTIONS}
        currentKey={(single as any)?.priority}
        onPick={(key) => {
          applyAll({ priority: key });
          toast.success(`${bulkLabel} priority → ${PRIORITY_OPTIONS.find((o) => o.key === key)?.label ?? key}`);
        }}
      />
      <CtxSub>
        <CtxSubTrigger icon={User}>Assign</CtxSubTrigger>
        <CtxSubContent className="min-w-[190px]">
          {members.map((m: any) => (
            <CtxItem
              key={m._id}
              trailing={single && (single as any).assignee === m._id ? <Check className="size-3.5 text-sol-cyan" /> : undefined}
              onSelect={() => {
                applyAll({ assignee: m._id });
                toast.success(`Assigned to ${m.name || "user"}`);
              }}
            >
              {m.name || m.github_username || "user"}
            </CtxItem>
          ))}
          {members.length > 0 && <CtxSeparator />}
          <CtxItem
            onSelect={() => {
              applyAll({ assignee: null });
              toast.success("Unassigned");
            }}
          >
            Unassign
          </CtxItem>
        </CtxSubContent>
      </CtxSub>
      <CtxItem icon={Tag} onSelect={() => openPaletteMode(tasks, "task", "labels")}>Labels…</CtxItem>
      <CtxItem icon={CornerDownRight} onSelect={() => openPaletteMode(tasks, "task", "parent")}>Set parent…</CtxItem>
      {hasParent && (
        <CtxItem
          icon={CornerDownRight}
          onSelect={() => {
            for (const t of tasks) if ((t as any).parent_id) setTaskParent(t.short_id, "");
            toast.success("Parent removed");
          }}
        >
          Remove parent
        </CtxItem>
      )}
      <CtxItem icon={Bot} onSelect={() => openPaletteMode(tasks, "task", "agent_run")}>Start agent run…</CtxItem>
      {single && (
        <>
          <CtxSeparator />
          <CtxItem
            icon={Copy}
            onSelect={() => {
              copyToClipboard(single.short_id);
              toast.success(`Copied ${single.short_id}`);
            }}
          >
            Copy ID
          </CtxItem>
          <CtxItem
            icon={LinkIcon}
            onSelect={() =>
              copyToClipboard(`${shareOrigin()}/tasks/${single._id}`).then(() => toast.success("Link copied"))
            }
          >
            Copy link
          </CtxItem>
          <ForwardCtxItem url={`${shareOrigin()}/tasks/${single._id}`} label="task" />
        </>
      )}
      <CtxSeparator />
      <CtxItem danger icon={Trash2} onSelect={() => setStatus("dropped")}>
        {single ? "Drop task" : `Drop ${count} tasks`}
      </CtxItem>
    </>
  );
}

// ---------------------------------------------------------------- docs

export function DocMenuItems({
  docs,
  onOpen,
}: {
  docs: DocItem[];
  onOpen?: (doc: DocItem) => void;
}) {
  const single = docs.length === 1 ? docs[0] : null;

  return (
    <>
      {single && <CtxHeader title={(single as any).display_title || single.title || "Untitled"} />}
      {!single && <CtxHeader title={`${docs.length} documents selected`} />}
      {single && onOpen && (
        <>
          <CtxItem icon={ExternalLink} onSelect={() => onOpen(single)}>Open</CtxItem>
          <CtxItem icon={ExternalLink} onSelect={() => window.open(`/docs/${single._id}`, "_blank")}>
            Open in new tab
          </CtxItem>
          <CtxSeparator />
        </>
      )}
      <OptionSubmenu
        icon={FileText}
        label="Type"
        options={DOC_TYPE_OPTIONS}
        currentKey={(single as any)?.doc_type}
        onPick={(key) => {
          const { updateDoc } = useInboxStore.getState();
          for (const d of docs) updateDoc(d._id, { doc_type: key });
          toast.success(`Type → ${DOC_TYPE_OPTIONS.find((o) => o.key === key)?.label ?? key}`);
        }}
      />
      {single && (
        <CtxItem
          icon={Pin}
          onSelect={() => {
            useInboxStore.getState().pinDoc(single._id, !(single as any).pinned);
            toast.success((single as any).pinned ? "Unpinned" : "Pinned");
          }}
        >
          {(single as any).pinned ? "Unpin document" : "Pin document"}
        </CtxItem>
      )}
      <CtxItem icon={Tag} onSelect={() => openPaletteMode(docs, "doc", "labels")}>Labels…</CtxItem>
      {single && (
        <>
          <CtxSeparator />
          <CtxItem
            icon={Copy}
            onSelect={() => {
              copyToClipboard(single._id);
              toast.success("Copied ID");
            }}
          >
            Copy ID
          </CtxItem>
          <CtxItem
            icon={LinkIcon}
            onSelect={() =>
              copyToClipboard(`${shareOrigin()}/docs/${single._id}`).then(() => toast.success("Link copied"))
            }
          >
            Copy link
          </CtxItem>
          <ForwardCtxItem url={`${shareOrigin()}/docs/${single._id}`} label="doc" />
        </>
      )}
      <CtxSeparator />
      <CtxItem
        danger
        icon={Archive}
        onSelect={() => {
          for (const d of docs) undoableArchiveDoc(d._id);
        }}
      >
        {single ? "Archive document" : `Archive ${docs.length} documents`}
      </CtxItem>
    </>
  );
}

// ---------------------------------------------------------------- plans

export function PlanMenuItems({
  plan,
  onOpen,
}: {
  plan: { _id: string; short_id?: string; status?: string; title?: string };
  onOpen?: () => void;
}) {
  const shortId = plan.short_id || plan._id;
  return (
    <>
      <CtxHeader title={plan.title || shortId} id={plan.short_id} />
      {onOpen && (
        <>
          <CtxItem icon={ExternalLink} onSelect={onOpen}>Open</CtxItem>
          <CtxSeparator />
        </>
      )}
      <OptionSubmenu
        icon={CircleDot}
        label="Status"
        options={PLAN_STATUS_OPTIONS}
        currentKey={plan.status}
        onPick={(key) => {
          useInboxStore.getState().updatePlan(shortId, { status: key });
          toast.success(`Plan → ${PLAN_STATUS_OPTIONS.find((o) => o.key === key)?.label ?? key}`);
        }}
      />
      <CtxSeparator />
      <CtxItem
        icon={Copy}
        onSelect={() => {
          copyToClipboard(shortId);
          toast.success(`Copied ${shortId}`);
        }}
      >
        Copy ID
      </CtxItem>
      <CtxItem
        icon={LinkIcon}
        onSelect={() => copyToClipboard(`${shareOrigin()}/plans/${plan._id}`).then(() => toast.success("Link copied"))}
      >
        Copy link
      </CtxItem>
      <ForwardCtxItem url={`${shareOrigin()}/plans/${plan._id}`} label="plan" />
    </>
  );
}

// ---------------------------------------------------------------- sessions

export function SessionMenuItems({
  session,
  isForeign,
  onOpen,
  onKill,
  onStash,
  onDefer,
  onRename,
}: {
  session: InboxSession;
  /** Teammate's session — read-only row, so triage verbs hide. */
  isForeign?: boolean;
  onOpen?: () => void;
  /** Overrides so cards keep their slide-out animations and trigger notices. */
  onKill?: () => void;
  onStash?: () => void;
  onDefer?: () => void;
  onRename?: () => void;
}) {
  const id = session._id;
  // One-shot snapshots — labels don't churn while a menu is open.
  const labels = React.useMemo(() => sortLabels(useInboxStore.getState().buckets as any), []);
  const currentBucketId = React.useMemo(
    () => convBucketMap(useInboxStore.getState().bucketAssignments)[id],
    [id],
  );

  const copyLink = () =>
    copyToClipboard(`${shareOrigin()}/conversation/${id}`).then(() => toast.success("Link copied"));

  if (isForeign) {
    return (
      <>
        <CtxHeader title={session.title || "Session"} />
        {onOpen && <CtxItem icon={ExternalLink} onSelect={onOpen}>Open</CtxItem>}
        <CtxItem icon={ExternalLink} onSelect={() => window.open(`/conversation/${id}`, "_blank")}>
          Open in new tab
        </CtxItem>
        <CtxSeparator />
        <CtxItem icon={Copy} onSelect={() => { copyToClipboard(id); toast.success("Copied session ID"); }}>
          Copy session ID
        </CtxItem>
        <CtxItem icon={LinkIcon} shortcut="conv.copyLink" onSelect={copyLink}>Copy link</CtxItem>
      <ForwardCtxItem url={`${shareOrigin()}/conversation/${id}`} label="session" />
      </>
    );
  }

  return (
    <>
      <CtxHeader title={session.title || "Session"} />
      {onOpen && <CtxItem icon={ExternalLink} onSelect={onOpen}>Open</CtxItem>}
      <CtxItem icon={ExternalLink} onSelect={() => window.open(`/conversation/${id}`, "_blank")}>
        Open in new tab
      </CtxItem>
      <CtxSeparator />
      <CtxItem
        icon={session.is_pinned ? PinOff : Pin}
        shortcut="session.pin"
        onSelect={() => {
          useInboxStore.getState().pinSession(id);
          toast.success(session.is_pinned ? "Unpinned" : "Pinned");
        }}
      >
        {session.is_pinned ? "Unpin session" : "Pin session"}
      </CtxItem>
      <CtxItem
        icon={Star}
        shortcut="conv.favorite"
        onSelect={() => {
          useInboxStore.getState().toggleFavorite(id);
          toast.success(session.is_favorite ? "Removed from favorites" : "Added to favorites");
        }}
      >
        {session.is_favorite ? "Remove from favorites" : "Add to favorites"}
      </CtxItem>
      <CtxSub>
        <CtxSubTrigger icon={Tag}>Label</CtxSubTrigger>
        <CtxSubContent className="min-w-[190px]">
          {labels.map((b: any) => {
            const color = getLabelColor(b.name || "");
            return (
              <CtxItem
                key={b._id}
                leading={<span className={cn("inline-block size-2 rounded-full shrink-0", color.dot)} />}
                trailing={currentBucketId === b._id ? <Check className="size-3.5 text-sol-cyan" /> : undefined}
                onSelect={() => {
                  useInboxStore.getState().assignSessionToBucket(id, b._id);
                  toast.success(`Filed under "${b.name}"`);
                }}
              >
                {b.name}
              </CtxItem>
            );
          })}
          {currentBucketId && (
            <CtxItem
              onSelect={() => {
                useInboxStore.getState().assignSessionToBucket(id, null);
                toast.success("Label removed");
              }}
            >
              Remove label
            </CtxItem>
          )}
          {(labels.length > 0 || currentBucketId) && <CtxSeparator />}
          <CtxItem shortcut="session.moveToBucket" onSelect={() => openPaletteMode([session], "session", "bucket")}>
            New label…
          </CtxItem>
        </CtxSubContent>
      </CtxSub>
      {canControlModel(session.agent_type, (session.message_count ?? 0) === 0) && (
        <CtxItem icon={Cpu} onSelect={() => openPaletteMode([session], "session", "model")}>
          Change model &amp; effort…
        </CtxItem>
      )}
      {onRename && (
        <CtxItem icon={Pencil} shortcut="session.rename" onSelect={onRename}>Rename</CtxItem>
      )}
      <CtxSeparator />
      <CtxItem icon={Copy} onSelect={() => { copyToClipboard(id); toast.success("Copied session ID"); }}>
        Copy session ID
      </CtxItem>
      <CtxItem icon={LinkIcon} shortcut="conv.copyLink" onSelect={copyLink}>Copy link</CtxItem>
      <ForwardCtxItem url={`${shareOrigin()}/conversation/${id}`} label="session" />
      <CtxSeparator />
      <CtxItem
        icon={Archive}
        shortcut="session.stash"
        onSelect={onStash ?? (() => undoableHideSession(id, "stash"))}
      >
        Stash
      </CtxItem>
      <CtxItem
        icon={EyeOff}
        shortcut="session.stashHide"
        onSelect={() => undoableHideSession(id, "stash", { hidden: true })}
      >
        Stash and hide — stays out through trigger wakes
      </CtxItem>
      <CtxItem
        icon={Clock}
        shortcut="session.deferAdvance"
        onSelect={onDefer ?? (() => undoableDeferSession(id))}
      >
        Defer
      </CtxItem>
      <CtxItem
        icon={Moon}
        shortcut="session.dormantAdvance"
        onSelect={() => undoableDormantSession(id)}
      >
        Dormant — a machine wakes it
      </CtxItem>
      {onKill && (
        <CtxItem danger icon={Square} shortcut="session.kill" onSelect={onKill}>
          Kill session
        </CtxItem>
      )}
    </>
  );
}

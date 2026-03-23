"use client";
import { useCallback, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useInboxStore, DocDetail } from "../../../store/inboxStore";
import { useSyncDocs, useSyncDocDetail } from "../../../hooks/useSyncDocs";
import { DetailSplitLayout } from "../../../components/DetailSplitLayout";
import { DocListContent } from "../page";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { DocumentDetailLayout } from "../../../components/DocumentDetailLayout";
import { SessionCardInner } from "../../../components/ActivityFeed";
import { Badge } from "../../../components/ui/badge";
import "../../../components/editor/editor.css";
import {
  Pin,
  Archive,
  Clock,
  Circle,
  CircleDot,
  CheckCircle2,
  XCircle,
  CircleDotDashed,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  Tag,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

const api = _api as any;

const DOC_TYPE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  plan: { label: "Plan", color: "text-sol-blue", bg: "bg-sol-blue/10 border-sol-blue/30" },
  design: { label: "Design", color: "text-sol-violet", bg: "bg-sol-violet/10 border-sol-violet/30" },
  spec: { label: "Spec", color: "text-sol-cyan", bg: "bg-sol-cyan/10 border-sol-cyan/30" },
  investigation: { label: "Investigation", color: "text-sol-yellow", bg: "bg-sol-yellow/10 border-sol-yellow/30" },
  handoff: { label: "Handoff", color: "text-sol-orange", bg: "bg-sol-orange/10 border-sol-orange/30" },
  note: { label: "Note", color: "text-sol-text-muted", bg: "bg-sol-text-muted/10 border-sol-text-muted/30" },
};

const STATUS_CONFIG: Record<string, { icon: typeof Circle; label: string; color: string }> = {
  draft: { icon: CircleDotDashed, label: "Draft", color: "text-sol-text-dim" },
  open: { icon: Circle, label: "Open", color: "text-sol-blue" },
  in_progress: { icon: CircleDot, label: "In Progress", color: "text-sol-yellow" },
  in_review: { icon: CircleDot, label: "In Review", color: "text-sol-violet" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green" },
  dropped: { icon: XCircle, label: "Dropped", color: "text-sol-text-dim" },
};

const PRIORITY_CONFIG: Record<string, { icon: typeof Minus; label: string; color: string }> = {
  urgent: { icon: AlertTriangle, label: "Urgent", color: "text-sol-red" },
  high: { icon: ArrowUp, label: "High", color: "text-sol-orange" },
  medium: { icon: Minus, label: "Medium", color: "text-sol-text-muted" },
  low: { icon: ArrowDown, label: "Low", color: "text-sol-text-dim" },
  none: { icon: Minus, label: "None", color: "text-sol-text-dim" },
};

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DocTypeSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const type = DOC_TYPE_CONFIG[value] || DOC_TYPE_CONFIG.note;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`text-xs px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${type.color} ${type.bg} hover:opacity-80`}
      >
        {type.label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl py-1 z-50 min-w-[130px]">
            {Object.entries(DOC_TYPE_CONFIG).map(([key, cfg]) => (
              <button
                key={key}
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  key === value
                    ? "bg-sol-bg-highlight text-sol-text"
                    : "text-sol-text-muted hover:bg-sol-bg-alt"
                }`}
              >
                <span className={cfg.color}>{cfg.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function DocDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  useSyncDocDetail(id);
  useSyncDocs();

  const allDocs = useInboxStore((s) => s.docs);
  const detail = useInboxStore((s) => s.docDetails[id]) as DocDetail | undefined;
  const listItem = allDocs[id];
  const data = detail || (listItem as DocDetail | undefined);
  const updateDoc = useInboxStore((s) => s.updateDoc);
  const pinDoc = useInboxStore((s) => s.pinDoc);
  const archiveDoc = useInboxStore((s) => s.archiveDoc);
  const openSidePanel = useInboxStore((s) => s.openSidePanel);
  const promoteToPlan = useMutation(api.docs.webPromoteToPlan);

  const sidebar = <DocListContent />;

  const handleTitleChange = useCallback(
    (title: string) => {
      if (!data) return;
      updateDoc(data._id, { title });
    },
    [data, updateDoc]
  );

  const handlePin = useCallback(async () => {
    if (!data) return;
    await pinDoc(data._id, !data.pinned);
  }, [data, pinDoc]);

  const handleArchive = useCallback(async () => {
    if (!data) return;
    await archiveDoc(data._id);
    router.push("/docs");
  }, [data, archiveDoc, router]);

  const handleTypeChange = useCallback(
    async (newType: string) => {
      if (!data) return;
      if (newType === "plan" && !(data as any).plan_id) {
        const result = await promoteToPlan({ doc_id: data._id as any });
        if (result?.short_id) {
          toast.success("Promoted to plan");
          router.push(`/plans/${result.short_id}`);
          return;
        }
      }
      updateDoc(data._id, { doc_type: newType });
    },
    [data, updateDoc, promoteToPlan, router]
  );

  if (!data) {
    return (
      <DetailSplitLayout list={sidebar}>
        <div className="flex items-center justify-center h-64 text-sol-text-dim text-sm">
          Loading...
        </div>
      </DetailSplitLayout>
    );
  }

  const doc = data;
  const conversation = data.conversation;
  const relatedTasks = data.related_tasks || [];
  const hasRelatedContent =
    (doc as any).active_plan ||
    ((doc as any).related_conversations?.length > 0 || conversation) ||
    relatedTasks.length > 0;

  return (
    <DetailSplitLayout list={sidebar}>
    <div className="h-full min-w-0">
        <DocumentDetailLayout
          docId={doc._id}
          title={(doc as any).display_title ?? doc.title}
          markdownContent={doc.content}
          onTitleChange={handleTitleChange}
          backHref="/docs"
          linkedObjectId={doc._id}
          placeholder="Start typing or insert using /"
          topBarLeft={
            <>
              <DocTypeSelector value={doc.doc_type} onChange={handleTypeChange} />
              {doc.pinned && <Pin className="w-3 h-3 text-sol-yellow" />}
            </>
          }
          topBarRight={
            <>
              <button
                onClick={handlePin}
                className={`p-1.5 rounded-md transition-colors ${doc.pinned ? "text-sol-yellow" : "text-sol-text-dim hover:text-sol-yellow"}`}
                title={doc.pinned ? "Unpin" : "Pin"}
              >
                <Pin className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleArchive}
                className="p-1.5 rounded-md text-sol-text-dim hover:text-sol-red transition-colors"
                title="Archive"
              >
                <Archive className="w-3.5 h-3.5" />
              </button>
            </>
          }
          metaContent={
            <div className="flex items-center gap-4 text-xs text-sol-text-dim flex-wrap">
              {(doc as any).author_image && (
                <span className="flex items-center gap-1.5">
                  <img
                    src={(doc as any).author_image}
                    alt={(doc as any).author_name || ""}
                    className="w-4 h-4 rounded-full object-cover"
                  />
                  <span className="text-sol-text-muted">{(doc as any).author_name}</span>
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatDate(doc.created_at)}
              </span>
              {doc.updated_at !== doc.created_at && (
                <span>Updated {formatDate(doc.updated_at)}</span>
              )}
              {doc.labels && doc.labels.length > 0 && (
                <span className="flex items-center gap-1.5">
                  <Tag className="w-3 h-3" />
                  {doc.labels.map((l: string) => (
                    <Badge
                      key={l}
                      variant="outline"
                      className="text-[10px] border-sol-border/50 text-sol-text-muted"
                    >
                      {l}
                    </Badge>
                  ))}
                </span>
              )}
            </div>
          }
        >
          {hasRelatedContent && (
            <>
              {(doc as any).active_plan && (
                <div className="mb-8">
                  <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wider mb-3">
                    Plan
                  </h2>
                  <Link
                    href={`/plans/${(doc as any).active_plan._id}`}
                    className="flex items-center gap-2.5 px-4 py-3 border border-sol-border/20 rounded-lg hover:bg-sol-bg-alt/50 transition-colors group"
                  >
                    <CircleDot className="w-4 h-4 text-sol-cyan flex-shrink-0" />
                    <span className="text-sm font-medium text-sol-text group-hover:text-sol-cyan transition-colors">
                      {(doc as any).active_plan.title}
                    </span>
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 text-sol-cyan border-sol-cyan/30 ml-auto"
                    >
                      {(doc as any).active_plan.status}
                    </Badge>
                  </Link>
                </div>
              )}

              {((doc as any).related_conversations?.length > 0 || conversation) && (
                <div className="mb-8">
                  <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wider mb-3">
                    Sessions
                  </h2>
                  <div className="space-y-1.5">
                    {((doc as any).related_conversations ||
                      (conversation ? [conversation] : [])
                    ).map((conv: any) => (
                      <SessionCardInner
                        key={conv._id || conv.session_id}
                        item={{ ...conv, conversation_id: conv._id }}
                        compact
                        onNavigate={(id) => openSidePanel(id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {relatedTasks.length > 0 && (
                <div className="mb-8">
                  <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wider mb-3">
                    Related Tasks
                  </h2>
                  <div className="border border-sol-border/20 rounded-lg divide-y divide-sol-border/10 overflow-hidden">
                    {relatedTasks.map((task: any) => {
                      const status = STATUS_CONFIG[task.status] || STATUS_CONFIG.open;
                      const priority = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG.medium;
                      const StatusIcon = status.icon;
                      const PriorityIcon = priority.icon;
                      return (
                        <Link
                          key={task._id}
                          href={`/tasks/${task._id}`}
                          className="flex items-center gap-3 px-4 py-3 hover:bg-sol-bg-alt/50 transition-colors"
                        >
                          <StatusIcon className={`w-4 h-4 flex-shrink-0 ${status.color}`} />
                          <span className="text-xs font-mono text-sol-text-dim w-16 flex-shrink-0">
                            {task.short_id}
                          </span>
                          <span className="flex-1 text-sm text-sol-text truncate">
                            {task.title}
                          </span>
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1.5 py-0 ${status.color} border-current/30`}
                          >
                            {status.label}
                          </Badge>
                          <PriorityIcon className={`w-3.5 h-3.5 flex-shrink-0 ${priority.color}`} />
                        </Link>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </DocumentDetailLayout>
    </div>
    </DetailSplitLayout>
  );
}

"use client";
import { useCallback, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useInboxStore, DocDetail } from "../../../store/inboxStore";
import { useSyncDocDetail } from "../../../hooks/useSyncDocs";
import { DetailSplitLayout } from "../../../components/DetailSplitLayout";
import { DocListContent } from "../page";
import { shareOrigin, copyToClipboard } from "../../../lib/utils";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { DocumentDetailLayout } from "../../../components/DocumentDetailLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { SessionCardInner } from "../../../components/ActivityFeed";
import { WatchButton } from "../../../components/WatchButton";
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
  Link2,
  Check,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { undoableArchiveDoc } from "../../../store/undoActions";

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
  return (
    <DetailSplitLayout list={<DocListContent />}>
      <ErrorBoundary name="DocDetail" level="panel">
        <DocDetailContent />
      </ErrorBoundary>
    </DetailSplitLayout>
  );
}

function DocDetailContent() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  useSyncDocDetail(id);

  const detail = useInboxStore((s) => s.docDetails[id]) as DocDetail | undefined;
  const listItem = useInboxStore((s) => s.docs[id]) as DocDetail | undefined;
  const allDocs = useInboxStore((s) => s.docs);
  const data = detail || listItem;

  // Compute backlinks: docs that link to this doc via linked_doc_ids
  const backlinks = useMemo(() => {
    return Object.values(allDocs).filter(
      (d) => d._id !== id && d.linked_doc_ids?.includes(id)
    );
  }, [allDocs, id]);
  // Child docs (pages nested under this doc)
  const childDocs = useMemo(() => {
    return Object.values(allDocs)
      .filter((d) => d.parent_id === id)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }, [allDocs, id]);
  const updateDoc = useInboxStore((s) => s.updateDoc);
  const pinDoc = useInboxStore((s) => s.pinDoc);
  const promoteToPlan = useMutation(api.docs.webPromoteToPlan);
  const generateShareLink = useMutation(api.docs.generateShareLink);
  const [shareCopied, setShareCopied] = useState(false);

  const handleShare = useCallback(async () => {
    if (!data) return;
    try {
      const result = await generateShareLink({ id: data._id as any });
      const url = `${shareOrigin()}/share/doc/${result.share_token}`;
      await copyToClipboard(url);
      setShareCopied(true);
      toast.success("Share link copied to clipboard");
      setTimeout(() => setShareCopied(false), 2000);
    } catch (e: any) {
      toast.error(e.message || "Failed to generate share link");
    }
  }, [data, generateShareLink]);

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

  const handleArchive = useCallback(() => {
    if (!data) return;
    undoableArchiveDoc(data._id);
    router.push("/docs");
  }, [data, router]);

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
      <div className="flex items-center justify-center h-64 text-sol-text-dim text-sm">
        Loading...
      </div>
    );
  }

  const doc = data;
  const conversation = data.conversation;
  const relatedTasks = data.related_tasks || [];

  const hasRelatedContent =
    (doc as any).active_plan ||
    childDocs.length > 0 ||
    backlinks.length > 0 ||
    ((doc as any).related_conversations?.length > 0 || conversation) ||
    relatedTasks.length > 0;

  return (
    <div className="h-full min-w-0">
        <DocumentDetailLayout
          docId={doc._id}
          title={(doc as any).display_title ?? doc.title}
          markdownContent={listItem?.content || doc.content || ""}
          onTitleChange={handleTitleChange}
          backHref="/docs"
          linkedObjectId={doc._id}
          placeholder="Start typing or insert using /"
          cliEditedAt={(doc as any).cli_edited_at}
          topBarLeft={
            <>
              <DocTypeSelector value={doc.doc_type} onChange={handleTypeChange} />
              {doc.pinned && <Pin className="w-3 h-3 text-sol-yellow" />}
              <WatchButton entityType="doc" entityId={doc._id} />
            </>
          }
          topBarRight={
            <>
              <button
                onClick={handleShare}
                className={`p-1.5 rounded-md transition-colors ${shareCopied ? "text-sol-green" : "text-sol-text-dim hover:text-sol-cyan"}`}
                title="Copy share link"
              >
                {shareCopied ? <Check className="w-3.5 h-3.5" /> : <Link2 className="w-3.5 h-3.5" />}
              </button>
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
              {(doc as any).author_image && (() => {
                const authorContent = (
                  <span className="flex items-center gap-1.5 hover:opacity-80">
                    <img
                      src={(doc as any).author_image}
                      alt={(doc as any).author_name || ""}
                      className="w-4 h-4 rounded-full object-cover"
                    />
                    <span className="text-sol-text-muted">{(doc as any).author_name}</span>
                  </span>
                );
                return (doc as any).author_username
                  ? <Link href={`/team/${(doc as any).author_username}`}>{authorContent}</Link>
                  : authorContent;
              })()}
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
                    <Link key={l} href={`/docs?label=${encodeURIComponent(l)}`}>
                      <Badge
                        variant="outline"
                        className="text-[10px] border-sol-border/50 text-sol-text-muted hover:brightness-90 transition-all cursor-pointer"
                      >
                        {l}
                      </Badge>
                    </Link>
                  ))}
                </span>
              )}
            </div>
          }
          footerContent={
            ((doc as any).related_conversations?.length > 0 || conversation) ? (
              <div>
                <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wider mb-3">
                  Sessions
                </h2>
                <div className="space-y-1.5">
                  {((doc as any).related_conversations ||
                    (conversation ? [conversation] : [])
                  ).map((conv: any) => {
                    const sid = conv._id;
                    return (
                    <SessionCardInner
                      key={conv._id}
                      item={{ ...conv, conversation_id: sid }}
                      compact
                      onNavigate={() => {
                        const store = useInboxStore.getState();
                        if (!store.sessions[sid]) {
                          store.syncRecord('sessions', sid, {
                            _id: conv._id,
                            session_id: conv.session_id || conv._id,
                            title: conv.title,
                            project_path: conv.project_path,
                            message_count: conv.message_count || 0,
                            updated_at: conv.updated_at,
                            started_at: conv.started_at,
                            agent_type: conv.agent_type || 'claude',
                            is_idle: !conv.is_active,
                            has_pending: false,
                          });
                        }
                        store.openSidePanel(sid);
                      }}
                    />
                    );
                  })}
                </div>
              </div>
            ) : undefined
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

              {childDocs.length > 0 && (
                <div className="mb-8">
                  <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wider mb-3">
                    Sub-pages
                  </h2>
                  <div className="border border-sol-border/20 rounded-lg divide-y divide-sol-border/10 overflow-hidden">
                    {childDocs.map((child) => {
                      const typeConf = DOC_TYPE_CONFIG[child.doc_type] || DOC_TYPE_CONFIG.note;
                      return (
                        <Link
                          key={child._id}
                          href={`/docs/${child._id}`}
                          className="flex items-center gap-3 px-4 py-3 hover:bg-sol-bg-alt/50 transition-colors"
                        >
                          <svg className="w-4 h-4 flex-shrink-0 text-sol-text-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                          </svg>
                          <span className="flex-1 text-sm text-sol-text truncate">
                            {child.title || "Untitled"}
                          </span>
                          <span className={`text-[10px] ${typeConf.color}`}>{typeConf.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              )}

              {backlinks.length > 0 && (
                <div className="mb-8">
                  <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wider mb-3">
                    Backlinks
                  </h2>
                  <div className="border border-sol-border/20 rounded-lg divide-y divide-sol-border/10 overflow-hidden">
                    {backlinks.map((bl) => (
                      <Link
                        key={bl._id}
                        href={`/docs/${bl._id}`}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-sol-bg-alt/50 transition-colors"
                      >
                        <svg className="w-4 h-4 flex-shrink-0 text-sol-cyan/60" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.686-5.781a4.5 4.5 0 00-6.364-6.364L4.5 8.25a4.5 4.5 0 006.364 6.364l4.5-4.5z" />
                        </svg>
                        <span className="flex-1 text-sm text-sol-text truncate">
                          {bl.title || "Untitled"}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </DocumentDetailLayout>
    </div>
  );
}

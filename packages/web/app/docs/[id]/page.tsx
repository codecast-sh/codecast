import { useCallback, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useInboxStore, DocDetail } from "../../../store/inboxStore";
import { useSyncDocDetail } from "../../../hooks/useSyncDocs";
import { useMutation, useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { Badge } from "../../../components/ui/badge";
import { DocEditor } from "../../../components/editor/DocEditor";
import type { MentionItem } from "../../../components/editor/MentionList";
import "../../../components/editor/editor.css";
import {
  ArrowLeft,
  Pin,
  Archive,
  Clock,
  MessageSquare,
  ExternalLink,
  Circle,
  CircleDot,
  CheckCircle2,
  XCircle,
  CircleDotDashed,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  Edit3,
  Eye,
  Save,
  Tag,
} from "lucide-react";
import Link from "next/link";

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

function InlineTitle({
  value,
  onChange,
  onBlur,
  editable,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  editable: boolean;
}) {
  if (!editable) {
    return (
      <h1 className="text-xl font-semibold text-sol-text leading-tight">{value}</h1>
    );
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className="text-xl font-semibold text-sol-text leading-tight bg-transparent border-none outline-none w-full placeholder:text-sol-text-dim"
      placeholder="Untitled"
    />
  );
}

export default function DocDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  useSyncDocDetail(id);

  const detail = useInboxStore((s) => s.docDetails[id]) as DocDetail | undefined;
  const listItem = useInboxStore((s) => s.docs[id]);
  const data = detail || (listItem as DocDetail | undefined);
  const pinDoc = useInboxStore((s) => s.pinDoc);
  const archiveDoc = useInboxStore((s) => s.archiveDoc);

  const webUpdate = useMutation(api.docs.webUpdate);
  const mentionResults = useQuery(api.docs.mentionSearch, { query: "", limit: 20 });

  const [isEditing, setIsEditing] = useState(true);
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "idle">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleContentUpdate = useCallback(
    (markdown: string) => {
      if (!data) return;
      setSaveStatus("saving");
      webUpdate({ id: data._id as any, content: markdown })
        .then(() => {
          setSaveStatus("saved");
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
        })
        .catch(() => setSaveStatus("idle"));
    },
    [data, webUpdate]
  );

  const handleTitleBlur = useCallback(() => {
    if (!data || editTitle === null || editTitle === data.title) return;
    webUpdate({ id: data._id as any, title: editTitle });
  }, [data, editTitle, webUpdate]);

  const handleMentionQuery = useCallback(
    async (query: string): Promise<MentionItem[]> => {
      if (!mentionResults) return [];
      const q = query.toLowerCase();
      if (!q) return mentionResults;
      return mentionResults.filter(
        (r: MentionItem) =>
          r.label.toLowerCase().includes(q) ||
          (r.sublabel && r.sublabel.toLowerCase().includes(q))
      );
    },
    [mentionResults]
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
    (newType: string) => {
      if (!data) return;
      webUpdate({ id: data._id as any, doc_type: newType });
    },
    [data, webUpdate]
  );

  if (!data) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <div className="flex items-center justify-center h-64 text-sol-text-dim text-sm">
            Loading...
          </div>
        </DashboardLayout>
      </AuthGuard>
    );
  }

  const doc = data;
  const conversation = data.conversation;
  const relatedTasks = data.related_tasks || [];
  const displayTitle = editTitle ?? (doc as any).display_title ?? doc.title;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="py-2 max-w-4xl mx-auto">
          {/* Top bar */}
          <div className="flex items-center justify-between mb-5">
            <Link
              href="/docs"
              className="inline-flex items-center gap-1.5 text-sm text-sol-text-dim hover:text-sol-cyan transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Documents
            </Link>
            <div className="flex items-center gap-2">
              {saveStatus === "saving" && (
                <span className="text-xs text-sol-text-dim animate-pulse">Saving...</span>
              )}
              {saveStatus === "saved" && (
                <span className="text-xs text-sol-green flex items-center gap-1">
                  <Save className="w-3 h-3" /> Saved
                </span>
              )}
              <button
                onClick={() => setIsEditing(!isEditing)}
                className={`p-1.5 rounded-md text-xs flex items-center gap-1.5 transition-colors ${
                  isEditing
                    ? "bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30"
                    : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt border border-sol-border/30"
                }`}
              >
                {isEditing ? (
                  <>
                    <Edit3 className="w-3.5 h-3.5" /> Editing
                  </>
                ) : (
                  <>
                    <Eye className="w-3.5 h-3.5" /> Viewing
                  </>
                )}
              </button>
              <button
                onClick={handlePin}
                className="p-2 rounded-lg text-sol-text-dim hover:text-sol-yellow hover:bg-sol-bg-alt transition-colors"
                title={doc.pinned ? "Unpin" : "Pin"}
              >
                <Pin className="w-4 h-4" />
              </button>
              <button
                onClick={handleArchive}
                className="p-2 rounded-lg text-sol-text-dim hover:text-sol-red hover:bg-sol-bg-alt transition-colors"
                title="Archive"
              >
                <Archive className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Doc type + title */}
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-2">
              <DocTypeSelector
                value={doc.doc_type}
                onChange={handleTypeChange}
              />
              {doc.pinned && <Pin className="w-3.5 h-3.5 text-sol-yellow" />}
            </div>
            <InlineTitle
              value={displayTitle}
              onChange={(v) => { setEditTitle(v); }}
              onBlur={handleTitleBlur}
              editable={isEditing}
            />
          </div>

          {/* Metadata */}
          <div className="flex items-center gap-4 text-xs text-sol-text-dim mb-5 flex-wrap">
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
          </div>

          {/* Labels */}
          {doc.labels && doc.labels.length > 0 && (
            <div className="flex gap-1.5 mb-5 items-center">
              <Tag className="w-3 h-3 text-sol-text-dim" />
              {doc.labels.map((l: string) => (
                <Badge
                  key={l}
                  variant="outline"
                  className="text-xs border-sol-border/50 text-sol-text-muted"
                >
                  {l}
                </Badge>
              ))}
            </div>
          )}

          {/* Editor */}
          <div className="border border-sol-border/20 rounded-lg bg-sol-bg-alt/20 p-6 mb-1">
            <DocEditor
              key={doc._id}
              content={doc.content}
              onUpdate={handleContentUpdate}
              onMentionQuery={handleMentionQuery}
              editable={isEditing}
            />
          </div>
          {isEditing && (
            <div className="flex items-center gap-4 text-[10px] text-sol-text-dim mb-8 px-1">
              <span>/ commands</span>
              <span>@ mention</span>
              <span className="opacity-60">Markdown supported</span>
            </div>
          )}

          {/* Plan */}
          {(doc as any).active_plan && (
            <div className="mb-8">
              <h2 className="text-sm font-medium text-sol-text-dim uppercase tracking-wide mb-3">
                Plan
              </h2>
              <Link
                href={`/plans/${(doc as any).active_plan._id}`}
                className="flex items-center gap-2.5 px-4 py-3 border border-sol-border/30 rounded-lg hover:bg-sol-bg-alt/50 transition-colors group"
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

          {/* Sessions */}
          {((doc as any).related_conversations?.length > 0 || conversation) && (
            <div className="mb-8">
              <h2 className="text-sm font-medium text-sol-text-dim uppercase tracking-wide mb-3">
                Sessions
              </h2>
              <div className="border border-sol-border/30 rounded-lg divide-y divide-sol-border/20 overflow-hidden">
                {((doc as any).related_conversations ||
                  (conversation ? [conversation] : [])
                ).map((conv: any) => (
                  <Link
                    key={conv._id || conv.session_id}
                    href={`/conversation/${conv.session_id || conv.short_id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-sol-bg-alt/50 transition-colors group"
                  >
                    <MessageSquare className="w-4 h-4 text-sol-text-dim flex-shrink-0" />
                    <span className="flex-1 text-sm text-sol-text truncate group-hover:text-sol-cyan">
                      {conv.title || "Untitled Session"}
                    </span>
                    {conv.project_path && (
                      <span className="text-[10px] font-mono text-sol-text-dim truncate max-w-[200px]">
                        {conv.project_path.split("/").slice(-2).join("/")}
                      </span>
                    )}
                    <span className="text-xs text-sol-text-dim tabular-nums flex-shrink-0">
                      {conv.message_count && `${conv.message_count} msgs`}
                    </span>
                    <ExternalLink className="w-3 h-3 text-sol-text-dim opacity-0 group-hover:opacity-100 flex-shrink-0" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Related Tasks */}
          {relatedTasks.length > 0 && (
            <div className="mb-8">
              <h2 className="text-sm font-medium text-sol-text-dim uppercase tracking-wide mb-3">
                Related Tasks
              </h2>
              <div className="border border-sol-border/30 rounded-lg divide-y divide-sol-border/20 overflow-hidden">
                {relatedTasks.map((task: any) => {
                  const status = STATUS_CONFIG[task.status] || STATUS_CONFIG.open;
                  const priority =
                    PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG.medium;
                  const StatusIcon = status.icon;
                  const PriorityIcon = priority.icon;
                  return (
                    <Link
                      key={task._id}
                      href={`/tasks/${task._id}`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-sol-bg-alt/50 transition-colors"
                    >
                      <StatusIcon
                        className={`w-4 h-4 flex-shrink-0 ${status.color}`}
                      />
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
                      <PriorityIcon
                        className={`w-3.5 h-3.5 flex-shrink-0 ${priority.color}`}
                      />
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}

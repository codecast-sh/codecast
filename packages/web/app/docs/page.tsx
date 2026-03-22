import { useRouter } from "next/navigation";
import { useInboxStore, DocItem } from "../../store/inboxStore";
import { useSyncDocs } from "../../hooks/useSyncDocs";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { Badge } from "../../components/ui/badge";
import {
  FileText,
  Search,
  Pin,
  FolderGit2,
  Plus,
} from "lucide-react";

const api = _api as any;

const DOC_TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  plan: { label: "Plan", color: "text-sol-blue" },
  design: { label: "Design", color: "text-sol-violet" },
  spec: { label: "Spec", color: "text-sol-cyan" },
  investigation: { label: "Investigation", color: "text-sol-yellow" },
  handoff: { label: "Handoff", color: "text-sol-orange" },
  note: { label: "Note", color: "text-sol-text-muted" },
};

function shortProject(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function dateKey(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const docDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (docDay.getTime() === today.getTime()) return "Today";
  if (docDay.getTime() === yesterday.getTime()) return "Yesterday";

  const diffDays = Math.floor((today.getTime() - docDay.getTime()) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "long" });

  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function extractPreview(content: string): string {
  const lines = content.split("\n");
  const body: string[] = [];
  let pastTitle = false;
  for (const line of lines) {
    if (!pastTitle && line.startsWith("# ")) {
      pastTitle = true;
      continue;
    }
    if (!pastTitle) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("|") || trimmed.startsWith("---")) continue;
    if (trimmed.startsWith("```")) continue;
    body.push(trimmed.replace(/^\*\*(.+?)\*\*:?/, "$1:").replace(/^[*-]\s+/, ""));
    if (body.join(" ").length > 400) break;
  }
  return body.join(" ").slice(0, 400);
}

function DocCard({ doc, onClick }: { doc: DocItem; onClick: () => void }) {
  const type = DOC_TYPE_CONFIG[doc.doc_type] || DOC_TYPE_CONFIG.note;
  const preview = doc.content ? extractPreview(doc.content) : "";
  const effectiveDate = (doc as any).originated_at || doc.created_at;

  return (
    <button
      onClick={onClick}
      className="w-full text-left group relative pl-8"
    >
      {/* Timeline avatar or dot */}
      {(doc as any).author_image ? (
        <img
          src={(doc as any).author_image}
          alt={(doc as any).author_name || ""}
          title={(doc as any).author_name || ""}
          className="absolute left-[5px] top-4 w-5 h-5 rounded-full ring-2 ring-sol-bg z-10 object-cover"
        />
      ) : (
        <div className="absolute left-[11px] top-5 w-2 h-2 rounded-full bg-sol-border group-hover:bg-sol-cyan transition-colors z-10" />
      )}

      <div className="py-4 pr-5 pl-4 hover:bg-sol-bg-alt/40 transition-colors rounded-r-lg">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${type.color} border-current/30 flex-shrink-0`}>
                {type.label}
              </Badge>
              <span className="text-sm font-medium text-sol-text group-hover:text-sol-cyan transition-colors truncate">
                {(doc as any).display_title || doc.title}
              </span>
              {doc.pinned && <Pin className="w-3 h-3 text-sol-yellow flex-shrink-0" />}
            </div>
            {(doc as any).plan_name && (
              <span className="text-[11px] text-sol-text-dim mb-1 block">{(doc as any).plan_name}</span>
            )}
            {preview && (
              <p className="text-xs text-sol-text-muted/80 leading-relaxed line-clamp-3 mt-1">
                {preview}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0 pt-0.5">
            <span className="text-[11px] text-sol-text-dim tabular-nums">{formatTime(effectiveDate)}</span>
            {(doc as any).project_path && (
              <span className="text-[10px] font-mono text-sol-text-dim truncate max-w-[120px]">
                {shortProject((doc as any).project_path)}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

function DateSeparator({ label }: { label: string }) {
  return (
    <div className="relative pl-8 py-2">
      <div className="absolute left-[7px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-sol-bg border-2 border-sol-text-dim z-10" />
      <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wider">{label}</span>
    </div>
  );
}

export default function DocsPage() {
  const router = useRouter();
  const docFilter = useInboxStore((s) => s.docFilter);
  const setDocFilter = useInboxStore((s) => s.setDocFilter);
  const docs = useInboxStore((s) => s.docs);
  const projectPaths = useInboxStore((s) => s.docProjectPaths);
  const createDoc = useMutation(api.docs.webCreate);

  useSyncDocs(docFilter.type || undefined, docFilter.query || undefined, docFilter.project || undefined);

  const handleNewDoc = async () => {
    const result = await createDoc({ title: "Untitled", content: "" });
    if (result?.id) router.push(`/docs/${result.id}`);
  };

  const docsList = Object.values(docs);

  // Group docs by date
  const grouped: { key: string; docs: DocItem[] }[] = [];
  let currentKey = "";
  for (const doc of docsList) {
    const effectiveDate = (doc as any).originated_at || doc.created_at;
    const key = dateKey(effectiveDate);
    if (key !== currentKey) {
      currentKey = key;
      grouped.push({ key, docs: [] });
    }
    grouped[grouped.length - 1].docs.push(doc);
  }

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-full flex flex-col">
          <div className="px-6 py-4 border-b border-sol-border/30">
            <div className="flex items-center justify-between mb-3">
              <h1 className="text-lg font-semibold text-sol-text tracking-tight">Documents</h1>
              <button
                onClick={handleNewDoc}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/20 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                New
              </button>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sol-text-dim" />
                <input
                  value={docFilter.query}
                  onChange={(e) => setDocFilter({ query: e.target.value })}
                  placeholder="Search documents..."
                  className="w-full text-sm pl-9 pr-3 py-2 rounded-lg bg-sol-bg-alt border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan"
                />
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => setDocFilter({ type: "" })}
                  className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                    !docFilter.type ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                  }`}
                >
                  All
                </button>
                {Object.entries(DOC_TYPE_CONFIG).map(([key, cfg]) => (
                  <button
                    key={key}
                    onClick={() => setDocFilter({ type: key })}
                    className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                      docFilter.type === key ? `bg-sol-bg-highlight ${cfg.color}` : `${cfg.color} opacity-50 hover:opacity-100`
                    }`}
                  >
                    {cfg.label}
                  </button>
                ))}
              </div>
            </div>
            {projectPaths.length > 1 && (
              <div className="flex items-center gap-1 mt-2 overflow-x-auto scrollbar-auto">
                <FolderGit2 className="w-3 h-3 text-sol-text-dim flex-shrink-0" />
                <button
                  onClick={() => setDocFilter({ project: "" })}
                  className={`text-xs px-2 py-0.5 rounded-md transition-colors flex-shrink-0 ${
                    !docFilter.project ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                  }`}
                >
                  All
                </button>
                {projectPaths.map((p) => (
                  <button
                    key={p}
                    onClick={() => setDocFilter({ project: p })}
                    className={`text-xs px-2 py-0.5 rounded-md transition-colors whitespace-nowrap flex-shrink-0 ${
                      docFilter.project === p ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                    }`}
                  >
                    {shortProject(p)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-2">
            {docsList.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-sol-text-dim">
                <FileText className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">No documents found</p>
              </div>
            ) : (
              <div className="relative">
                {/* Timeline line */}
                <div className="absolute left-[14px] top-4 bottom-4 w-px bg-sol-border/50" />
                {grouped.map((group) => (
                  <div key={group.key}>
                    <DateSeparator label={group.key} />
                    {group.docs.map((d) => (
                      <DocCard key={d._id} doc={d} onClick={() => router.push(
                        (d as any).plan_short_id ? `/plans/${(d as any).plan_short_id}` : `/docs/${d._id}`
                      )} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </DashboardLayout>
    </AuthGuard>
  );
}

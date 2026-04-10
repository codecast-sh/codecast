"use client";
import { useCallback, useMemo, useRef, useEffect } from "react";
import { useRouter, useSearchParams, useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { useInboxStore, DocItem, DocViewPrefs } from "../../store/inboxStore";
import { useSyncDocs } from "../../hooks/useSyncDocs";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { GenericListView, ListGroup, ItemRowState } from "../../components/GenericListView";
import { getLabelColor, DEFAULT_LABELS } from "../../lib/labelColors";
import {
  FileText,
  Pin,
  FolderOpen,
  Tag,
  User,
  Bot,
} from "lucide-react";

const api = _api as any;

export const DOC_TYPE_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  note: { label: "Note", color: "text-gray-400", dot: "bg-gray-400" },
  plan: { label: "Plan", color: "text-sol-blue", dot: "bg-sol-blue" },
  design: { label: "Design", color: "text-sol-violet", dot: "bg-sol-violet" },
  spec: { label: "Spec", color: "text-sol-cyan", dot: "bg-sol-cyan" },
  investigation: { label: "Investigation", color: "text-sol-yellow", dot: "bg-sol-yellow" },
  handoff: { label: "Handoff", color: "text-sol-orange", dot: "bg-sol-orange" },
};

const DOC_TYPES = ["note", "plan", "design", "spec", "investigation", "handoff"];

function fmtAge(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}d`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function DocRow({ doc }: { doc: DocItem; state: ItemRowState }) {
  const cfg = DOC_TYPE_CONFIG[doc.doc_type] || DOC_TYPE_CONFIG.note;
  const title = (doc as any).display_title || doc.title || "Untitled";
  const ageStr = fmtAge(doc.updated_at);

  return (
    <>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
      {doc.pinned && <Pin className="w-3 h-3 text-sol-yellow flex-shrink-0" />}
      <span className="flex-1 text-sol-text truncate min-w-0">{title}</span>
      {doc.plan_short_id && (
        <Link
          href={`/plans/${doc.plan_short_id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-[10px] px-1.5 py-0.5 rounded border border-sol-border/30 text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/30 transition-colors flex-shrink-0 cq-hide-compact"
        >
          {doc.plan_short_id}
        </Link>
      )}
      {doc.labels && doc.labels.length > 0 && (
        <div className="flex items-center gap-1 flex-shrink min-w-0 overflow-hidden flex-nowrap cq-hide-compact">
          {doc.labels.slice(0, 2).map((l) => {
            const lc = getLabelColor(l);
            return (
              <span key={l} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0 rounded-full border whitespace-nowrap ${lc.bg} ${lc.border} ${lc.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
                {l}
              </span>
            );
          })}
          {doc.labels.slice(2).map((l) => {
            const lc = getLabelColor(l);
            return (
              <span key={l} className={`w-2 h-2 rounded-full flex-shrink-0 ${lc.dot}`} title={l} />
            );
          })}
        </div>
      )}
      <span className="text-[10px] text-gray-500 flex-shrink-0 tabular-nums cq-hide-minimal">{cfg.label}</span>
      <span className="text-xs text-gray-500 w-8 text-right tabular-nums flex-shrink-0 cq-hide-minimal">{ageStr}</span>
    </>
  );
}

function useDocUrlState() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const docView = useInboxStore((s) => s.clientState.ui?.doc_view);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);

  const isDetailPage = pathname !== "/docs";

  // Seed store from URL params once (deep links)
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || isDetailPage) return;
    seededRef.current = true;
    const t = searchParams.get("type");
    const s = searchParams.get("sort");
    const p = searchParams.get("project");
    const l = searchParams.get("label");
    const src = searchParams.get("source");
    if (t || s || p || l || src) {
      const prefs: Record<string, any> = {};
      if (t) prefs.doc_type = t;
      if (s) prefs.sort = s;
      if (p) prefs.project = p;
      if (l) prefs.label = l;
      if (src) prefs.source = src;
      updateClientUI({ doc_view: { ...docView, ...prefs } as DocViewPrefs });
    }
  }, []);

  // Store is the single source of truth
  const docType = docView?.doc_type ?? "";
  const sort = (docView?.sort || "updated") as "updated" | "created" | "type" | "project";
  const project = docView?.project ?? "";
  const label = docView?.label ?? "";
  const source = docView?.source ?? "";

  const setParam = useCallback((updates: Record<string, string>) => {
    const prefs: Record<string, any> = {};
    for (const [k, v] of Object.entries(updates)) {
      if (k === "type") prefs.doc_type = v || undefined;
      else prefs[k] = v || undefined;
    }
    updateClientUI({ doc_view: { ...docView, ...prefs } as DocViewPrefs });
    if (!isDetailPage) {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      const qs = params.toString();
      router.replace(qs ? `/docs?${qs}` : "/docs");
    }
  }, [searchParams, router, docView, updateClientUI, isDetailPage]);

  return { docType, sort, project, label, source, setParam };
}

export function DocListContent() {
  const params = useParams();
  const { docType, sort: sortBy, project: projectFilter, label: labelFilter, source: sourceFilter, setParam } = useDocUrlState();
  const router = useRouter();
  const createDoc = useMutation(api.docs.webCreate);
  const docs = useInboxStore((s) => s.docs);
  const docProjectPaths = useInboxStore((s) => s.docProjectPaths);

  useSyncDocs();

  const docsList = useMemo(() => Object.values(docs), [docs]);

  const allLabels = useMemo(() => {
    const set = new Set<string>(DEFAULT_LABELS);
    for (const d of docsList) d.labels?.forEach((l: string) => set.add(l));
    return [...set].sort();
  }, [docsList]);

  // Source filtering applied before other filters.
  // Default ("") shows ALL docs. "human" narrows to human-created only.
  const sourceFilteredDocs = useMemo(() => {
    if (sourceFilter === "human") return docsList.filter((d) => d.source === "human");
    if (sourceFilter === "bot") return docsList.filter((d) => d.source !== "human");
    return docsList; // Default: show everything
  }, [docsList, sourceFilter]);

  const hiddenAgentCount = useMemo(() => {
    if (sourceFilter !== "human") return 0;
    return docsList.filter((d) => d.source !== "human").length;
  }, [docsList, sourceFilter]);

  const filteredDocs = useMemo(() => {
    let list = sourceFilteredDocs;
    if (docType) list = list.filter((d) => d.doc_type === docType);
    if (labelFilter) list = list.filter((d) => d.labels?.includes(labelFilter));
    if (projectFilter) list = list.filter((d) => d.source_file?.startsWith(projectFilter));
    return list;
  }, [sourceFilteredDocs, docType, labelFilter, projectFilter]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of sourceFilteredDocs) {
      counts[d.doc_type] = (counts[d.doc_type] || 0) + 1;
    }
    return counts;
  }, [sourceFilteredDocs]);

  const typeGroups = useMemo(() => {
    if (sortBy !== "type") return null;
    const byType: Record<string, DocItem[]> = {};
    for (const d of filteredDocs) {
      const key = d.doc_type || "note";
      if (!byType[key]) byType[key] = [];
      byType[key].push(d);
    }
    return DOC_TYPES
      .filter((t) => byType[t]?.length)
      .map((t) => ({ type: t, docs: byType[t].sort((a, b) => b.updated_at - a.updated_at) }));
  }, [filteredDocs, sortBy]);

  const projectGroups = useMemo(() => {
    if (sortBy !== "project") return null;
    const byProject: Record<string, DocItem[]> = {};
    const ungrouped: DocItem[] = [];
    for (const d of filteredDocs) {
      const proj = d.source_file?.split("/").slice(0, -1).join("/") || "";
      if (proj) {
        if (!byProject[proj]) byProject[proj] = [];
        byProject[proj].push(d);
      } else {
        ungrouped.push(d);
      }
    }
    const ordered = Object.entries(byProject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, docs]) => ({ path, docs: docs.sort((a, b) => b.updated_at - a.updated_at) }));
    if (ungrouped.length > 0) {
      ordered.push({ path: "", docs: ungrouped.sort((a, b) => b.updated_at - a.updated_at) });
    }
    return ordered;
  }, [filteredDocs, sortBy]);

  const flatDocs = useMemo(() => {
    if (sortBy === "type" && typeGroups) {
      return typeGroups.flatMap((g) => g.docs);
    }
    if (sortBy === "project" && projectGroups) {
      return projectGroups.flatMap((g) => g.docs);
    }
    const sorted = [...filteredDocs];
    if (sortBy === "created") sorted.sort((a, b) => b.created_at - a.created_at);
    else sorted.sort((a, b) => b.updated_at - a.updated_at);
    return sorted;
  }, [filteredDocs, sortBy, typeGroups, projectGroups]);

  const listGroups = useMemo((): ListGroup<DocItem>[] | null => {
    if (sortBy === "type" && typeGroups) {
      return typeGroups.map((g) => {
        const cfg = DOC_TYPE_CONFIG[g.type] || DOC_TYPE_CONFIG.note;
        return {
          key: g.type,
          label: cfg.label,
          icon: <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />,
          items: g.docs,
        };
      });
    }
    if (sortBy === "project" && projectGroups) {
      return projectGroups.map((g) => ({
        key: g.path || "__ungrouped",
        label: g.path ? g.path.split("/").pop()! : "No project",
        icon: <FolderOpen className="w-3.5 h-3.5 text-sol-text-dim" />,
        items: g.docs,
      }));
    }
    return null;
  }, [sortBy, typeGroups, projectGroups]);

  const renderDocRow = useCallback((doc: DocItem, state: ItemRowState) => (
    <DocRow doc={doc} state={state} />
  ), []);

  return (
    <GenericListView<DocItem>
      activeItemId={params?.id as string | undefined}
      paletteTargetType="doc"
      title="Documents"
      tabs={[
        { key: "", label: "All", count: docsList.length },
        ...DOC_TYPES.map((t) => ({
          key: t,
          label: DOC_TYPE_CONFIG[t].label,
          count: typeCounts[t] || 0,
        })),
      ]}
      activeTab={docType}
      onTabChange={(tab) => setParam({ type: tab })}
      sortBy={sortBy}
      sortOptions={[
        { value: "updated", label: "Sort by updated" },
        { value: "created", label: "Sort by created" },
        { value: "type", label: "Group by type" },
        { value: "project", label: "Group by project" },
      ]}
      onSortChange={(sort) => setParam({ sort })}
      listFooter={hiddenAgentCount > 0 ? (
        <div className="px-6 py-2.5 border-t border-sol-border/15 flex items-center gap-2 text-xs text-sol-text-dim">
          <Bot className="w-3.5 h-3.5 opacity-40" />
          <span>{hiddenAgentCount} agent {hiddenAgentCount === 1 ? "item" : "items"} not shown</span>
          <button onClick={() => setParam({ source: "all" })} className="text-sol-cyan hover:underline ml-0.5">
            Show all
          </button>
        </div>
      ) : undefined}
      headerExtra={
        <div className="flex items-center rounded-md border border-sol-border/40 overflow-hidden">
          <button
            onClick={() => setParam({ source: "" })}
            className={`px-2 py-1.5 text-xs transition-colors ${!sourceFilter ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
            title="All docs"
          >
            All
          </button>
          <button
            onClick={() => setParam({ source: "human" })}
            className={`px-2 py-1.5 transition-colors border-l border-sol-border/40 ${sourceFilter === "human" ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
            title="Human-created docs"
          >
            <User className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setParam({ source: "bot" })}
            className={`px-2 py-1.5 transition-colors border-l border-sol-border/40 ${sourceFilter === "bot" ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
            title="Bot-created docs"
          >
            <Bot className="w-3.5 h-3.5" />
          </button>
        </div>
      }
      filters={{
        hasActive: !!(projectFilter || labelFilter),
        defs: [
          {
            key: "project", label: "Project", icon: <FolderOpen className="w-3 h-3" />, value: projectFilter,
            options: [
              { key: "", label: "Any" },
              ...docProjectPaths.map((p) => ({ key: p, label: p.split("/").pop() || p })),
            ],
            onChange: (v: string) => setParam({ project: v }),
          },
          {
            key: "label", label: "Label", icon: <Tag className="w-3 h-3" />, value: labelFilter,
            options: [{ key: "", label: "Any" }, ...allLabels.map((l) => ({ key: l, label: l }))],
            onChange: (v: string) => setParam({ label: v }),
          },
        ],
        onClear: () => setParam({ project: "", label: "" }),
      }}
      groups={listGroups}
      flatItems={flatDocs}
      renderRow={renderDocRow}
      getItemId={(d) => d._id}
      getItemRoute={(d) => `/docs/${d._id}`}
      getSearchText={(d) => (d as any).display_title || d.title || ""}
      emptyIcon={<FileText className="w-8 h-8 opacity-30" />}
      emptyMessage="No documents found"
      onCreate={async () => {
        const result = await createDoc({ title: "", doc_type: docType || "note" });
        if (result?.id) router.push(`/docs/${result.id}`);
      }}
      paletteShortcuts={[
        { key: "t", mode: "type", label: "type" },
        { key: "l", mode: "labels", label: "labels" },
      ]}
    />
  );
}

export default function DocsPage() {
  return <DocListContent />;
}

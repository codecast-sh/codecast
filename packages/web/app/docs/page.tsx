"use client";
import { useState, useCallback, useMemo } from "react";
import { useRouter, useSearchParams, useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { useInboxStore, DocItem, DocViewPrefs } from "../../store/inboxStore";
import { useSyncDocs } from "../../hooks/useSyncDocs";
import { CreateDocModal } from "../../components/CreateDocModal";
import { GenericListView, ListGroup, ItemRowState } from "../../components/GenericListView";
import { getLabelColor, DEFAULT_LABELS } from "../../lib/labelColors";
import {
  FileText,
  Pin,
  FolderOpen,
  Tag,
} from "lucide-react";

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
      {doc.labels && doc.labels.length > 0 && doc.labels.slice(0, 2).map((l) => {
        const lc = getLabelColor(l);
        return (
          <span key={l} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0 cq-hide-compact ${lc.bg} ${lc.border} ${lc.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
            {l}
          </span>
        );
      })}
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
  const hasUrlParams = !isDetailPage && searchParams.toString().length > 0;

  const docType = hasUrlParams
    ? (searchParams.get("type") || "")
    : (docView?.doc_type ?? "");
  const sort = hasUrlParams
    ? ((searchParams.get("sort") || "updated") as "updated" | "created" | "type" | "project")
    : ((docView?.sort || "updated") as "updated" | "created" | "type" | "project");
  const project = hasUrlParams
    ? (searchParams.get("project") || "")
    : (docView?.project ?? "");
  const label = hasUrlParams
    ? (searchParams.get("label") || "")
    : (docView?.label ?? "");

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

  return { docType, sort, project, label, setParam };
}

export function DocListContent() {
  const params = useParams();
  const { docType, sort: sortBy, project: projectFilter, label: labelFilter, setParam } = useDocUrlState();
  const docs = useInboxStore((s) => s.docs);
  const docProjectPaths = useInboxStore((s) => s.docProjectPaths);
  const [showCreate, setShowCreate] = useState(false);

  useSyncDocs(docType || undefined, undefined, projectFilter || undefined);

  const docsList = useMemo(() => Object.values(docs), [docs]);

  const allLabels = useMemo(() => {
    const set = new Set<string>(DEFAULT_LABELS);
    for (const d of docsList) d.labels?.forEach((l: string) => set.add(l));
    return [...set].sort();
  }, [docsList]);

  const filteredDocs = useMemo(() => {
    let list = docsList;
    if (labelFilter) list = list.filter((d) => d.labels?.includes(labelFilter));
    if (projectFilter) list = list.filter((d) => d.source_file?.startsWith(projectFilter));
    return list;
  }, [docsList, labelFilter, projectFilter]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of docsList) {
      counts[d.doc_type] = (counts[d.doc_type] || 0) + 1;
    }
    return counts;
  }, [docsList]);

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
      disableKeyboard={showCreate}
      renderRow={renderDocRow}
      getItemId={(d) => d._id}
      getItemRoute={(d) => `/docs/${d._id}`}
      getSearchText={(d) => (d as any).display_title || d.title || ""}
      emptyIcon={<FileText className="w-8 h-8 opacity-30" />}
      emptyMessage="No documents found"
      onCreate={() => setShowCreate(true)}
      paletteShortcuts={[
        { key: "t", mode: "type", label: "type" },
        { key: "l", mode: "labels", label: "labels" },
      ]}
    >
      {showCreate && <CreateDocModal onClose={() => setShowCreate(false)} initialType={docType || undefined} />}
    </GenericListView>
  );
}

export default function DocsPage() {
  return <DocListContent />;
}

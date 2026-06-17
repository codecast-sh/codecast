"use client";
import { useCallback, useMemo, useRef, useEffect } from "react";
import { useRouter, useSearchParams, useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { useInboxStore, DocItem, DocViewPrefs, ProjectItem } from "../../store/inboxStore";
import { AuthGuard } from "../../components/AuthGuard";

import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { GenericListView, ListGroup, ItemRowState } from "../../components/GenericListView";
import { SegmentedToggle } from "../../components/SegmentedToggle";
import { getLabelColor, DEFAULT_LABELS } from "../../lib/labelColors";
import { docMatchesProjectFilter } from "../../lib/docFilters";
import { docSearchText } from "../../lib/liveEntities";
import {
  FileText,
  Pin,
  FolderOpen,
  FolderKanban,
  Tag,
  User,
  Bot,
} from "lucide-react";

const api = _api as any;

const DOC_TYPE_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
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

// Grouping and sorting are independent axes (mirrors the tasks page). These name
// the legal values for each so we can migrate the legacy single `sort` param
// that overloaded the two.
const DOC_GROUP_VALUES = new Set(["none", "type", "project"]);
const DOC_SORT_VALUES = new Set(["updated", "created", "title"]);
function docDefaultDir(sort: string): "asc" | "desc" {
  return sort === "title" ? "asc" : "desc"; // newest-first for time fields, A→Z for title
}
/** Resolve raw group/sort/dir into a valid triple, migrating the legacy `sort`:
 *  a grouping word ("type"/"project") became `group=that, sort=updated`; a flat
 *  sort kept `group=none`; docs default to ungrouped, updated-first. */
function normalizeDocSort(rawGroup: string, rawSort: string, rawDir: string) {
  let group = DOC_GROUP_VALUES.has(rawGroup) ? rawGroup : "";
  let sort = DOC_SORT_VALUES.has(rawSort) ? rawSort : "";
  if (!group) {
    if (DOC_GROUP_VALUES.has(rawSort)) { group = rawSort; sort = sort || "updated"; }
    else group = "none";
  }
  if (!sort) sort = "updated";
  const dir: "asc" | "desc" = rawDir === "asc" || rawDir === "desc" ? rawDir : docDefaultDir(sort);
  return { group, sort, dir };
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
    const g = searchParams.get("group");
    const s = searchParams.get("sort");
    const d = searchParams.get("dir");
    const p = searchParams.get("project");
    const l = searchParams.get("label");
    const src = searchParams.get("source");
    if (t || g || s || d || p || l || src) {
      const prefs: Record<string, any> = {};
      if (t) prefs.doc_type = t;
      if (g) prefs.group = g;
      if (s) prefs.sort = s;
      if (d) prefs.dir = d;
      if (p) prefs.project = p;
      if (l) prefs.label = l;
      if (src) prefs.source = src;
      updateClientUI({ doc_view: { ...docView, ...prefs } as DocViewPrefs });
    }
  }, []);

  // Store is the single source of truth
  const docType = docView?.doc_type ?? "";
  const { group, sort, dir } = normalizeDocSort(docView?.group || "", docView?.sort || "", docView?.dir || "");
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

  // Serialize the effective view (store-derived) into a deep-linkable URL. We
  // can't copy window.location: the store is the source of truth and the URL
  // only carries params that were explicitly set, so a fresh load reading prefs
  // from the store would leave the address bar bare. Defaults (updated sort) are
  // omitted to keep links tidy. Mirrors the tasks-page sharer.
  const buildShareUrl = useCallback(() => {
    const params = new URLSearchParams();
    const entries: Array<[string, string]> = [
      ["type", docType],
      // Always emit `group` so its presence marks the new group/sort/dir scheme
      // (a bare flat-sort word is never mis-migrated as a legacy link). `dir` only
      // when it deviates from the field's natural default, to keep links tidy.
      ["group", group],
      ["sort", sort === "updated" ? "" : sort],
      ["dir", dir === docDefaultDir(sort) ? "" : dir],
      ["project", project],
      ["label", label],
      ["source", source],
    ];
    for (const [k, v] of entries) if (v) params.set(k, v);
    const qs = params.toString();
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/docs${qs ? `?${qs}` : ""}`;
  }, [docType, group, sort, dir, project, label, source]);

  // Picking a sort field resets direction to that field's natural default; the
  // toggle flips it explicitly.
  const setGroup = useCallback((g: string) => setParam({ group: g }), [setParam]);
  const setSort = useCallback((s: string) => setParam({ sort: s, dir: docDefaultDir(s) }), [setParam]);
  const toggleSortDir = useCallback(() => setParam({ dir: dir === "asc" ? "desc" : "asc" }), [setParam, dir]);

  return { docType, group, sort, dir, project, label, source, setParam, setGroup, setSort, toggleSortDir, buildShareUrl };
}

export function DocListContent() {
  const params = useParams();
  const { docType, group, sort, dir, project: projectFilter, label: labelFilter, source: sourceFilter, setParam, setGroup, setSort, toggleSortDir, buildShareUrl } = useDocUrlState();
  const router = useRouter();
  const createDoc = useInboxStore((s) => s.createDoc);
  const docs = useInboxStore((s) => s.docs);
  const projects = useInboxStore((s) => s.projects);
  const docProjectPaths = useInboxStore((s) => s.docProjectPaths);
  const saveView = useInboxStore((s) => s.saveView);
  const docView = useInboxStore((s) => s.clientState.ui?.doc_view);
  const handleSaveView = useCallback((name: string) => {
    saveView({ name, page: "docs", prefs: { ...docView, doc_type: docType } as DocViewPrefs });
  }, [saveView, docView, docType]);

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
    if (projectFilter) list = list.filter((d) => docMatchesProjectFilter(d, projectFilter));
    return list;
  }, [sourceFilteredDocs, docType, labelFilter, projectFilter]);

  const filteredDocsIgnoringSource = useMemo(() => {
    let list = docsList;
    if (docType) list = list.filter((d) => d.doc_type === docType);
    if (labelFilter) list = list.filter((d) => d.labels?.includes(labelFilter));
    if (projectFilter) list = list.filter((d) => docMatchesProjectFilter(d, projectFilter));
    return list;
  }, [docsList, docType, labelFilter, projectFilter]);

  // Search corpus that ignores the active type TAB (but keeps explicit source/
  // project/label scope), so typing a query finds a doc whose type isn't the
  // selected tab instead of returning a confusing "No results". The type tab
  // still scopes plain browsing.
  const searchScopeDocs = useMemo(() => {
    let list = sourceFilteredDocs;
    if (labelFilter) list = list.filter((d) => d.labels?.includes(labelFilter));
    if (projectFilter) list = list.filter((d) => docMatchesProjectFilter(d, projectFilter));
    return [...list].sort((a, b) => b.updated_at - a.updated_at);
  }, [sourceFilteredDocs, labelFilter, projectFilter]);

  useEffect(() => {
    if (
      sourceFilter === "human" &&
      filteredDocs.length === 0 &&
      filteredDocsIgnoringSource.some((d) => d.source !== "human")
    ) {
      setParam({ source: "" });
    }
  }, [sourceFilter, filteredDocs, filteredDocsIgnoringSource, setParam]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of sourceFilteredDocs) {
      counts[d.doc_type] = (counts[d.doc_type] || 0) + 1;
    }
    return counts;
  }, [sourceFilteredDocs]);

  // One comparator drives both the flat list and within-group ordering. Ties
  // fall back to updated_at desc (direction-independent) so equal keys stay put
  // when the user flips asc/desc.
  const sortDocs = useCallback((list: DocItem[]) => {
    const flip = dir === "desc" ? -1 : 1;
    const title = (d: DocItem) => ((d as any).display_title || d.title || "").toLowerCase();
    return [...list].sort((a, b) => {
      let r = 0;
      if (sort === "created") r = a.created_at - b.created_at;
      else if (sort === "title") r = title(a).localeCompare(title(b));
      else r = a.updated_at - b.updated_at;
      if (r !== 0) return flip * r;
      return b.updated_at - a.updated_at;
    });
  }, [sort, dir]);

  const typeGroups = useMemo(() => {
    if (group !== "type") return null;
    const byType: Record<string, DocItem[]> = {};
    for (const d of filteredDocs) {
      const key = d.doc_type || "note";
      if (!byType[key]) byType[key] = [];
      byType[key].push(d);
    }
    return DOC_TYPES
      .filter((t) => byType[t]?.length)
      .map((t) => ({ type: t, docs: sortDocs(byType[t]) }));
  }, [filteredDocs, group, sortDocs]);

  const projectGroups = useMemo(() => {
    if (group !== "project") return null;
    const byProject: Record<string, { project: ProjectItem | undefined; docs: DocItem[] }> = {};
    const ungrouped: DocItem[] = [];
    for (const d of filteredDocs) {
      const pid = (d as any).project_id;
      if (pid) {
        if (!byProject[pid]) byProject[pid] = { project: projects[pid], docs: [] };
        byProject[pid].docs.push(d);
      } else {
        ungrouped.push(d);
      }
    }
    const ordered = Object.values(byProject)
      .sort((a, b) => (a.project?.title || "").localeCompare(b.project?.title || ""));
    if (ungrouped.length > 0) {
      ordered.push({ project: undefined, docs: ungrouped });
    }
    for (const g of ordered) {
      g.docs = sortDocs(g.docs);
    }
    return ordered;
  }, [filteredDocs, group, sortDocs, projects]);

  const flatDocs = useMemo(() => {
    const active = typeGroups || projectGroups;
    if (active) return active.flatMap((g: any) => g.docs);
    return sortDocs(filteredDocs);
  }, [filteredDocs, sortDocs, typeGroups, projectGroups]);

  const listGroups = useMemo((): ListGroup<DocItem>[] | null => {
    if (group === "type" && typeGroups) {
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
    if (group === "project" && projectGroups) {
      return projectGroups.map((g: any) => ({
        key: g.project?._id || "__no_project",
        label: g.project?.title || "No project",
        icon: <FolderKanban className={`w-3.5 h-3.5 ${g.project ? "text-sol-cyan" : "text-sol-text-dim"}`} />,
        extra: g.project ? (
          <Link href={`/projects/${g.project._id}`} onClick={(e: any) => e.stopPropagation()} className="text-[10px] text-sol-cyan hover:underline flex-shrink-0">
            View project
          </Link>
        ) : undefined,
        items: g.docs,
      }));
    }
    return null;
  }, [group, typeGroups, projectGroups]);

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
      groupBy={group}
      groupOptions={[
        { value: "none", label: "No grouping" },
        { value: "type", label: "Type" },
        { value: "project", label: "Project" },
      ]}
      onGroupChange={setGroup}
      sortBy={sort}
      sortOptions={[
        { value: "updated", label: "Updated" },
        { value: "created", label: "Created" },
        { value: "title", label: "Title" },
      ]}
      onSortChange={setSort}
      sortDir={dir}
      onSortDirChange={toggleSortDir}
      listFooter={hiddenAgentCount > 0 ? (
        <div className="px-6 py-2.5 border-t border-sol-border/15 flex items-center gap-2 text-xs text-sol-text-dim">
          <Bot className="w-3.5 h-3.5 opacity-40" />
          <span>{hiddenAgentCount} agent {hiddenAgentCount === 1 ? "item" : "items"} not shown</span>
          <button onClick={() => setParam({ source: "all" })} className="text-sol-cyan hover:underline ml-0.5">
            Show all
          </button>
        </div>
      ) : undefined}
      syncScope="docs"
      headerExtra={
        <SegmentedToggle
          collapse
          value={sourceFilter}
          onChange={(v) => setParam({ source: v })}
          items={[
            { key: "", label: "All", title: "All docs" },
            { key: "human", icon: User, title: "Human-created docs" },
            { key: "bot", icon: Bot, title: "Bot-created docs" },
          ]}
        />
      }
      filters={{
        hasActive: !!(projectFilter || labelFilter || sourceFilter || docType),
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
        onClear: () => setParam({ project: "", label: "", source: "", type: "" }),
        onSaveView: handleSaveView,
      }}
      shareUrl={buildShareUrl}
      groups={listGroups}
      flatItems={flatDocs}
      renderRow={renderDocRow}
      getItemId={(d) => d._id}
      getItemRoute={(d) => `/docs/${d._id}`}
      getSearchText={(d) => docSearchText(d as any)}
      searchAllItems={searchScopeDocs}
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
  return (
    <AuthGuard>
      <DocListContent />
    </AuthGuard>
  );
}

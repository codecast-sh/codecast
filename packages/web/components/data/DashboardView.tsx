// A Data dashboard inside the live-artifact shell. It reads the doc's
// elements (blocks plus one layout element), keeps the queries they bind to
// fresh, and draws them in the doc's format: the dashboard grid, a
// Scrollyteller or a Visual short. The shell owns the title, presence,
// cursors, history, the draft bar and Ask agent; this view adds the top-bar
// controls and the right drawer (Data sources, Design, a check, the editor).
import "./dashboard.css";
import { useCallback, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { BarChart3, Bot, Database, Hash, Heading, Plus, Table2, Type } from "lucide-react";
import { dashboard, newElementKey, type ArtifactElement, type ArtifactOp, type ArtifactPosition, type Json } from "@codecast/shared/artifacts";
import type { LiveViewProps } from "../live/registry";
import { useLiveElements } from "../live/useLiveArtifact";
import { pickAskTarget, sendAsk, useAskDraft, useClaimAsk } from "../live/askAgent";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";
import { useDashboardFeed, useDataResults, useRerun } from "../../hooks/useDashboardData";
import { CheckMark, type BlockEnv } from "./blocks";
import { blockCheck } from "./blockCheck";
import { DashboardGrid, FormatBody } from "./DashboardGrid";
import { DashboardToolbar, type Freshness, type PanelKind } from "./DashboardToolbar";
import { CheckPanel, PanelShell, type CheckPoint } from "./CheckPanel";
import { DashboardFilters } from "./DashboardFilters";
import { seriesSlots } from "./seriesSlots";
import { filterWords, useDashboardScope } from "../../hooks/useDashboardScope";
import { canvasBlob, pdfFromCanvas, renderPng } from "./exportDashboard";
import { SourcesPanel } from "./SourcesPanel";
import { BlockEditor } from "./BlockEditor";
import { DesignPanel } from "./DesignPanel";
import { Button } from "../ui/button";
import { flushHeldDrafts, heldDraftKeys } from "./liveTextDrafts";

type Panel = { kind: PanelKind; key?: string; point?: CheckPoint } | null;

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export default function DashboardView({ doc, live, selection, setSelection, mode, snapshot, toScreen, setToolbar, setPanel, setExports, setTypeLabel }: LiveViewProps) {
  const docId = doc._id;
  const liveEls = useLiveElements(docId);
  const elements = snapshot ?? liveEls;
  const blocks = useMemo(() => dashboard.orderedBlocks(elements), [elements]);
  // Rows the server has written but this store has not read yet: a skeleton, never the empty-dashboard prompt over a full doc.
  const head = useInboxStore((s: any) => s.liveHeads?.[docId]);
  const unread = !snapshot && !elements.length && (!head || Number(head.head) > 0);
  const byKey = useMemo(() => new Map(elements.map((e) => [e.key, e])), [elements]);
  const layout = useMemo(() => dashboard.readLayout({ get: (k) => byKey.get(k) }), [byKey]);
  const canEdit = mode === "edit" && !snapshot;
  // Editing is kept per dashboard for this tab, so a reload or a hot remount doesn't drop back to View mid-edit.
  const editKey = `cc-data-edit:${docId}`;
  const [editing, setEditing] = useState(() => {
    try {
      return sessionStorage.getItem(editKey) === "1";
    } catch {
      return false;
    }
  });
  useWatchEffect(() => {
    try {
      if (editing) sessionStorage.setItem(editKey, "1");
      else sessionStorage.removeItem(editKey);
    } catch {}
  }, [editing, editKey]);
  const edit = canEdit && editing && layout.format === "dashboard";
  const me = useInboxStore((s: any) => (s.currentUser?._id ? `u:${String(s.currentUser._id)}` : null));

  useDashboardFeed(docId, blocks, { canWant: !snapshot });
  const results = useDataResults(docId);
  const now = useCoarseNow(15_000);
  const [panel, setPanelState] = useState<Panel>(null);
  const selected = selection.length === 1 && byKey.has(selection[0]) ? selection[0] : null;

  const openCheck = useCallback((key: string) => setPanelState({ kind: "check", key }), []);
  const bind = useCallback((key: string) => setPanelState({ kind: "edit", key }), []);
  const openPoint = useCallback((key: string, x: string, series?: string) => setPanelState({ kind: "check", key, point: { x, ...(series !== undefined ? { series } : {}) } }), []);
  const filter = useDashboardScope(now);
  const scope = layout.format === "dashboard" ? filter.scope : undefined;
  const slotOf = useMemo(() => seriesSlots(blocks, results), [blocks, results]);
  const env: BlockEnv = useMemo(() => ({ results, blocks: byKey, now, scope, slotOf, onCheck: openCheck, onPoint: openPoint, ...(canEdit ? { onBind: bind } : {}) }), [results, byKey, now, scope, slotOf, openCheck, openPoint, canEdit, bind]);

  // ── writes ──
  const select = useCallback(
    (key: string | null) => {
      setSelection(key ? [key] : []);
      live.setPresence(key ? { position: { block: key }, selection: [key] } : { selection: [] });
    },
    [live, setSelection],
  );
  const write = useCallback((ops: ArtifactOp[]) => live.apply(ops), [live]);
  // Words typed just before a reload are saved once the dashboard has loaded, not only when their editor opens again.
  // Only drafts held at load count; a block not in the first (cached) copy is tried again as rows arrive.
  const pendingDrafts = useRef<string[] | null>(null);
  useWatchEffect(() => {
    if (!canEdit || !elements.length) return;
    pendingDrafts.current ??= heldDraftKeys(docId);
    if (pendingDrafts.current.length) pendingDrafts.current = flushHeldDrafts(pendingDrafts.current, elements, write);
  }, [canEdit, elements, docId, write]);
  const remove = useCallback(
    (key: string) => {
      write([{ k: key, del: true }]);
      select(null);
      setPanelState((p) => (p?.key === key ? null : p));
    },
    [write, select],
  );
  const addBlock = useCallback(
    (kind: dashboard.BlockKind) => {
      const key = newElementKey("b");
      const order = dashboard.orderAfter(blocks, selected ?? undefined);
      const fields: Record<string, Json> = kind === "text" ? { text: "" } : kind === "section" ? { title: "Section" } : { title: "" };
      write([{ k: key, put: { kind, order, ...fields } }]);
      setEditing(true);
      select(key);
      setPanelState({ kind: "edit", key });
    },
    [blocks, selected, write, select],
  );
  const added = useCallback(
    (ops: ArtifactOp[], key: string) => {
      write(ops);
      setEditing(true);
      select(key);
    },
    [write, select],
  );

  // ── freshness and checks ──
  const rerun = useRerun();
  const queries = useMemo(() => dashboard.dashboardQueries(blocks), [blocks]);
  const dims = useMemo(() => dashboard.filterDimensions([...queries.keys()].map((k) => results.get(k))), [queries, results]);
  const freshness: Freshness = useMemo(() => {
    let oldest = 0;
    let refreshing = false;
    for (const k of queries.keys()) {
      const r = results.get(k);
      if (r?.refreshing || (r?.lease_until ?? 0) > now) refreshing = true;
      if (r?.refreshed_at) oldest = oldest ? Math.min(oldest, r.refreshed_at) : r.refreshed_at;
    }
    return { oldest, refreshing, queries: queries.size };
  }, [queries, results, now]);
  const checks = useMemo(() => blocks.map((b) => ({ b, check: blockCheck(b, env) })).filter((x) => x.check), [blocks, env]);
  const counts = useMemo(() => {
    const c: Partial<Record<dashboard.CheckState, number>> = {};
    for (const { check } of checks) c[check!.state] = (c[check!.state] ?? 0) + 1;
    return c;
  }, [checks]);
  const refreshAll = useCallback(() => {
    for (const k of queries.keys()) rerun({ doc_id: docId as any, qkey: k }).catch(() => {});
  }, [queries, rerun, docId]);

  // ── the top bar ──
  const schedule = dashboard.readSchedule(byKey.get(dashboard.LAYOUT_KEY));
  const setSchedule = useCallback(
    (s: dashboard.Schedule | null) => write(dashboard.scheduleOps(byKey.has(dashboard.LAYOUT_KEY), s)),
    [byKey, write],
  );
  const togglePanel = useCallback((kind: PanelKind) => setPanelState((p) => (p?.kind === kind ? null : { kind })), []);
  useWatchEffect(() => {
    setToolbar(
      <DashboardToolbar now={now} freshness={freshness} counts={counts} edit={edit} canEdit={canEdit && layout.format === "dashboard"} panel={panel?.kind ?? null} onMode={setEditing} onPanel={togglePanel} onRefresh={refreshAll} schedule={schedule} onSchedule={canEdit ? setSchedule : undefined} />,
    );
  }, [setToolbar, now, freshness, counts, edit, canEdit, layout.format, panel?.kind, togglePanel, refreshAll, schedule, setSchedule]);
  useWatchEffect(() => () => setToolbar(null), [setToolbar]);

  // ── the drawer ──
  const closePanel = useCallback(() => setPanelState(null), []);
  const askDoc = useMemo(() => ({ _id: docId, title: doc.title, doc_type: doc.doc_type, project_path: doc.project_path, git_root: doc.git_root }), [docId, doc.title, doc.doc_type, doc.project_path, doc.git_root]);
  useWatchEffect(() => {
    if (!panel) return setPanel(null);
    const block = panel.key ? byKey.get(panel.key) : undefined;
    if (panel.kind === "check") setPanel(<CheckPanel key={panel.key} docId={docId} block={block} env={env} point={panel.point} onClose={closePanel} />);
    else if (panel.kind === "edit") setPanel(<BlockEditor key={panel.key} docId={docId} block={block} env={env} apply={write} onClose={closePanel} onRemove={() => panel.key && remove(panel.key)} />);
    else if (panel.kind === "sources") setPanel(<SourcesPanel docId={docId} blocks={blocks} env={env} canEdit={canEdit} onClose={closePanel} onAdd={added} onCheck={openCheck} />);
    else if (panel.kind === "design") setPanel(<DesignPanel doc={askDoc} format={layout.format} elements={elements} canEdit={canEdit} writeDraft={(ops) => live.apply(ops, { layer: "draft" })} write={write} onClose={closePanel} />);
    else if (panel.kind === "checks") setPanel(<ChecksPanel checks={checks} onOpen={openCheck} onClose={closePanel} />);
  }, [panel, byKey, docId, env, write, remove, blocks, canEdit, added, openCheck, askDoc, layout.format, elements, live, checks, closePanel, setPanel]);
  useWatchEffect(() => () => setPanel(null), [setPanel]);

  // ── cursors: where a block is on screen ──
  const root = useRef<HTMLDivElement>(null);

  // ── the shell's header and download menu ──
  const titleRef = useRef(doc.title);
  titleRef.current = doc.title;
  useWatchEffect(() => {
    setTypeLabel(layout.format === "scrolly" ? "Scrollyteller" : layout.format === "short" ? "Visual short" : null);
    // A story is read by scrolling or playing; the downloadable picture is the dashboard itself.
    if (layout.format !== "dashboard") return setExports(null);
    const page = () => {
      const el = root.current?.firstElementChild as HTMLElement | null;
      if (!el) throw new Error("The dashboard is not on screen");
      // The picture says when it was taken and which filters it shows, since it stops updating the moment it is saved.
      const filters = filterWords(window.location.search);
      const when = new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
      return renderPng(el, { title: titleRef.current, note: [`As of ${when}`, ...filters].join(" · ") });
    };
    setExports([
      { format: "png", label: "PNG image", run: async () => canvasBlob(await page(), "image/png") },
      { format: "pdf", label: "PDF", run: async () => pdfFromCanvas(await page()) },
    ]);
  }, [layout.format, setExports, setTypeLabel]);
  useWatchEffect(
    () => () => {
      setExports(null);
      setTypeLabel(null);
    },
    [setExports, setTypeLabel],
  );
  useWatchEffect(() => {
    const el = root.current;
    if (!el) return;
    const map = (pos: ArtifactPosition) => {
      const key = pos.block ?? (pos as { key?: string }).key;
      const box = key ? el.querySelector<HTMLElement>(`[data-block="${CSS.escape(key)}"]`) : null;
      if (!box) return null;
      const r = box.getBoundingClientRect();
      const c = (el.closest("[data-live-body]") ?? el).getBoundingClientRect();
      // A block scrolled out of view keeps its writer visible: the cursor waits at the edge it is beyond.
      if (r.bottom < c.top + 24) return { x: Math.min(r.right, c.right - 160) - c.left - 24, y: 4 };
      if (r.top > c.bottom - 24) return { x: Math.min(r.right, c.right - 160) - c.left - 24, y: c.height - 56 };
      return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
    };
    let raf = 0;
    const remap = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => toScreen(map));
    };
    toScreen(map);
    el.addEventListener("scroll", remap, { passive: true });
    const ro = new ResizeObserver(remap);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", remap);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [toScreen, blocks, layout.format]);

  // ── keyboard ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey) return;
    // Plain navigation keys pressed inside the artifact belong to it, never to the doc list or inbox around it.
    if (["Enter", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "[", "]", " "].includes(e.key)) e.stopPropagation();
    if (e.key === "e" && canEdit && layout.format === "dashboard" && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      setEditing((v) => !v);
      return;
    }
    if (e.key === "Escape" && (panel || selected)) {
      // This Esc closes something here; nothing above (the shell, the docs list) may act on it too.
      e.preventDefault();
      e.stopPropagation();
      if (panel) setPanelState(null);
      else select(null);
      return;
    }
    if (!edit || !selected) return;
    const i = blocks.findIndex((b) => b.key === selected);
    if (e.key === "Enter") {
      e.preventDefault();
      setPanelState({ kind: "edit", key: selected });
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      remove(selected);
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowRight")) {
      e.preventDefault();
      const to = e.key === "ArrowUp" || e.key === "ArrowLeft" ? i - 1 : i + 1;
      if (to >= 0 && to < blocks.length) write(dashboard.moveBlockOps(elements, selected, to));
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = blocks[e.key === "ArrowUp" || e.key === "ArrowLeft" ? i - 1 : i + 1];
      if (next) {
        select(next.key);
        root.current?.querySelector<HTMLElement>(`[data-block="${CSS.escape(next.key)}"]`)?.focus();
      }
    } else if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      const spans = dashboard.SPANS as readonly number[];
      const cur = spans.indexOf(dashboard.blockSpan(blocks[i]));
      const nxt = spans[Math.max(0, Math.min(spans.length - 1, cur + (e.key === "]" ? 1 : -1)))];
      write([{ k: selected, set: { span: nxt } }]);
    }
  };

  return (
    <div ref={root} className="data-wrap h-full overflow-y-auto overflow-x-hidden bg-sol-bg outline-none" tabIndex={-1} onKeyDown={onKeyDown} onClick={(e) => e.target === e.currentTarget && select(null)} data-dashboard={docId}>
      <FormatBody title={doc.title} layout={layout} elements={elements} env={env} onBackground={() => select(null)}>
        {blocks.length ? <DashboardFilters dims={dims} value={filter.value} values={filter.values} set={filter.set} clear={filter.clear} /> : null}
        {blocks.length ? (
          <DashboardGrid
            blocks={blocks}
            env={env}
            edit={edit}
            selected={selected}
            me={me}
            onSelect={select}
            onEdit={(k) => setPanelState({ kind: "edit", key: k })}
            onRemove={remove}
            onSpan={(k, span) => write([{ k, set: { span } }])}
            onMove={(k, to) => write(dashboard.moveBlockOps(elements, k, to))}
            {...(canEdit && layout.format === "dashboard" ? { onStartEdit: () => setEditing(true) } : {})}
          />
        ) : unread ? (
          <div className="data-grid" aria-busy data-dashboard-loading>
            {[3, 3, 3, 3, 8, 4].map((span, i) => (
              <div key={i} className="h-32 rounded-xl bg-sol-bg-alt animate-pulse" style={{ gridColumn: `span ${span}` }} />
            ))}
          </div>
        ) : (
          <EmptyDashboard docId={askDoc._id} canEdit={canEdit} onSources={() => setPanelState({ kind: "sources" })} onAsk={(prompt) => pickAskTarget("Who builds it?", (t) => sendAsk(askDoc, { slot: EMPTY_ASK_SLOT, prompt }, t))} />
        )}
        {edit && blocks.length ? <AddRow onAdd={addBlock} onSources={() => setPanelState({ kind: "sources" })} /> : null}
      </FormatBody>
    </div>
  );
}


const ADD: Array<{ kind: dashboard.BlockKind; label: string; icon: typeof Hash }> = [
  { kind: "kpi", label: "KPI", icon: Hash },
  { kind: "chart", label: "Chart", icon: BarChart3 },
  { kind: "table", label: "Table", icon: Table2 },
  { kind: "text", label: "Text", icon: Type },
  { kind: "section", label: "Section", icon: Heading },
];

function AddRow({ onAdd, onSources }: { onAdd: (k: dashboard.BlockKind) => void; onSources: () => void }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-sol-border/60 px-3 py-2.5" data-add-row data-export-skip>
      <Plus className="w-4 h-4 text-sol-text-dim mr-1" />
      {ADD.map(({ kind, label, icon: Icon }) => (
        <button key={kind} type="button" onClick={() => onAdd(kind)} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-sol-text-secondary hover:text-sol-text hover:bg-sol-bg-alt">
          <Icon className="w-3.5 h-3.5" /> {label}
        </button>
      ))}
      <span className="flex-1" />
      <button type="button" onClick={onSources} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs text-sol-text-secondary hover:text-sol-text hover:bg-sol-bg-alt">
        <Database className="w-3.5 h-3.5" /> From a source
      </button>
    </div>
  );
}

const EMPTY_ASK_SLOT = "dashboard-empty";

function EmptyDashboard({ docId, canEdit, onSources, onAsk }: { docId: string; canEdit: boolean; onSources: () => void; onAsk: (prompt: string) => void }) {
  const { text: prompt, setText: setPrompt } = useAskDraft(docId, EMPTY_ASK_SLOT);
  // This prompt is the page's Ask while the dashboard is empty.
  useClaimAsk();
  if (!canEdit) return <div className="py-24 text-center text-sm text-sol-text-dim">No blocks</div>;
  const send = () => prompt.trim() && onAsk(`Build this dashboard: ${prompt.trim()}`);
  return (
    <div className="py-16 flex flex-col items-center" data-empty-dashboard>
      <div className="w-full max-w-[560px] rounded-xl border border-sol-border/60 bg-sol-card p-2 focus-within:border-sol-violet/60">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="What should this dashboard show? e.g. agent spend this month by person"
          aria-label="What should this dashboard show"
          className="w-full resize-none bg-transparent px-2 py-1.5 text-sm text-sol-text placeholder:text-sol-text-dim outline-none"
        />
        <div className="flex items-center gap-2 px-1">
          <button type="button" onClick={onSources} className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt">
            <Database className="w-3.5 h-3.5" /> Pick a source
          </button>
          <span className="flex-1" />
          <Button type="button" variant="violet" size="xs" onClick={send} disabled={!prompt.trim()}>
            <Bot className="w-3.5 h-3.5" /> Ask agent
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChecksPanel({ checks, onOpen, onClose }: { checks: Array<{ b: ArtifactElement; check: dashboard.Check | null }>; onOpen: (k: string) => void; onClose: () => void }) {
  const rank: Record<string, number> = { broken: 0, stale: 1, partial: 1, typed: 2, loading: 3, refreshing: 3, verified: 4 };
  const sorted = [...checks].sort((a, b) => rank[a.check!.state] - rank[b.check!.state]);
  return (
    <PanelShell title="Checks" onClose={onClose}>
      <div className="space-y-0.5">
        {sorted.map(({ b, check }) => (
          <button key={b.key} type="button" onClick={() => onOpen(b.key)} className="w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sol-bg-alt" data-check-row={check!.state}>
            <CheckMark check={check!} onClick={() => onOpen(b.key)} size={14} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-sol-text truncate">{String(b.title || b.kind)}</span>
              <span className="block text-meta text-sol-text-dim line-clamp-2 break-words" title={check!.detail ?? check!.label}>{check!.state === "verified" ? check!.detail : check!.detail ?? check!.label}</span>
            </span>
          </button>
        ))}
      </div>
    </PanelShell>
  );
}


// A dashboard or story opened from its share link: read-only, full page, its
// numbers live (the link keeps them fresh through wantShared) and each check
// still opens the query, source and rows behind a number.
import "./dashboard.css";
import { useCallback, useMemo, useState } from "react";
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useDashboardFeed, useDataResults } from "../../hooks/useDashboardData";
import { DashboardGrid, FormatBody } from "./DashboardGrid";
import { CheckPanel, type CheckPoint } from "./CheckPanel";
import { seriesSlots } from "./seriesSlots";
import { DashboardFilters } from "./DashboardFilters";
import { useDashboardScope } from "../../hooks/useDashboardScope";
import type { BlockEnv } from "./blocks";

export default function SharedDashboard({ doc, elements, shareToken }: { doc: { _id: string; title: string; user?: { name?: string; image?: string } | null }; elements: ArtifactElement[]; shareToken: string }) {
  const blocks = useMemo(() => dashboard.orderedBlocks(elements), [elements]);
  const byKey = useMemo(() => new Map(elements.map((e) => [e.key, e])), [elements]);
  const layout = useMemo(() => dashboard.readLayout({ get: (k) => byKey.get(k) }), [byKey]);
  useDashboardFeed(doc._id, blocks, { canWant: true, shareToken });
  const results = useDataResults(doc._id);
  const now = useCoarseNow(15_000);
  // The check drawer, opened on a block or on one chart point's rows, the same as in the app.
  const [check, setCheck] = useState<{ key: string; point?: CheckPoint } | null>(null);
  const onCheck = useCallback((key: string) => setCheck({ key }), []);
  const onPoint = useCallback((key: string, x: string, series?: string) => setCheck({ key, point: { x, ...(series !== undefined ? { series } : {}) } }), []);
  const slotOf = useMemo(() => seriesSlots(blocks, results), [blocks, results]);
  // A filtered view travels in its link (?f.day=30d&f.person=ada): the shared page opens on the same rows, and its readers can change them.
  const filter = useDashboardScope(now);
  const scope = layout.format === "dashboard" ? filter.scope : undefined;
  const dims = useMemo(() => dashboard.filterDimensions([...dashboard.dashboardQueries(blocks).keys()].map((k) => results.get(k))), [blocks, results]);
  const env: BlockEnv = useMemo(() => ({ results, blocks: byKey, now, scope, slotOf, onCheck, onPoint }), [results, byKey, now, scope, slotOf, onCheck, onPoint]);
  const noop = useCallback(() => {}, []);
  // The byline speaks for the whole page: the oldest read among the queries it shows.
  const latest = useMemo(() => {
    const ages = [...dashboard.dashboardQueries(blocks).keys()].map((k) => results.get(k)?.refreshed_at ?? 0);
    return ages.length && ages.every((a) => a > 0) ? Math.min(...ages) : 0;
  }, [blocks, results]);
  const byline = (
    <>
      {doc.user?.image ? <img src={doc.user.image} alt="" className="w-4 h-4 rounded-full" /> : null}
      {doc.user?.name ? <span className="text-sol-text-muted">{doc.user.name}</span> : null}
      {latest ? <span>· data {dashboard.ago(now - latest)}</span> : null}
    </>
  );
  return (
    <div className="data-wrap relative h-full min-h-screen bg-sol-bg flex" data-shared-dashboard={doc._id}>
      <div className={`flex-1 min-w-0 ${layout.format === "short" ? "h-screen" : ""}`} onKeyDown={(e) => e.key === "Escape" && setCheck(null)}>
        <FormatBody title={doc.title} layout={layout} elements={elements} env={env} byline={byline}>
          {blocks.length ? <DashboardFilters dims={dims} value={filter.value} values={filter.values} set={filter.set} clear={filter.clear} /> : null}
          <DashboardGrid blocks={blocks} env={env} edit={false} selected={null} me={null} onSelect={noop} onEdit={noop} onRemove={noop} onSpan={noop} onMove={noop} />
        </FormatBody>
      </div>
      {check ? (
        <aside className="fixed right-0 top-0 bottom-0 w-[min(360px,100vw)] border-l border-sol-border/40 bg-sol-bg shadow-xl z-40">
          <CheckPanel key={`${check.key}|${check.point?.x ?? ""}|${check.point?.series ?? ""}`} docId={doc._id} block={byKey.get(check.key)} env={env} point={check.point} onClose={() => setCheck(null)} canRerun={false} />
        </aside>
      ) : null}
    </div>
  );
}

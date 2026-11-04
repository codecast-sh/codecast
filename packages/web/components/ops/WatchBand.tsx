// The Ops home's glance at the watches: a monitor summary (alert, erroring,
// warn, no data, OK; the alerting and erroring counts filter the list), then
// one tile per watch that is not fine and not already a row of the list
// (`listed`: the list shows alerting and blind watches itself), with its
// sparkline against its line and its value, tinted by its health and sorted
// worst first. The healthy ones fold behind the OK and No line counts and the retrying
// ones (a last read failed, an older value stands) behind the Retrying count,
// each opening them in place, so one reader timing out is one count and what
// is wrong stays near the top of the page. Each tile opens its
// MetricPage; the title opens the Metrics tab.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { SparkLine } from "../Spark";
import { opsHref, type OpsHomeShow } from "./opsPaths";
import { BAND_STATES, watchBand, watchRetrying } from "./opsHomeModel";
import { watchFailWord } from "./appsModel";
import { HEALTH_LOOK, formatValue, margin, watchHealth } from "./metricModel";
import { watchLine } from "./sourceViewModel";
import type { OpsWatch } from "./opsTypes";
import type { Health } from "./metricModel";

/** The summary counts that are also the home's filters: pressing one narrows the list to those rows. */
const COUNT_FILTER: Partial<Record<Health, OpsHomeShow>> = { alert: "alerting", error: "erroring" };
const NO_LISTED: ReadonlySet<string> = new Set();

/** Tiles drawn before the band's "All" link: the band is a glance, the Metrics tab is the list. */
const BAND_TILES = 12;

export function WatchBand({ watches, source, listed = NO_LISTED, readerBlind = NO_LISTED }: { watches: OpsWatch[]; source: string | null; listed?: ReadonlySet<string>; /** Watches blind behind a failing reader: counted as Blind, opening the reader's row, never as watch errors. */ readerBlind?: ReadonlySet<string> }) {
  const band = useMemo(() => watchBand(watches), [watches]);
  const blind = useMemo(() => band.watches.filter((w) => readerBlind.has(w._id) && watchHealth(w) === "error").length, [band, readerBlind]);
  const [open, setOpen] = useState<"ok" | "series" | "retrying" | null>(null);
  if (!band.watches.length) return null;
  // A retrying watch is counted once, as Retrying, never also under the health its older value reads.
  const countOf = (h: Health) => band.watches.filter((w) => watchHealth(w) === h && !watchRetrying(w)).length;
  const okN = countOf("ok");
  const seriesN = countOf("series");
  const attention = band.attention.filter((w) => !listed.has(w._id));
  const folded = open === "ok" || open === "series" ? band.healthy.filter((w) => watchHealth(w) === open) : open === "retrying" ? band.retrying : [];
  const all = [...attention, ...folded];
  const tiles = all.slice(0, BAND_TILES);
  const hidden = all.length - tiles.length;
  const toggle = (k: "ok" | "series" | "retrying") => setOpen((o) => (o === k ? null : k));
  const metrics = opsHref.tab("metrics", { source });
  return (
    <section className="ops-band" aria-label="Watches" data-ops-band data-open={open ?? undefined}>
      <div className="ops-band-head">
        <Link href={metrics} className="ops-band-title">Watches <span className="ops-num ops-dim">{band.watches.length}</span></Link>
        <div className="ops-band-sum" role="list" aria-label="Watches by state">
          {BAND_STATES.filter((h) => h !== "ok").flatMap((h) => {
            const n = h === "error" ? band.counts.error - blind : countOf(h);
            // Only the states that hold a watch: a zero takes room from the facts that matter, at every width.
            if (!n && !(h === "error" && blind)) return [];
            const body = (
              <>
                <i aria-hidden />
                <b className="ops-num">{n}</b>
                {HEALTH_LOOK[h].label}
              </>
            );
            const filter = COUNT_FILTER[h];
            const props = { role: "listitem", className: "ops-band-n", "data-ops-band-count": h, style: { ["--ink" as string]: HEALTH_LOOK[h].ink } };
            const chip = filter && n ? <Link key={h} href={opsHref.home({ source, show: filter })} {...props}>{body}</Link> : <span key={h} {...props}>{body}</span>;
            if (h !== "error" || !blind) return [chip];
            // The watches a failing reader leaves blind, as its row counts them ("4 watches blind"): they open the reader's row, never as watch errors.
            return [
              <Link key="reader" href={opsHref.home({ source, show: "reader" })} role="listitem" className="ops-band-n" data-ops-band-count="reader" style={{ ["--ink" as string]: HEALTH_LOOK.error.ink }}>
                <i aria-hidden />
                <b className="ops-num">{blind}</b>
                Blind
              </Link>,
              ...(n ? [chip] : []),
            ];
          })}
          {band.retrying.length > 0 && (
            <button type="button" role="listitem" className="ops-band-n ops-band-ok" aria-expanded={open === "retrying"} onClick={() => toggle("retrying")} data-ops-band-count="retrying" style={{ ["--ink" as string]: "var(--sol-yellow)" }} title={retryTip(band.retrying)}>
              <i aria-hidden />
              <b className="ops-num">{band.retrying.length}</b>
              retrying
              <ChevronDown className="w-3 h-3 ops-band-chev" aria-hidden />
            </button>
          )}
          {/* Inside its line is OK; a watch with no line is unjudged (No line), the word the Metrics filter and the Apps board use. Each folds behind its count. */}
          {([["ok", okN], ["series", seriesN]] as const).map(([h, n]) => n > 0 && (
            <button key={h} type="button" className="ops-band-n ops-band-ok" aria-expanded={open === h} onClick={() => toggle(h)} data-ops-band-count={h} data-ops-band-ok={h === "ok" ? "" : undefined} style={{ ["--ink" as string]: HEALTH_LOOK[h].ink }}>
              <i aria-hidden /><b className="ops-num">{n}</b>{HEALTH_LOOK[h].label}
              <ChevronDown className="w-3 h-3 ops-band-chev" aria-hidden />
            </button>
          ))}
        </div>
        {hidden > 0 && <Link href={metrics} className="ops-link ops-band-all">All {band.watches.length}</Link>}
      </div>
      {tiles.length > 0 && (
        <div className="ops-band-tiles">
          {tiles.map((w) => <WatchTile key={w._id} watch={w} />)}
        </div>
      )}
    </section>
  );
}

/** What the retrying watches' last reads failed with, counted: "6 timed out". */
function retryTip(ws: readonly OpsWatch[]): string {
  const by = new Map<string, number>();
  for (const w of ws) {
    const word = watchFailWord("retrying", w.last_error) ?? "failed";
    by.set(word, (by.get(word) ?? 0) + 1);
  }
  return `Last read failed, an older value stands: ${[...by].map(([k, n]) => `${n} ${k}`).join(" · ")}`;
}

function WatchTile({ watch: w }: { watch: OpsWatch }) {
  const health = watchHealth(w);
  const retrying = watchRetrying(w);
  const look = retrying ? { label: "retrying", ink: "var(--sol-yellow)" } : HEALTH_LOOK[health];
  const values = w.points.slice(-48).map((p) => p.value);
  const room = margin(w);
  const line = watchLine(w);
  const tip = [w.name, look.label, line, room !== null && health === "ok" ? `${Math.round(room * 100)}% room to its line` : null, w.last_error && (health === "error" || retrying) ? w.last_error : null].filter(Boolean).join(" · ");
  return (
    <Link href={opsHref.metric(w.short_id || w._id)} className="ops-band-tile" data-health={health} data-retrying={retrying ? "true" : undefined} data-ops-band-watch={w.short_id} style={{ ["--ink" as string]: look.ink }} title={tip}>
      <span className="ops-band-name">{w.name}</span>
      <span className="ops-band-val ops-num">{health === "error" ? "error" : retrying ? "retrying" : w.last_value != null ? formatValue(w.last_value, w.unit) : "no data"}</span>
      <span className="ops-band-spark" aria-hidden>
        {values.length > 1 ? <SparkLine values={values} target={w.threshold ?? null} width={96} height={18} tone={health === "ok" || health === "series" ? "var(--sol-text-muted)" : look.ink} label={w.name} /> : null}
      </span>
    </Link>
  );
}

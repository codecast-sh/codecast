// The Ops home's glance at the watches: a monitor summary in the Metrics
// chips' own states, words and counts (metricModel watchState: alert, blind,
// erroring, retrying, warn, no data, OK, no line; alert, blind and erroring
// filter the list), then
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
import { BAND_ATTENTION, BAND_STATES, watchBand } from "./opsHomeModel";
import { watchFailWord } from "./appsModel";
import { WATCH_STATE_LOOK, formatValue, margin, watchHealth, type WatchState } from "./metricModel";
import { watchLine } from "./sourceViewModel";
import type { OpsWatch } from "./opsTypes";

/** The summary counts that are also the home's filters: pressing one narrows the list to those rows. */
const COUNT_FILTER: Partial<Record<WatchState, OpsHomeShow>> = { alert: "alerting", error: "erroring", blind: "reader" };
const NO_LISTED: ReadonlySet<string> = new Set();

/** Tiles drawn before the band's "All" link: the band is a glance, the Metrics tab is the list. */
const BAND_TILES = 12;

export function WatchBand({ watches, source, listed = NO_LISTED, readerBlind = NO_LISTED }: { watches: OpsWatch[]; source: string | null; listed?: ReadonlySet<string>; /** Watches blind behind a failing reader: counted as Blind (the Metrics chips' word), opening the reader's row. */ readerBlind?: ReadonlySet<string> }) {
  const band = useMemo(() => watchBand(watches, readerBlind), [watches, readerBlind]);
  const [open, setOpen] = useState<WatchState | null>(null);
  if (!band.watches.length) return null;
  const attention = band.attention.filter((w) => !listed.has(w._id));
  const folded = open && !BAND_ATTENTION.has(open) ? band.watches.filter((w) => band.stateOf(w) === open) : [];
  const all = [...attention, ...folded];
  const tiles = all.slice(0, BAND_TILES);
  const hidden = all.length - tiles.length;
  const metrics = opsHref.tab("metrics", { source });
  return (
    <section className="ops-band" aria-label="Watches" data-ops-band data-open={open ?? undefined}>
      <div className="ops-band-head">
        <Link href={metrics} className="ops-band-title">Watches <span className="ops-num ops-dim">{band.watches.length}</span></Link>
        <div className="ops-band-sum" role="list" aria-label="Watches by state">
          {BAND_STATES.map((h) => {
            const n = band.counts[h];
            // Only the states that hold a watch: a zero takes room from the facts that matter, at every width.
            if (!n) return null;
            const look = WATCH_STATE_LOOK[h];
            const filter = COUNT_FILTER[h];
            const props = { role: "listitem", "data-ops-band-count": h, style: { ["--ink" as string]: look.ink } };
            const body = <><i aria-hidden /><b className="ops-num">{n}</b>{look.label}</>;
            if (filter) return <Link key={h} href={opsHref.home({ source, show: filter })} className="ops-band-n" {...props}>{body}</Link>;
            if (BAND_ATTENTION.has(h)) return <span key={h} className="ops-band-n" {...props}>{body}</span>;
            // Retrying, OK and No line fold behind their count, each opening its watches in place.
            return (
              <button key={h} type="button" className="ops-band-n ops-band-ok" aria-expanded={open === h} onClick={() => setOpen((o) => (o === h ? null : h))} title={h === "retrying" ? retryTip(band.watches.filter((w) => band.stateOf(w) === "retrying")) : undefined} data-ops-band-ok={h === "ok" ? "" : undefined} {...props}>
                {body}
                <ChevronDown className="w-3 h-3 ops-band-chev" aria-hidden />
              </button>
            );
          })}
        </div>
        {hidden > 0 && <Link href={metrics} className="ops-link ops-band-all">All {band.watches.length}</Link>}
      </div>
      {tiles.length > 0 && (
        <div className="ops-band-tiles">
          {tiles.map((w) => <WatchTile key={w._id} watch={w} state={band.stateOf(w)} />)}
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

function WatchTile({ watch: w, state }: { watch: OpsWatch; state: WatchState }) {
  const health = watchHealth(w);
  const retrying = state === "retrying";
  const look = WATCH_STATE_LOOK[state];
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

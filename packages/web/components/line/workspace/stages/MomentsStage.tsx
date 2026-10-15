"use client";
// Moments (learning-loop.md LL7): what the product sends, one per (kind,
// subject) once its events go quiet, read by the kind's extractor on the
// product's machine. The page says first whether anything is arriving, then
// each kind: its extractor (file, version, quiet window, the machine that runs
// it), its moments by state, the versions that read them, the newest and the
// failed. A moment opens whole (MomentView), as the judge read it.
import { useMemo } from "react";
import { Circle, Link2, Mail, Phone, type LucideIcon } from "lucide-react";
import { useLineStages, type LineKindRow, type LineMomentRow } from "../../../../hooks/useLineStages";
import { agoWords, sumArrivals } from "../../../../lib/line/flowStages";
import { MomentView } from "../../widgets/MomentView";
import { dayWords } from "../../widgets";
import type { LineViewProps } from "../views/types";
import { Back, DayStrip, Gap, Section, StageHead, Version } from "./parts";

const STATUS_TONE: Record<string, string> = { waiting: "dim", extracting: "live", ready: "ok", failed: "bad" };
const minutes = (ms: number) => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

export function MomentsStage({ workspace: ws, selection, select, href, projectId }: LineViewProps & { projectId: string | null }) {
  const st = useLineStages(projectId);
  const now = ws.now;
  const arrival = useMemo(() => (st ? sumArrivals(st.kinds, now) : null), [st, now]);
  const item = selection.item;
  const openMoment = (m: string | null) => select({ item: m });
  if (item && /^mo-\d+$/.test(item)) {
    return (
      <div className="sd" data-line-stage="moments" data-line-stage-item={item}>
        <Back label="Moments" onBack={() => openMoment(null)} href={href({ item: null })} />
        <MomentView moment={item} />
      </div>
    );
  }
  if (!st || !arrival) return <div className="lw-skeleton" aria-busy>{[60, 90, 40].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
  const held = st.kinds.reduce((n, k) => n + k.total, 0);
  const failed = st.kinds.reduce((n, k) => n + k.counts.failed, 0);
  const waiting = st.kinds.reduce((n, k) => n + k.counts.waiting + k.counts.extracting, 0);
  const newestEvent = st.kinds.reduce((m, k) => Math.max(m, k.newest_event_at ?? 0), 0);
  const replayed = st.kinds.reduce((n, k) => n + k.replayed, 0);
  return (
    <div className="sd" data-line-stage="moments">
      <StageHead
        title="Moments"
        sub={`From ${st.sources.join(", ") || "no source"} · each kind's extractor runs on the product's machine`}
        figures={[
          { label: "Today", n: arrival.today, tone: arrival.tone === "live" ? "live" : "warn" },
          { label: "This week", n: arrival.week.toLocaleString("en-US") },
          { label: "Last arrived", n: arrival.lastAt ? `${agoWords(arrival.lastAt, now)} ago` : "never", tone: arrival.tone === "live" ? undefined : "warn" },
          { label: "Waiting", n: waiting },
          { label: "Failed", n: failed, tone: failed ? "bad" : "dim" },
          { label: st.window.capped ? `Held (newest ${st.window.moments})` : "Held", n: held.toLocaleString("en-US") },
        ]}
      >
        {/* Nothing arriving is the headline when it is so: a replay's moments carry old events and must not read as live traffic. */}
        {arrival.tone !== "live" && (
          <p className="sd-alert" data-tone="warn" data-line-moments-quiet>
            <b>Nothing arriving</b>
            <span>{arrival.lastAt ? `last moment ${dayWords(arrival.lastAt)}` : "no moment yet"}{newestEvent ? ` · newest event ${dayWords(newestEvent)}` : ""}{replayed ? ` · ${replayed.toLocaleString("en-US")} this week were replays of older events` : ""}</span>
          </p>
        )}
        <DayStrip days={arrival.days} now={now} label="moments" />
      </StageHead>
      {st.kinds.map((k) => <KindCard key={`${k.source}|${k.kind}`} k={k} now={now} open={openMoment} href={(m) => href({ item: m })} />)}
      <Gap what="Extractor source" why="kept on the product's machine; codecast holds its path and version, not the file" />
      <Gap what="A moment before and after an extractor change" why="a moment keeps only its newest read; no earlier body is stored to compare" />
    </div>
  );
}

function KindCard({ k, now, open, href }: { k: LineKindRow; now: number; open: (m: string) => void; href: (m: string) => string }) {
  const ex = k.extractor;
  const stale = k.versions.filter((v) => ex && v.version !== ex.version).reduce((n, v) => n + v.n, 0);
  return (
    <article className="sd-card" data-line-moment-kind={k.kind}>
      <header className="sd-card-h">
        <b>{k.kind}</b>
        <span className="sd-dim">{k.source}</span>
        <Version v={ex?.version ?? null} current />
        <span className="sd-spacer" />
        <span className="sd-counts">
          {(["waiting", "extracting", "ready", "failed"] as const).map((s) => (
            <span key={s} data-tone={k.counts[s] ? STATUS_TONE[s] : "dim"}><b className="lw-num">{k.counts[s].toLocaleString("en-US")}</b> {s}</span>
          ))}
        </span>
      </header>
      {ex ? (
        <dl className="sd-facts">
          <div><dt>Extractor</dt><dd className="lw-mono" title={ex.path}>{ex.path}</dd></div>
          <div><dt>Quiet window</dt><dd>{minutes(ex.quiet_ms)}</dd></div>
          <div><dt>Timeout</dt><dd>{minutes(ex.timeout_ms)}</dd></div>
          <div><dt>Read after</dt><dd>{k.gap_ms != null ? `${minutes(k.gap_ms)} median` : "–"}</dd></div>
          <div><dt>Published</dt><dd>{dayWords(ex.published_at)}</dd></div>
          <div><dt>Runs on</dt><dd className="lw-mono" title={ex.root}>{ex.device_id.slice(0, 10)}</dd></div>
        </dl>
      ) : <p className="sd-alert" data-tone="bad"><b>No extractor</b><span>moments of this kind wait until one is published</span></p>}
      <DayStrip days={k.days} now={now} label={`${k.kind} moments`} />
      {k.versions.length > 0 && (
        <div className="sd-scroll"><table className="sd-table" data-line-extractor-versions>
          <thead><tr><th>Read by version</th><th className="sd-n">Moments</th><th className="sd-n">Last read</th></tr></thead>
          <tbody>
            {k.versions.map((v) => (
              <tr key={v.version} data-stale={ex && v.version !== ex.version ? "" : undefined}>
                <td><Version v={v.version} current={v.version === ex?.version} />{ex && v.version !== ex.version && <span className="sd-dim"> older</span>}</td>
                <td className="sd-n lw-num">{v.n.toLocaleString("en-US")}</td>
                <td className="sd-n">{dayWords(v.last_at)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {stale > 0 && <p className="sd-note" data-tone="warn">{stale} moments read by an older extractor</p>}
      {k.failed.length > 0 && <MomentList title="Failed" rows={k.failed} open={open} href={href} now={now} />}
      <MomentList title="Newest" rows={k.recent} open={open} href={href} now={now} total={k.total} />
    </article>
  );
}

/** When a moment's events happened, as a list reads it: a time today, else a day and time. */
function eventWords(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return now - at < 86_400_000 && new Date(now).getDate() === d.getDate() ? time : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** A moment's kind as a small mark (a phone, an envelope, a link), so a list mixing kinds scans by shape. */
const KIND_MARK: Array<[RegExp, LucideIcon, string]> = [[/call|phone|voice/i, Phone, "call"], [/conversation|email|mail|message/i, Mail, "email"], [/match|intro/i, Link2, "match"]];
function KindMark({ kind }: { kind: string }) {
  const [, Icon, word] = KIND_MARK.find(([re]) => re.test(kind)) ?? [null, Circle, kind];
  return <Icon className="sd-kind" aria-label={word} data-kind={word}><title>{kind}</title></Icon>;
}

/** What the judges made of a moment. Clean recedes; a break stands out, and says whether the line took it: filed
 *  is on a problem now, "not filed" is a break the judges saw that the line did not take (held, out of scope, or
 *  already on the board from another moment). */
function Verdict({ m }: { m: LineMomentRow }) {
  if (m.status === "failed") return <span className="sd-pill" data-tone="bad" title={m.error}>extract failed</span>;
  if (m.status !== "ready") return <span className="sd-verdict" data-tone="dim">{m.status}</span>;
  const v = m.verdict;
  if (!v.judges) return <span className="sd-verdict" data-tone="dim">not judged</span>;
  if (v.failed === v.judges) return <span className="sd-pill" data-tone="bad">judge failed</span>;
  if (!v.found) return <span className="sd-verdict" data-tone="dim">clean</span>;
  const breaks = `${v.found} ${v.found === 1 ? "break" : "breaks"}`;
  const taken = v.filed === 0 ? "not filed" : v.filed >= v.found ? "filed" : `${v.filed} filed`;
  return (
    <span className="sd-verdict" data-tone={v.filed ? "filed" : "unfiled"} title={v.filed < v.found ? `${v.found - v.filed} the judges saw that the line did not take: held, out of scope, or already on the board from another moment` : "on a problem now"}>
      <b>{breaks}</b><span>{taken}</span>
    </span>
  );
}

function MomentList({ title, rows, open, href, now, total }: { title: string; rows: LineMomentRow[]; open: (m: string) => void; href: (m: string) => string; now: number; total?: number }) {
  if (!rows.length) return null;
  return (
    <Section title={title} n={total ?? rows.length}>
      <ul className="sd-list">
        {rows.map((m) => (
          <li key={m.short_id}>
            <a className="sd-row sd-moment" href={href(m.short_id)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); open(m.short_id); }} title={`${m.short_id} · ${m.subject}`} data-line-moment={m.short_id}>
              {/* Named by who it is about and when it happened; the id stays behind it, last. */}
              <KindMark kind={m.kind} />
              <span className="sd-row-t">{m.who ? <b>{m.who}</b> : <span className="sd-dim">No name sent</span>}</span>
              <span className="sd-dim lw-num" title={new Date(m.event_at).toLocaleString()}>{eventWords(m.event_at, now)}</span>
              <Verdict m={m} />
              <span className="lw-mono sd-id">{m.short_id}</span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

"use client";
// The moment a codecast judge read (learning-loop.md LL8, line-workspace.md
// LW1): its header (kind, subject, the time its facts describe, the event
// that triggered it, its source), its body as the judge saw it (messages as
// messages, text and facts under their own titles) with the words judges
// quoted marked, and every judge's run on it with what it cited. Folded to a
// readable height; Expand shows the whole.
import { memo, useMemo, useState, type ReactNode } from "react";
import { useAction } from "convex/react";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ExternalLink } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { MomentBlock, MomentRecord } from "@codecast/shared/contracts/moments";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import "./momentView.css";

type MomentRow = NonNullable<FunctionReturnType<typeof api.lineMoments.momentForWeb>>;
type Run = MomentRow["runs"][number];

/** Bodies already read this page load, by moment: a moment reopened paints at once. */
const bodies = new Map<string, Promise<MomentRecord | null>>();

function useMomentBody(moment: string, kept: boolean): { body: MomentRecord | null; loading: boolean } {
  const read = useAction(api.lineMoments.momentBodyForWeb);
  const [state, setState] = useState<{ key: string; body: MomentRecord | null } | null>(null);
  useWatchEffect(() => {
    if (!kept) return;
    let live = true;
    let p = bodies.get(moment);
    if (!p) {
      p = read({ moment }).catch(() => null);
      bodies.set(moment, p);
      // A failed read is not remembered: the next open asks again.
      void p.then((b) => { if (!b) bodies.delete(moment); });
    }
    void p.then((body) => { if (live) setState({ key: moment, body }); });
    return () => { live = false; };
  }, [moment, kept]);
  const body = state?.key === moment ? state.body : null;
  return { body, loading: kept && state?.key !== moment };
}

const time = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** `text` with every quoted span marked. */
function marked(text: string, quotes: ReadonlyArray<string>): ReactNode {
  const spans: Array<[number, number]> = [];
  for (const q of quotes) {
    if (q.length < 4) continue;
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) spans.push([i, i + q.length]);
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let at = 0;
  for (const [s, e] of spans) {
    if (s < at) continue;
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={s} className="mv-mark">{text.slice(s, e)}</mark>);
    at = e;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function Block({ b, quotes }: { b: MomentBlock; quotes: ReadonlyArray<string> }) {
  if (b.type === "message") {
    const In = b.direction === "in";
    return (
      <div className="mv-msg" data-dir={b.direction}>
        <div className="mv-msg-meta">
          {In ? <ArrowDownLeft aria-hidden /> : <ArrowUpRight aria-hidden />}
          <b>{b.sender ?? (In ? "customer" : "product")}</b>
          <span>{b.channel}</span>
          <span className="lw-num">{clock(b.at)}</span>
          {b.delivery && <span className="mv-deliv" data-state={b.delivery}>{b.delivery}</span>}
        </div>
        <div className="mv-msg-body">{marked(b.body, quotes)}</div>
      </div>
    );
  }
  if (b.type === "facts") {
    return (
      <div className="mv-block">
        {b.title && <h5 className="mv-bt">{b.title}</h5>}
        <dl className="mv-facts">
          {b.facts.map((f, i) => <div key={i}><dt>{f.label}</dt><dd>{marked(f.value, quotes)}</dd></div>)}
        </dl>
      </div>
    );
  }
  return (
    <div className="mv-block">
      {b.title && <h5 className="mv-bt">{b.title}</h5>}
      <pre className="mv-text">{marked(b.text, quotes)}</pre>
    </div>
  );
}

const sevTone = (s: number) => (s >= 7 ? "hi" : s >= 4 ? "mid" : "lo");

function RunLine({ r, cited }: { r: Run; cited?: string | null }) {
  const verdict = r.status !== "ok" ? r.status : r.findings.length ? `${r.findings.length} miss${r.findings.length === 1 ? "" : "es"}` : "met";
  const tone = r.status === "failed" ? "bad" : r.status === "skipped" ? "none" : r.findings.length ? "warn" : "ok";
  return (
    <div className="mv-run" data-line-moment-run={r.judge}>
      <div className="mv-run-h">
        <b>{r.judge}</b>
        <span className="mv-dim" title={`version ${r.judge_version}`}>{r.judge_version.slice(0, 7)}</span>
        {r.mode === "shadow" && <span className="mv-chip">shadow</span>}
        <span className="mv-verdict" data-tone={tone}>{verdict}</span>
        {r.filed > 0 && <span className="mv-dim">{r.filed} filed</span>}
        {r.reason && <span className="mv-reason" title={r.reason}>{r.reason}</span>}
        <span className="mv-sp" />
        <span className="mv-dim" title={`${r.model}, $${r.cost_usd.toFixed(4)}`}>{time(r.at)}</span>
      </div>
      {r.findings.length > 0 && (
        <ul className="mv-cites">
          {r.findings.map((f, i) => (
            <li key={i} data-cited={cited && f.expectation === cited ? "" : undefined}>
              <span className="mv-sev" data-tone={sevTone(f.severity)}>{f.severity}</span>
              <code className="mv-exp">{f.expectation}</code>
              <span className="mv-what">{f.what_happened}</span>
              {f.quote && <q className="mv-quote">{f.quote}</q>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type MomentViewProps = {
  /** The moment's short id (mo-N), as the finding carries it. */
  moment: string;
  /** The expectation the finding being read cites: its line in the judge runs is lit. */
  cited?: string | null;
  /** Folded height in px; Expand shows the whole. */
  foldAt?: number;
};

export const MomentView = memo(function MomentView({ moment, cited, foldAt = 300 }: MomentViewProps) {
  const { data: m, error } = useQueryNoThrow(api.lineMoments.momentForWeb, { moment });
  const { body, loading } = useMomentBody(moment, !!m?.kept);
  const [open, setOpen] = useState(false);
  const quotes = useMemo(() => (m?.runs ?? []).flatMap((r) => r.findings.map((f) => f.quote).filter(Boolean)), [m]);

  if (m === undefined && !error) return <div className="mv" data-line-moment="reading"><span className="mv-dim"><span className="lw-spin" aria-hidden /> {moment}</span></div>;
  if (!m) return <div className="mv" data-line-moment="none"><span className="mv-dim">{moment} not readable here</span></div>;

  const asOf = body?.at ?? m.event_at;
  const links = (body?.refs ?? []).filter((r) => r.url || r.id !== m.subject);
  // The event's refs, less what the header and the body's own refs already say; its `trigger` leads.
  const said = new Set([m.subject, ...links.map((r) => r.id)]);
  const named = m.refs.trigger ?? null;
  const trigger = Object.entries(m.refs).filter(([k, val]) => k !== "trigger" && k !== "as_of" && !said.has(val));
  const blocks = body?.blocks ?? [];
  const held = m.status !== "ready" ? m.status : !m.kept ? (m.storage === "host" ? "body on host" : "body expired") : null;
  return (
    <div className="mv" data-line-moment={m.short_id}>
      <div className="mv-head">
        <span className="mv-kind">{m.kind}</span>
        <b className="mv-subject" title={m.subject}>{m.subject}</b>
        <span className="mv-k">as of</span><span className="lw-num">{time(asOf)}</span>
        {m.gap_ms != null && m.gap_ms > 60_000 && <span className="mv-dim" title="How long after the newest event the facts were read">+{Math.round(m.gap_ms / 60_000)}m read</span>}
        <span className="mv-sp" />
        {m.source && <span className="mv-chip" data-k="source">{m.source}</span>}
        <span className="mv-id">{m.short_id}</span>
      </div>
      {(named || trigger.length > 0 || links.length > 0 || m.events > 1) && (
        <div className="mv-trig">
          <span className="mv-k">trigger</span>
          {named && <b className="mv-trig-name">{named}</b>}
          {m.events > 1 && <span className="mv-dim">{m.events} events</span>}
          {trigger.map(([k, val]) => <span key={k} className="mv-ref"><i>{k}</i>{val}</span>)}
          {links.map((r) => r.url
            ? <a key={`${r.label}:${r.id}`} className="mv-ref" href={r.url} target="_blank" rel="noreferrer"><i>{r.label}</i>{r.id}<ExternalLink aria-hidden /></a>
            : <span key={`${r.label}:${r.id}`} className="mv-ref"><i>{r.label}</i>{r.id}</span>)}
        </div>
      )}

      {held ? (
        <div className="mv-held" data-state={m.status}>{held}{m.error ? `: ${m.error}` : ""}{m.blocks != null ? <span className="mv-dim"> · {m.blocks} blocks</span> : null}</div>
      ) : loading ? (
        <div className="mv-held"><span className="lw-spin" aria-hidden /> {m.blocks ?? ""} blocks</div>
      ) : !body ? (
        <div className="mv-held">body unreadable</div>
      ) : (
        <div className="mv-body-wrap" data-open={open ? "" : undefined}>
          <div className="mv-body" style={open ? undefined : { maxHeight: foldAt }}>
            {blocks.map((b, i) => <Block key={i} b={b} quotes={quotes} />)}
          </div>
          <button type="button" className="mv-expand" onClick={() => setOpen(!open)} aria-expanded={open}>
            <ChevronDown aria-hidden />{open ? "Fold" : `Expand · ${blocks.length} blocks`}
          </button>
        </div>
      )}

      {m.runs.length > 0 && (
        <div className="mv-runs" data-line-moment-runs={m.runs.length}>
          {m.runs.map((r, i) => <RunLine key={i} r={r} cited={cited} />)}
        </div>
      )}
    </div>
  );
});

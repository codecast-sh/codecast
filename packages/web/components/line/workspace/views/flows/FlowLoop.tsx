"use client";
// The Flows page's Loop view (ct-87142): the whole system a change moves
// through, drawn from the store. Across the top the rules people set, each over
// the stage it governs and each opening where it is set. Under them the five
// stages: signals come in; a person's session and the line are the two ways in,
// and both reach the same checks; then the change lands, deploys and is
// watched; and what production shows comes back along the foot as the next
// signal. Every stage carries the count the store holds now, and every count
// that waits on a person opens where they act on it. The model is
// lib/line/flowLoop.ts; this draws it.
import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { CircleDot, ListChecks, User } from "lucide-react";
import type { FlowLoop as Loop } from "../../../../../lib/line/flowLoop";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";
import { lineSettingsHref } from "../../../../../lib/lineSettings";
import type { LineViewProps } from "../types";
import "./flowLoop.css";

/** A measured sample: changes in it, how many have settled, and the rate over the settled ones (null before any). */
export type Measured = { n: number; settled: number; rate: number | null };
/** What the measured rates add, when their query answers (landedChanges.summary, ct-87140): regret-free by the way a change came in, and each check's miss rate. */
export type LoopRates = { windowDays: number; line: Measured; person: Measured; outside: Measured; checks: ReadonlyMap<string, Measured> } | null;

type Go = { href: string; go?: () => void };
const follow = (to: Go) => (e: MouseEvent) => { if (!to.go || e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); to.go(); };
const pct = (r: number) => `${Math.round(r * 100)}%`;

/** A rate with its sample, so an unsettled one says so instead of reading as blank or 0%. */
function Rate({ m, none, tone }: { m: Measured; none: string; tone?: "bad" }) {
  if (!m.n) return <span className="lp-rate-v" data-empty="">{none}</span>;
  if (m.rate == null) return <span className="lp-rate-v" data-empty=""><b className="lw-num">{m.n.toLocaleString()}</b>, none settled</span>;
  return <span className="lp-rate-v" data-tone={tone}><b className="lw-num">{pct(m.rate)}</b> of {m.settled.toLocaleString()}</span>;
}

/** A figure that opens where it is acted on; a zero earns no space. */
function Fig({ n, label, to, tone }: { n: number; label: string; to?: Go; tone?: "you" | "bad" | "live" }) {
  if (!n) return null;
  const body = <><span className="lp-fig-n">{tone === "you" ? <User className="lp-fig-icon" aria-hidden /> : null}<b className="lw-num">{n.toLocaleString()}</b></span> {label}</>;
  return to ? <a className="lp-fig" data-tone={tone} href={to.href} onClick={follow(to)}>{body}</a> : <span className="lp-fig" data-tone={tone}>{body}</span>;
}

function Rule({ name, to, children }: { name: string; to: Go; children: ReactNode }) {
  return (
    <a className="lp-rule" href={to.href} onClick={follow(to)}>
      <span className="lp-rule-name">{name}</span>
      <span className="lp-rule-val">{children}</span>
    </a>
  );
}

export function FlowLoop({ loop, rates, href, select, liveKey, onShowFlows }: {
  loop: Loop; rates: LoopRates; href: LineViewProps["href"]; select: LineViewProps["select"]; liveKey: string | null; onShowFlows: () => void;
}) {
  const at = (patch: LineSelectionPatch): Go => ({ href: href(patch), go: () => select(patch) });
  const signals = at({ view: "signals", sig: null, stage: null, item: null, source: null });
  const forYou = at({ view: "foryou" });
  const library = (item: string | null) => at({ view: "flows", item, run: null });
  const shipped = at({ view: "shipped" });
  const r = loop.rules;
  return (
    <section className="lp" aria-label="The whole loop" data-flow-loop="">
      {/* The rules people set, each over the stage it governs. */}
      <div className="lp-row lp-rules">
        <Rule name="Sources to watch" to={signals}>
          <Fig n={r.sources.feeds} label="feeding" />
          <Fig n={r.sources.silent} label="silent" tone="bad" />
          <Fig n={r.sources.unfiled} label="not filed" tone="bad" />
        </Rule>
        <Rule name="Goals and owners" to={{ href: "/org" }}>
          <Fig n={r.owners.roles} label={r.owners.roles === 1 ? "owner" : "owners"} />
          <Fig n={r.owners.projects} label={r.owners.projects === 1 ? "project" : "projects"} />
        </Rule>
        <Rule name="Skills" to={liveKey ? at({ view: "line", graph: liveKey, mode: "table", step: null }) : library(null)}>
          <Fig n={r.skills.prompts} label={r.skills.prompts === 1 ? "prompt" : "prompts"} />
        </Rule>
        <Rule name="Review and gates" to={library(null)}>
          <Fig n={r.gates.checks} label={r.gates.checks === 1 ? "check" : "checks"} />
          <Fig n={r.gates.people} label={r.gates.people === 1 ? "person gate" : "person gates"} tone="you" />
        </Rule>
        <Rule name="Autonomy" to={{ href: lineSettingsHref({ section: "starts" }) }}>
          <span className="lp-fig lp-fig-wrap"><b className="lw-num">{r.autonomy.merging}</b> of {r.autonomy.roles} roles merge without a person</span>
          {/* The measured rate that earns a role its merge (ct-87140), by the way the change came in. */}
          {rates ? (
            <span className="lp-rates" data-loop-rates="">
              <span className="lp-rates-k">Regret-free, {rates.windowDays}-day window</span>
              <span className="lp-rate" data-loop-rate="line" title="Changes the line made, from a role's run"><span className="lp-rate-k">Line</span><Rate m={rates.line} none="no changes" /></span>
              <span className="lp-rate" data-loop-rate="person" title="A person's session sent the change through a check flow"><span className="lp-rate-k">Person</span><Rate m={rates.person} none="no changes" /></span>
              <span className="lp-rate" data-loop-rate="outside" title="Changes that went through no check flow"><span className="lp-rate-k">No flow</span><Rate m={rates.outside} none="no changes" /></span>
            </span>
          ) : null}
        </Rule>
      </div>

      <ol className="lp-row lp-stages">
        {["Signals", "Triage", "Build", "Checks", "Ship and watch"].map((s, i) => <li key={s}><span className="lp-stage-n lw-num">{i + 1}</span>{s}</li>)}
      </ol>

      <div className="lp-body">
        {/* 1. What comes in. */}
        <div className="lp-box lp-signals">
          <a className="lp-box-head" href={signals.href} onClick={follow(signals)}><b className="lw-num">{loop.signals.today.toLocaleString()}</b> signals today</a>
          <ul className="lp-sources">
            {loop.signals.top.map((s) => (
              <li key={s.key} data-state={s.state}><span className="lp-src-name">{s.label}</span>{s.today ? <span className="lw-num">{s.today}</span> : null}</li>
            ))}
          </ul>
        </div>

        {/* 2 and 3. The two ways in: a person's session, and the line. */}
        <div className="lp-box lp-lane" data-lane="person">
          <span className="lp-lane-k"><User className="lp-icon" aria-hidden />A person's session</span>
          {/* The step's name opens the flow; what waits on a person opens where they answer it. */}
          <div className="lp-step">
            <a className="lp-step-name" href={library("change").href} onClick={follow(library("change"))}>Ships through a flow</a>
            <span className="lp-figs">
              <Fig n={loop.person.running} label="running" tone="live" />
              <Fig n={loop.person.waiting} label="on a person" tone="you" to={forYou} />
            </span>
          </div>
        </div>
        <div className="lp-box lp-lane" data-lane="line">
          <span className="lp-lane-k"><CircleDot className="lp-icon" aria-hidden />The line, from signals</span>
          <a className="lp-step" href={at({ view: "problems", status: "notstarted" }).href} onClick={follow(at({ view: "problems", status: "notstarted" }))}>
            <span className="lp-step-name">Triage</span>
            <span className="lp-figs">
              <Fig n={loop.problems.queued} label="queued" />
              <Fig n={loop.problems.open} label="open" />
            </span>
          </a>
          <div className="lp-step">
            <button type="button" className="lp-step-name lp-name-btn" onClick={onShowFlows}>Build</button>
            <span className="lp-figs">
              <Fig n={loop.line.running} label="running" tone="live" />
              <Fig n={loop.line.waiting} label="on a person" tone="you" to={forYou} />
              <Fig n={loop.line.stalled} label="stalled" tone="bad" />
            </span>
          </div>
        </div>

        {/* 4. The same checks, whichever way the change came in. */}
        <div className="lp-box lp-checks">
          <span className="lp-box-k">Same checks, every change</span>
          <ul>
            {loop.checks.map((c) => (
              <li key={c.slug}>
                <div className="lp-check" data-person={c.person ? "" : undefined}>
                  {c.person ? <User className="lp-icon lp-icon-person" aria-label="A person decides" /> : <ListChecks className="lp-icon" aria-label="Automated check" />}
                  <a className="lp-step-name" href={library(c.slug).href} onClick={follow(library(c.slug))}>{c.label}</a>
                  <span className="lp-figs">
                    <Fig n={c.at - c.waiting} label="here" tone="live" />
                    <Fig n={c.waiting} label="on a person" tone="you" to={forYou} />
                  </span>
                  {/* Its miss rate: how often a change it passed came back (ct-87140). */}
                  {rates ? <span className="lp-miss" data-loop-miss={c.slug}><span className="lp-rate-k">Missed</span> <Rate m={rates.checks.get(c.slug) ?? { n: 0, settled: 0, rate: null }} none="none passed yet" tone="bad" /></span> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* 5. In, out, and watched. */}
        <div className="lp-box lp-ship">
          <Link className="lp-step" href="/deploys">
            <span className="lp-step-name">Land</span>
            <span className="lp-figs"><Fig n={loop.ship.landing} label="waiting to merge" tone="you" /></span>
          </Link>
          <Link className="lp-step" href="/deploys">
            <span className="lp-step-name">Deploy</span>
            <span className="lp-figs">
              <Fig n={loop.ship.going} label="going out" tone="live" />
              <Fig n={loop.ship.liveToday} label="live today" />
              <Fig n={loop.ship.failedToday} label="failed" tone="bad" />
            </span>
          </Link>
          <a className="lp-step" href={shipped.href} onClick={follow(shipped)}>
            <span className="lp-step-name">Watch</span>
            <span className="lp-figs"><Fig n={loop.ship.watching} label="watching" /></span>
          </a>
          <span className="lp-prod">Production</span>
        </div>
      </div>

      {/* What production shows becomes the next signal. */}
      <a className="lp-back" href={shipped.href} onClick={follow(shipped)} data-loop-back="">
        <span className="lp-back-k">Back to signals</span>
        <Fig n={loop.back.regressed} label="regressed" tone="bad" />
        <Fig n={loop.back.reopened} label="reopened by a finding" tone="bad" />
        {!loop.back.regressed && !loop.back.reopened ? <span className="lp-fig">nothing came back</span> : null}
      </a>

      <div className="lp-legend" aria-label="Key">
        <span><User className="lp-icon lp-icon-person" aria-hidden />A person decides</span>
        <span><ListChecks className="lp-icon" aria-hidden />Automated check</span>
        <span><i className="lp-dot" data-lane="person" aria-hidden />Work a person starts</span>
        <span><i className="lp-dot" data-lane="line" aria-hidden />Work the line starts</span>
      </div>
    </section>
  );
}

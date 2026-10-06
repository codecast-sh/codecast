// The surface wall (docs/architecture/evals-ui.md section 4.1): one glance to
// see whether any prompt surface is getting worse, and where. One full-width
// row per surface on a shared time axis of up to 30 days, rows that separated worse
// sorted first with a magenta edge, "What moved" beside it, and the spend,
// open bisects and the host's own blocks (codecast: the latest Multiplayer sim
// session, through the host's wall slot) at the foot. Open bisects and the
// attribute key show only where the product runs them (GET /health's
// capabilities); a row's route, model and staleness only when it has them.
//
// Props only: HomePage reads GET /overview and hands the answer in. The keys
// (j, k, Enter, b) live here so the mount test can drive them; they answer
// only while `active` (the page is the active pane).

import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DAY_MS, EVALS_STALL_MS, attributeHref, baselineWords, capitalized, bisectStatusWord, cadenceItems, dayStart, endpointLabel, isBisectLive, isBisectStalled, isWorse, linear, noiseFlipWords, noiseFlipsShort, pLabel, plural, rowHref, separationTitle, shortModel, shortSha, usd, wallAxisTicks, wallOrder, wallSpend, wallWindowDays, wallWindowFrom } from "../../client";
import { flipCounts, type BatchStats, type BisectSummary, type OverviewResponse, type SurfaceOverview } from "../../contract";
import { useCaseNoun, useEvalsCapabilities, useEvalsHost, useEvalsPaths } from "../hooks";
import { EvalsLink, KeyHint, SeparationMark, VerdictGlyph } from "../shell/parts";
import { StallChip } from "../shell/StallChip";
import { ScoreStrip } from "./ScoreStrip";
import { WhatMoved } from "./WhatMoved";

const SEPARATION_SHORT = { better: "better", worse: "worse", "not-separated": "not separated", "too-few": "too few reps" } as const;

// ── One row ─────────────────────────────────────────────────────────────────

/** Codecast's staleness words, each with its glyph; a product's other words show as the word alone. */
const STALE_WORDS: Record<string, string> = {
  fresh: "ran on its sources",
  stale: "its sources changed at HEAD since it last ran",
  waiting: "stale, but its sources have uncommitted edits",
  due: "check --stale would run it now",
  blocked: "crashed twice on these sources",
};

function Staleness({ word }: { word: string }) {
  return (
    <span className="ev-wall-stale" data-ev-stale={word} title={STALE_WORDS[word] ? `${word}: ${STALE_WORDS[word]}` : word}>
      <svg width={9} height={9} viewBox="-5 -5 10 10" aria-hidden>
        {word === "fresh" && <circle r={3} fill="currentColor" />}
        {word === "stale" && (
          <>
            <path d="M0,-3 A3,3 0 0 0 0,3 Z" fill="currentColor" />
            <circle r={3} fill="none" stroke="currentColor" strokeWidth={1.1} />
          </>
        )}
        {word === "waiting" && <circle r={3} fill="none" stroke="currentColor" strokeWidth={1.1} />}
        {word === "due" && <path d="M-3.2,0 H3.2 M0,-3.2 V3.2" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />}
        {word === "blocked" && <path d="M-3,-3 L3,3 M3,-3 L-3,3" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />}
      </svg>
      {word}
    </span>
  );
}

function StripTip({ b }: { b: BatchStats }) {
  const { format } = useEvalsHost();
  return (
    <div className="ev-wall-tip">
      <div>
        <b>{format.fullTimestamp(Date.parse(b.batchAt))}</b>
        <span className="ev-wall-tip-dim"> {b.cadence ?? "by hand"}</span>
      </div>
      <div className="ev-wall-tip-mono">{b.batch}</div>
      <div>
        median <b>{b.median === null ? "n/a" : b.median.toFixed(2)}</b>, {b.passed} of {b.reps} passed{b.crashes ? `, ${b.crashes} crashed` : ""}, {usd(b.costUsd + b.judgeCostUsd)}
      </div>
      {b.gitHeads.length > 0 && (
        <div className="ev-wall-tip-mono">
          {b.gitHeads.slice(0, 3).map((h) => shortSha(h)).join(" ")}
          {b.gitHeads.length > 3 ? ` +${b.gitHeads.length - 3}` : ""}
          {/* `reps` leaves crashes out and dirtyReps counts every rep, so the dirty count names its own total. */}
          {b.dirtyReps > 0 ? `, ${b.dirtyReps} of ${b.reps + b.crashes} reps dirty` : ""}
        </div>
      )}
    </div>
  );
}

const stripTip = (b: BatchStats): ReactNode => <StripTip b={b} />;

/** What codecast's two routes mean, for the route chip's title. */
const ROUTE_WORDS: Record<string, string> = { agent: "An agent surface: a headless session with tools", call: "A call surface: one model call" };

interface RowProps {
  s: SurfaceOverview;
  index: number;
  selected: boolean;
  from: number;
  to: number;
  stripWidth: number;
  cursor: number | null;
  onCursor: (at: number | null) => void;
  onOpen: (href: string) => void;
  onSelect: (id: string) => void;
}

function WallRow({ s, index, selected, from, to, stripWidth, cursor, onCursor, onOpen, onSelect }: RowProps) {
  const { href: hrefs } = useEvalsPaths();
  const { models } = useEvalsCapabilities();
  const set = s.latest?.set ?? null;
  const rate = set?.passRate ?? null;
  const worse = isWorse(s);
  // A flip on a freeze that flaps, or under the same rendered prompt, says nothing about a change: it is shown, not counted.
  const { broke, fixed, noise } = flipCounts(s.latest?.flips ?? []);
  const sep = s.latest?.separation ?? null;
  const noun = useCaseNoun();
  const baseWords = baselineWords(s.latest?.baseline ?? null, { stats: s.strip, noun });
  const sepTitle = s.latest ? separationTitle(s.latest, { stats: s.strip, noun }) : undefined;
  // A strip click picks a batch; the row click under it must not also open the surface.
  const picked = useRef(false);
  return (
    <div
      role="row"
      className="ev-wall-row"
      data-ev-wall-row={s.id}
      data-ev-worse={worse || undefined}
      aria-selected={selected}
      style={{ "--ev-delay": `${index * 30}ms` } as CSSProperties}
      onMouseEnter={() => onSelect(s.id)}
      onClick={(e) => {
        if (picked.current || (e.target as Element).closest("a")) {
          picked.current = false;
          return;
        }
        onOpen(rowHref(hrefs, s));
      }}
    >
      <div role="cell" className="ev-wall-name">
        <div className="ev-wall-name-line">
          {s.landing && <span className="ev-wall-landing ev-pulse" title="A batch is still landing reps" data-ev-landing />}
          <EvalsLink href={rowHref(hrefs, s)} className="ev-wall-id" title={s.title}>
            {s.id}
          </EvalsLink>
          {s.route && (
            <span className="ev-chip ev-wall-route" title={ROUTE_WORDS[s.route] ?? `Runs on the ${s.route} route`}>
              {s.route}
            </span>
          )}
        </div>
        <div className="ev-wall-model">
          {s.model && <span title={`Pinned model ${s.model}; ${s.freezes.public} public and ${s.freezes.private} private freezes`}>{shortModel(s.model)}</span>}
          {s.staleness && <Staleness word={s.staleness} />}
        </div>
      </div>
      <div role="cell" className="ev-wall-strip">
        {s.strip.length ? (
          <ScoreStrip
            strip={s.strip}
            dots={s.dots}
            epochs={s.epochs}
            footing={s.footing}
            passMark={s.passMark}
            from={from}
            to={to}
            width={stripWidth}
            height={54}
            emphasis={worse && s.latest ? { batch: s.latest.set.batch, baseline: s.latest.baseline?.batches ?? [] } : null}
            cursor={cursor}
            onCursor={onCursor}
            onPick={(batch) => {
              picked.current = true;
              onOpen(hrefs.surface(s.id, { batch }));
            }}
            tip={stripTip}
            delayMs={index * 30}
            label={`${s.id}: batch median scores over ${plural(wallWindowDays(from, to), "day")}`}
          />
        ) : (
          <span className="ev-wall-nobatch">No batch in this window.</span>
        )}
      </div>
      <div role="cell" className="ev-wall-rate">
        <span className="ev-wall-rate-num" data-ev-rate>
          {rate === null ? "n/a" : Math.round(rate * 100)}
          {rate !== null && <span className="ev-wall-rate-pct">%</span>}
        </span>
        <span className="ev-wall-sub" title="Reps passed in the newest batch">{set ? `${set.passed} of ${set.reps} reps` : "none graded"}</span>
      </div>
      <div role="cell" className="ev-wall-verdict">
        <span className="ev-wall-verdict-line" title={sepTitle}>
          <SeparationMark result={sep} />
          <span className={worse ? "ev-fail" : sep?.kind === "better" ? "ev-pass" : undefined}>{SEPARATION_SHORT[sep?.kind ?? "too-few"]}</span>
          {sep && "p" in sep && <span className="ev-wall-p">p {pLabel(sep.p)}</span>}
        </span>
        <span className="ev-wall-sub">
          <span title={baseWords?.long}>{baseWords ? baseWords.short : s.latest?.dry ? "dry render" : "no baseline"}</span>
          {(broke > 0 || fixed > 0) && (
            <span title={`${capitalized(noun.many)} whose majority verdict changed against the baseline`}>
              {", "}
              {broke > 0 && <span className="ev-fail">{broke} broke</span>}
              {broke > 0 && fixed > 0 && ", "}
              {fixed > 0 && <span className="ev-pass">{fixed} fixed</span>}
            </span>
          )}
          {noise.length > 0 && (
            <span className="ev-quiet" title={noise.map(noiseFlipWords).join("\n")} data-ev-noise-flips={noise.length}>
              {", "}
              {noiseFlipsShort(noise)}
            </span>
          )}
        </span>
      </div>
      <div role="cell" className="ev-wall-spend" title={`${models ? "Model and judge spend" : "Spend"} over the wall's ${plural(wallWindowDays(from, to), "day")}`}>
        {usd(wallSpend(s.spendByDay, from, to).usd)}
      </div>
    </div>
  );
}

// ── The foot: spend per day, open bisects, then the host's own blocks ───────

function SpendStrip({ days, from, to, width }: { days: OverviewResponse["spendByDay"]; from: number; to: number; width: number }) {
  const { HoverTip } = useEvalsHost().ui;
  // A product whose rows name no model or judge records one spend, not the two halves.
  const { models } = useEvalsCapabilities();
  const [hover, setHover] = useState<{ x: number; y: number; d: OverviewResponse["spendByDay"][number] } | null>(null);
  const h = 34;
  const w = Math.max(width, 40);
  const x = linear(from, to, 2, w - 2);
  const max = Math.max(0.01, ...days.map((d) => d.usd + d.judgeUsd));
  const y = linear(0, max, h - 1, 3);
  const bar = Math.max(2, (x(from + DAY_MS) - x(from)) * 0.62);
  return (
    <>
      <svg className="ev-strip" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={models ? "Spend per day, model and judge" : "Spend per day"} data-ev-spend-strip>
        <line x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} className="ev-strip-mark" />
        {days.map((d) => {
          const cx = x(dayStart(d.day) + DAY_MS / 2);
          // A day that began before the window keeps only the part inside the strip.
          const left = Math.max(0, cx - bar / 2);
          const span = Math.min(w, cx + bar / 2) - left;
          if (span <= 0) return null;
          const top = y(d.usd + d.judgeUsd);
          const mid = y(d.usd);
          return (
            <g
              key={d.day}
              onMouseMove={(e) => setHover({ x: e.clientX, y: (e.currentTarget.ownerSVGElement?.getBoundingClientRect().top ?? e.clientY) - 4, d })}
              onMouseLeave={() => setHover(null)}
            >
              <rect x={left - 1} y={0} width={span + 2} height={h} fill="transparent" />
              <rect x={left} y={mid} width={span} height={h - 1 - mid} rx={1} className="ev-wall-spend-model" />
              <rect x={left} y={top} width={span} height={Math.max(0, mid - top)} rx={1} className="ev-wall-spend-judge" />
            </g>
          );
        })}
      </svg>
      {hover && (
        <HoverTip x={hover.x} y={hover.y}>
          <span>
            {hover.d.day}: {models ? `model ${usd(hover.d.usd)}, judge ${usd(hover.d.judgeUsd)}` : usd(hover.d.usd + hover.d.judgeUsd)}
          </span>
        </HoverTip>
      )}
    </>
  );
}

function BisectRibbon({ b, now }: { b: BisectSummary; now: number }) {
  const { format } = useEvalsHost();
  const { href: evalsHref } = useEvalsPaths();
  const share = b.budgetUsd > 0 ? Math.min(1, b.spentUsd / b.budgetUsd) : 0;
  const stalled = isBisectStalled(b, now, EVALS_STALL_MS);
  return (
    <EvalsLink href={evalsHref.bisect(b.id)} className="ev-wall-ribbon" data-ev-bisect-ribbon={b.id}>
      <span className="ev-wall-ribbon-head">
        <span className={`ev-wall-landing ${stalled ? "" : "ev-pulse"}`} aria-hidden />
        <span className="ev-mono">{b.surface}</span>
        <span className="ev-quiet">{bisectStatusWord(b.status)}</span>
        {stalled && (
          <StallChip since={b.updatedAt} data-ev-bisect-stalled />
        )}
        <span className="ev-grow" />
        <span className="ev-quiet ev-tabular">{format.relativeTime(Date.parse(b.startedAt), now).replace(" ago", "")}</span>
      </span>
      <span className="ev-wall-ribbon-range ev-mono">
        {endpointLabel(b.good)} to {endpointLabel(b.bad)}
      </span>
      <span className="ev-wall-ribbon-budget" title={`${usd(b.spentUsd)} of a ${usd(b.budgetUsd)} budget`}>
        <span className="ev-wall-ribbon-track">
          <span className="ev-wall-ribbon-fill" style={{ width: `${share * 100}%` }} />
        </span>
        <span className="ev-tabular">
          {usd(b.spentUsd)} of {usd(b.budgetUsd)}
        </span>
      </span>
    </EvalsLink>
  );
}


/** The bisects still running, a ribbon each, with a link to every bisect. */
function OpenBisects({ bisects, now }: { bisects: BisectSummary[]; now: number }) {
  const { href: evalsHref } = useEvalsPaths();
  return (
    <div className="ev-wall-foot-block">
      <h2 className="ev-title">
        <svg width={12} height={12} viewBox="-7 -7 14 14" aria-hidden className={bisects.length ? "ev-ruler" : "ev-quiet"}>
          <path d="M-5,-5 H-2.5 M-5,-5 V5 H-2.5 M5,-5 H2.5 M5,-5 V5 H2.5" fill="none" stroke="currentColor" strokeWidth={1.4} />
        </svg>
        Open bisects
        <EvalsLink href={evalsHref.bisectList()} className="ev-wall-more">
          all bisects
        </EvalsLink>
      </h2>
      {bisects.length ? (
        <div className="ev-wall-ribbons">
          {bisects.map((b) => (
            <BisectRibbon key={b.id} b={b} now={now} />
          ))}
        </div>
      ) : (
        <div className="ev-wall-foot-empty">No bisect is running.</div>
      )}
    </div>
  );
}


/** `M` is the host's own What moved kinds (codecast: sim failures), drawn through its wall slot. */
export interface SurfaceWallViewProps<M extends { at: string } = never> {
  data: OverviewResponse<M>;
  /** The wall's clock: the window (up to 30 days) ends here. */
  now: number;
  cadence: string;
  onCadence: (cadence: string) => void;
  /** Navigate within the area (HomePage pushes the router). */
  onOpen: (href: string) => void;
  /** The keys answer only while the page is the active pane. */
  active: boolean;
}

export function SurfaceWallView<M extends { at: string } = never>({ data, now, cadence, onCadence, onOpen, active }: SurfaceWallViewProps<M>) {
  const host = useEvalsHost();
  const { href: evalsHref } = useEvalsPaths();
  const can = useEvalsCapabilities();
  const { EmptyState, SegmentedToggle } = host.ui;
  const Foot = host.wall?.Foot;
  const cadences = cadenceItems("All", host.cadences);
  const rows = useMemo(() => wallOrder(data.surfaces), [data.surfaces]);
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const { ref: axisRef, width: stripWidth } = host.useContainerWidth(560);
  const to = now;
  const from = useMemo(() => wallWindowFrom(data, now), [data, now]);
  const ticks = useMemo(() => wallAxisTicks(from, to, stripWidth), [from, to, stripWidth]);

  const worse = rows.filter(isWorse).length;
  const landing = rows.filter((s) => s.landing).length;
  const openBisects = data.bisects.filter((b) => isBisectLive(b.status));
  const spend = useMemo(() => wallSpend(data.spendByDay, from, to), [data.spendByDay, from, to]);
  const windowWords = plural(spend.days, "day");

  // ── Keys: j/k walk the rows, Enter opens one, b attributes the newest worse pair.
  const index = selected ? rows.findIndex((s) => s.id === selected) : -1;
  const move = useCallback(
    (d: number) => {
      if (!rows.length) return false;
      const next = index < 0 ? (d > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + d));
      setSelected(rows[next].id);
      document.querySelector(`[data-ev-wall-row="${CSS.escape(rows[next].id)}"]`)?.scrollIntoView?.({ block: "nearest" });
      return true;
    },
    [rows, index],
  );
  host.useShortcuts(
    {
      "list.down": { keys: "j", label: "Move down", run: () => move(1) },
      "list.up": { keys: "k", label: "Move up", run: () => move(-1) },
      "list.open": {
        keys: "Enter",
        label: "Open the surface",
        run: () => {
          if (index < 0) return false;
          onOpen(rowHref(evalsHref, rows[index]));
          return true;
        },
      },
      ...(can.attribution && {
        "evals.attribute": {
          keys: "b",
          label: "Attribute the newest worse pair",
          run: () => {
            onOpen(attributeHref(evalsHref, rows, selected));
            return true;
          },
        },
      }),
    },
    active,
  );

  return (
    <div className="ev-page ev-wall-page" data-evals-wall>
      <div className="ev-wall-layout">
        <section className="ev-wall-main" aria-label="Surfaces">
          <header className="ev-wall-head">
            <h1 className="ev-page-title">
              <VerdictGlyph state={worse ? "fail" : "pass"} title={worse ? `${worse} ${worse === 1 ? "surface" : "surfaces"} separated worse` : "Nothing separated worse"} />
              Surfaces
            </h1>
            <span className="ev-wall-summary ev-tabular">
              {rows.length} surfaces
              {worse > 0 && <span className="ev-fail">, {worse} separated worse</span>}
              {landing > 0 && <>, {landing} landing</>}
              , {usd(spend.usd)} in {windowWords}
            </span>
            <span className="ev-grow" />
            <span className="ev-wall-keys" aria-label="Keys">
              <span>
                <KeyHint action="list.down" keys="j" /> <KeyHint action="list.up" keys="k" /> move
              </span>
              <span>
                <KeyHint action="list.open" keys="Enter" /> open
              </span>
              {can.attribution && (
                <span>
                  <KeyHint action="evals.attribute" keys="b" /> attribute
                </span>
              )}
            </span>
            {cadences.length > 0 && <SegmentedToggle value={cadence} onChange={onCadence} items={cadences.map((c) => ({ key: c.key, label: c.label, title: c.key === "named" ? "Batches run by hand, outside any cadence" : undefined }))} />}
          </header>

          {rows.length === 0 ? (
            <EmptyState title="No surface has a run yet" description={host.words.emptyWall} />
          ) : (
            <div role="table" className="ev-wall-table" aria-label={`Every surface over the last ${windowWords}`} onMouseLeave={() => setCursor(null)}>
              <div role="row" className="ev-wall-row ev-wall-row--head">
                <div role="columnheader">Surface</div>
                <div role="columnheader" className="ev-wall-axis" ref={axisRef} title="Each step is one batch's median score; the dots are its reps, the hairline the 0.7 pass mark">
                  <span className="ev-wall-axis-what">median score per batch</span>
                  {ticks.map((t) => (
                    <span key={t.label} style={{ left: t.x }}>
                      {t.label}
                    </span>
                  ))}
                  {(ticks.length === 0 || ticks[ticks.length - 1].x < stripWidth - 70) && <span className="ev-wall-axis-now">today</span>}
                </div>
                <div role="columnheader" title="Reps passed in the newest batch">Latest batch</div>
                <div role="columnheader">Against baseline</div>
                <div role="columnheader" className="ev-wall-spend-head">
                  {windowWords}
                </div>
              </div>
              {rows.map((s, i) => (
                <WallRow key={s.id} s={s} index={i} selected={s.id === selected} from={from} to={to} stripWidth={stripWidth} cursor={cursor} onCursor={setCursor} onOpen={onOpen} onSelect={setSelected} />
              ))}
              <div role="row" className="ev-wall-row ev-wall-row--spend">
                <div role="cell" className="ev-wall-name">
                  <div className="ev-wall-foot-label">Spend per day</div>
                  {can.models && (
                    <div className="ev-wall-model">
                      <span className="ev-wall-key ev-wall-key--model" /> model <span className="ev-wall-key ev-wall-key--judge" /> judge
                    </div>
                  )}
                </div>
                <div role="cell" className="ev-wall-strip">
                  <SpendStrip days={data.spendByDay} from={from} to={to} width={stripWidth} />
                </div>
                <div role="cell" className="ev-wall-rate">
                  <span className="ev-wall-sub">{windowWords}</span>
                  <span className="ev-tabular">{usd(spend.usd)}</span>
                </div>
              </div>
            </div>
          )}

          {(can.bisect || Foot) && (
            <footer className="ev-wall-foot">
              {can.bisect && <OpenBisects bisects={openBisects} now={now} />}
              {Foot && (
                <div className="ev-host">
                  <Foot overview={data} now={now} />
                </div>
              )}
            </footer>
          )}
        </section>

        <WhatMoved events={data.moved} now={now} />
      </div>
    </div>
  );
}

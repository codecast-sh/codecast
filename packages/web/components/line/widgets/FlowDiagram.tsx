"use client";
// A flow drawn for reading at a glance (docs/architecture/flows.md FL6): the
// passing path left to right, each segment a frame holding its own steps, and
// a run's state on every step. Where a stage sends work back to the session
// the change came from, the path opens on that Session and a rail runs back
// to it under the steps that return there, each return a short chip on the
// rail. A branch that ends the run is an end of its own, shaped like the
// flow's end; a loop to another station names that station. The model is
// lib/line/flowDiagram.ts; this only draws it.
import { createContext, memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { flowDiagram, routeTail, runReached, SESSION_WORDS, stepStates, type DiagramStep, type FlowDiagramModel, type SideRoute, type StepMark, type StepState } from "../../../lib/line/flowDiagram";
import type { ShippedFlow } from "../../../lib/line/flowPool";
import { WHO } from "../../../lib/line/flowWho";

type RunLike = Parameters<typeof stepStates>[1];
/** Picking a step: the card opens what that station does under the drawing. */
export type StepPick = { id: string; kind: DiagramStep["kind"] };
type Pick = { picked: string | null; onPick?: (pick: StepPick) => void };

/** The smallest the drawing shrinks to fit its column; narrower than that, it scrolls. */
const FIT_FLOOR = 0.6;

/** Scales the path down (CSS zoom) so the whole flow, through its end, fits the column it sits in. A callback ref, so
 *  the observer follows the element React mounts; a DOM write on resize, no render. */
function useFitPath(content: unknown) {
  const stop = useRef<(() => void) | null>(null);
  const refit = useRef<(() => void) | null>(null);
  // What it draws changed in the same frame (another flow, a run's states): fit again before paint.
  useLayoutEffect(() => { refit.current?.(); }, [content]);
  return useCallback((box: HTMLDivElement | null) => {
    stop.current?.();
    stop.current = null;
    refit.current = null;
    const path = box?.querySelector<HTMLDivElement>(".fd-rows");
    if (!box || !path || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      // Measured at full size, and without the min-width that stretches it across a wide column.
      // and unwrapped, or a wrapped path would measure narrow and unwrap again.
      const was = path.style.zoom;
      const wrapped = box.hasAttribute("data-wrap");
      box.removeAttribute("data-wrap");
      path.style.zoom = "";
      path.style.minWidth = "0";
      const natural = path.scrollWidth;
      path.style.minWidth = "";
      path.style.zoom = was;
      if (wrapped) box.setAttribute("data-wrap", "");
      const cs = getComputedStyle(box);
      const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
      // Too long to fit even at the floor: the path wraps at full size instead, and its rail gives way to words.
      const wrap = natural * FIT_FLOOR > room;
      if (box.hasAttribute("data-wrap") !== wrap) box.toggleAttribute("data-wrap", wrap);
      const k = wrap ? 1 : natural > room ? Math.max(FIT_FLOOR, room / natural) : 1;
      const next = k === 1 ? "" : k.toFixed(3);
      if (path.style.zoom !== next) path.style.zoom = next;
    };
    fit();
    refit.current = fit;
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    ro.observe(path);
    stop.current = () => { ro.disconnect(); refit.current = null; };
  }, []);
}

const STATE_MARK: Record<StepState, string> = { idle: "", done: "✓", current: "", stopped: "✕" };

/** `marks`: what a pipeline says on each step beside its name (who changed it, when it runs, what stands on it now), by step id.
 *  `diagram`: the flow's model as the host already shaped it (a pipeline lane says a shared route once), else the flow's own. */
/** `quietRoutes`: the passing path leads; each step's other ways fold into one "N other ways" that opens on hover or press
 *  (a pipeline, where the path is what a person reads), and a fan-out always shows its branches by name. */
/** `onAdd`: the arrow before each passing-path step is a "+" that proposes a station there, after the step before it
 *  (null: before the first step). */
export const FlowDiagram = memo(function FlowDiagram({ flow, run = null, compact = false, picked = null, onPick, marks, diagram, quietRoutes = false, onAdd }: { flow: ShippedFlow; run?: RunLike; compact?: boolean; marks?: Readonly<Record<string, StepMark>>; diagram?: FlowDiagramModel; quietRoutes?: boolean; onAdd?: (afterId: string | null) => void } & Partial<Pick>) {
  const model = useMemo(() => diagram ?? flowDiagram(flow), [diagram, flow]);
  const states = useMemo(() => stepStates(model, run), [model, run]);
  const pick: Pick = { picked, onPick };
  // A segment of several steps, or several running side by side, draws folded: one box with the routes that leave it;
  // pressing it opens its frame.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => setOpened((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const folded = (st: DiagramStep) => (st.kind === "segment" || (st.kind === "parallel" && !quietRoutes)) && st.inner.length > 1 && !opened.has(st.id);
  const fit = useFitPath(`${model.steps.length}|${flow.slug}|${compact}|${run ? "run" : ""}|${states.size}|${[...opened].join(",")}`);
  // Where the ways back lead: the session the change came from (a Session cell opens the path), or, in a flow run
  // around one step, that step on the path (its stages run on a row of their own, the rail under them back to it).
  const railTo = model.hub?.label ?? SESSION_WORDS;
  const hubAt = model.hub ? model.steps.findIndex((st) => st.id === model.hub!.id) : -1;
  const lastReturn = compact ? -1 : model.steps.reduce((at, st, i) => (i > hubAt && returnsTo(st, railTo) ? i : at), -1);
  const rail = (i: number) => (lastReturn < 0 ? undefined : i === hubAt ? "start" : i < hubAt ? undefined : i < lastReturn ? "through" : i === lastReturn ? "end" : undefined);
  const cell = (s: DiagramStep, i: number, lead: boolean) => (
    <li key={s.id} className="fd-cell" data-rail={rail(i)} data-drop={lastReturn >= 0 && i > hubAt && (folded(s) ? returnsTo(s, railTo) : dropsToRail(s, railTo)) ? "" : undefined} data-hub={i === hubAt ? "" : undefined}>
      <div className="fd-cell-main">
        {lead ? (onAdd && !compact
          ? <button type="button" className="fd-arrow fd-add" aria-label={`Add a station before ${s.label}`} title={`Add a station before ${s.label}`} onClick={() => onAdd(model.steps[i - 1]?.id ?? null)} data-fd-add={s.id}><span aria-hidden>+</span></button>
          : <span className="fd-arrow" aria-hidden />) : null}
        {folded(s) ? <Step step={{ ...s, side: foldedRoutes(s) }} state={states.get(s.id) ?? "idle"} compact={compact} run={run} pick={pick} fold={{ count: s.inner.length, words: s.kind === "parallel" ? "at once" : "steps", toggle: () => toggle(s.id) }} />
          : s.kind === "parallel" ? <Segment step={s} states={states} compact={compact} run={run} pick={pick} parallel onFold={quietRoutes ? undefined : () => toggle(s.id)} />
          : s.kind === "segment" && s.inner.length > 1 ? <Segment step={s} states={states} compact={compact} run={run} pick={pick} onFold={() => toggle(s.id)} />
          : s.kind === "segment" && s.inner.length === 1 ? <Step step={{ ...s.inner[0], label: s.label, side: [...s.inner[0].side, ...s.side], slot: s.slot }} markId={s.id} state={states.get(s.inner[0].id) ?? "idle"} compact={compact} run={run} pick={pick} />
          : <Step step={s} state={states.get(s.id) ?? "idle"} compact={compact} run={run} pick={pick} />}
      </div>
      {rail(i) ? <span className="fd-rail" aria-hidden /> : null}
    </li>
  );
  const end = model.end ? (
    <li className="fd-cell">
      <div className="fd-cell-main">
        {onAdd && !compact && model.steps.length
          ? <button type="button" className="fd-arrow fd-add" aria-label={`Add a station before ${model.end}`} title={`Add a station before ${model.end}`} onClick={() => onAdd(model.steps[model.steps.length - 1].id)} data-fd-add="end"><span aria-hidden>+</span></button>
          : <span className="fd-arrow" aria-hidden />}
        <span className="fd-end" data-reached={runReached(run, model.endId) ? "" : undefined} title={run ? undefined : "Where the flow ends when every step passes"}>{model.end}</span>
      </div>
    </li>
  ) : null;
  // A flow run around one step reads in two rows: the way in, then that step and its stages to the end.
  const split = hubAt > 0 && !compact;
  return (
    <Marks.Provider value={marks ?? null}>
    <QuietRoutes.Provider value={quietRoutes}>
    <RailTo.Provider value={railTo}>
    <div ref={fit} className="fd" data-quiet={quietRoutes ? "" : undefined} data-compact={compact ? "" : undefined} data-has-run={run ? "" : undefined} data-pickable={onPick ? "" : undefined} data-returns={lastReturn >= 0 ? "" : undefined} data-rows={split ? "2" : undefined}>
      <div className="fd-rows">
        {split ? <ol className="fd-path" data-row="in">{model.steps.slice(0, hubAt).map((s, i) => cell(s, i, i > 0))}<li className="fd-cell" aria-hidden><div className="fd-cell-main"><span className="fd-arrow fd-arrow-down" /></div></li></ol> : null}
        <ol className="fd-path">
          {lastReturn >= 0 && !model.hub ? (
            <li className="fd-cell" data-rail="start">
              <div className="fd-cell-main"><span className="fd-session" title="The session the change came from: what a stage finds goes back to it">Session</span></div>
              <span className="fd-rail" aria-hidden />
            </li>
          ) : null}
          {model.steps.map((s, i) => (split && i < hubAt ? null : cell(s, i, split ? i > hubAt : i > 0 || (lastReturn >= 0 && !model.hub))))}
          {end}
        </ol>
      </div>
    </div>
    </RailTo.Provider>
    </QuietRoutes.Provider>
    </Marks.Provider>
  );
});

/** A segment's steps in a row inside its frame; a fan-out's branches stacked, since they run side by side. */
function Segment({ step, states, compact, run, pick, parallel = false, onFold }: { step: DiagramStep; states: Map<string, StepState>; compact: boolean; run: RunLike; pick: Pick; parallel?: boolean; onFold?: () => void }) {
  const state = states.get(step.id) ?? "idle";
  const mark = useContext(Marks)?.[step.id];
  const quiet = useContext(QuietRoutes);
  // Quiet (a pipeline), the stacked branches say they run side by side; the frame keeps only its name.
  const name = <>{step.label}{parallel && !quiet ? <span className="fd-seg-par"> · {step.inner.length} side by side</span> : null}{written(step) ? <span className="fd-seg-tag">written here</span> : null}</>;
  return (
    <div className="fd-seg" data-own={mark?.own ?? undefined} data-proposed={mark?.proposed ? "" : undefined} data-skipped={mark?.skipped ? "" : undefined} data-state={state} data-parallel={parallel ? "" : undefined} data-written={written(step) ? "" : undefined} data-picked={pick.picked === step.id ? "" : undefined} title={slotTitle(step)}>
      {pick.onPick
        ? <button type="button" className="fd-seg-name" aria-pressed={pick.picked === step.id} onClick={() => pick.onPick!({ id: step.id, kind: step.kind })} data-fd-pick={step.id}>{name}</button>
        : <div className="fd-seg-name">{name}</div>}
      {/* Open, the frame's steps show their own counts; the frame counts only what stands on none of them. */}
      {mark ? <MarkRow mark={{ ...mark, here: (mark.here ?? 0) - (mark.hereInside ?? 0) }} /> : null}
      {onFold ? <button type="button" className="fd-seg-fold" onClick={onFold} aria-label={`Fold ${step.label}`} title={`Fold ${step.label} into one step`} data-fd-fold={step.id}>−</button> : null}
      <div className="fd-seg-steps">
        {step.inner.map((s, i) => (
          <div key={s.id} className="fd-seg-cell">
            {i > 0 && !parallel ? <span className="fd-arrow fd-arrow-in" aria-hidden /> : null}
            <Step step={s} state={states.get(s.id) ?? "idle"} compact={compact} run={run} pick={pick} />
          </div>
        ))}
      </div>
      {!compact && step.side.length ? <Routes routes={step.side} run={run} /> : null}
    </div>
  );
}

/** `fold`: this box is a folded segment: it says how many steps it holds, and pressing it opens them. */
function Step({ step, state, compact, run, pick, fold, markId }: { step: DiagramStep; state: StepState; compact: boolean; run: RunLike; pick: Pick; fold?: { count: number; words: string; toggle: () => void }; markId?: string }) {
  const mark = useContext(Marks)?.[markId ?? step.id];
  const body = (
    <>
      <Who kind={step.kind} />
      <span className="fd-step-name">{step.label}</span>
      {fold ? <span className="fd-fold-n">{fold.count} {fold.words}</span> : null}
      {step.slot?.filled === "empty" ? <span className="fd-seg-tag">slot</span> : written(step) ? <span className="fd-seg-tag">written here</span> : null}
      {state !== "idle" ? <span className="fd-dot" aria-label={state}>{STATE_MARK[state]}</span> : null}
    </>
  );
  const attrs = { className: "fd-step", "data-kind": step.kind, "data-own": mark?.own ?? undefined, "data-passes": mark?.passes ? "" : undefined, "data-proposed": mark?.proposed ? "" : undefined, "data-skipped": mark?.skipped ? "" : undefined, "data-state": state, "data-folded": fold ? "" : undefined, "data-slot": step.slot?.filled === "empty" ? "" : undefined, "data-written": written(step) ? "" : undefined, title: slotTitle(step) ?? `${step.label}: ${WHO[step.kind].word}` };
  return (
    <div className="fd-step-wrap">
      {fold
        ? <button type="button" {...attrs} aria-expanded={false} title={`${step.label}: ${fold.count} ${fold.words}; press to open`} onClick={() => { fold.toggle(); pick.onPick?.({ id: step.id, kind: step.kind }); }} data-fd-open={step.id}>{body}</button>
        : pick.onPick
        ? <button type="button" {...attrs} aria-pressed={pick.picked === step.id} data-picked={pick.picked === step.id ? "" : undefined} onClick={() => pick.onPick!({ id: step.id, kind: step.kind })} data-fd-pick={step.id}>{body}</button>
        : <div {...attrs}>{body}</div>}
      {mark ? <MarkRow mark={mark} compact={compact} onOpen={pick.onPick ? () => pick.onPick!({ id: step.id, kind: step.kind }) : undefined} /> : null}
      {!compact && step.side.length ? <Routes routes={step.side} run={run} /> : null}
    </div>
  );
}

/** Steps the flow wrote in place for one of its segments (a backbone's slot it filled). */
const written = (step: DiagramStep) => step.slot?.filled === "generated";
/** A slot says what it must do, on hover. */
const slotTitle = (step: DiagramStep) => (step.slot?.does ? `${step.label}: ${step.slot.does}` : undefined);

function Who({ kind }: { kind: DiagramStep["kind"] }) {
  const { icon: Icon } = WHO[kind];
  return <Icon className="fd-who" aria-hidden strokeWidth={2} />;
}

/** A folded segment's routes: those of the steps inside it and its own, less a loop between its own steps, which a
 *  reader sees when it opens. */
function foldedRoutes(seg: DiagramStep): SideRoute[] {
  const inside = new Set(seg.inner.map((x) => x.label));
  const all = [...seg.inner.flatMap((x) => x.side), ...seg.side].filter((r) => !(r.tone === "back" && r.leadsTo && inside.has(r.leadsTo)));
  const seen = new Set<string>();
  return all.filter((r) => { const k = `${r.tone}|${r.leadsTo}|${r.outcome}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Whether a step, or a step inside it, sends work back to the session. */
const ridesRail = (r: SideRoute, railTo: string) => r.leadsTo === railTo && (railTo === SESSION_WORDS || r.tone === "back");
const returnsTo = (step: DiagramStep, railTo: string): boolean => step.side.some((r) => ridesRail(r, railTo)) || step.inner.some((x) => returnsTo(x, railTo));
/** A step drawn as one box that returns to the session drops its line to the rail; a frame's own steps sit inside it. */
const dropsToRail = (step: DiagramStep, railTo: string) =>
  step.kind === "parallel" || (step.kind === "segment" && step.inner.length > 1) ? step.side.some((r) => ridesRail(r, railTo)) : returnsTo(step, railTo);

/** Whether each step's other ways fold into one quiet line (FlowDiagram `quietRoutes`). */
const QuietRoutes = createContext(false);

/** A pipeline's marks by step id; null for a plain flow. */
const Marks = createContext<Readonly<Record<string, StepMark>> | null>(null);

const OWN_WORD: Record<NonNullable<StepMark["own"]>, string> = { added: "added", changed: "changed" };

/** What a pipeline says under a step: how many changes stand on it now, the project's own mark, when it runs, that it passes. */
function MarkRow({ mark, compact = false, onOpen }: { mark: StepMark; compact?: boolean; onOpen?: () => void }) {
  const own = mark.own ? <span className="fd-mark" data-mark="own" title={mark.changed?.join(", ") || undefined}>{OWN_WORD[mark.own]}</span> : null;
  // The count opens the station, where its changes are listed by name.
  const here = mark.here ? (onOpen
    ? <button type="button" className="fd-mark" data-mark="here" title={mark.hereNames?.join("\n") || undefined} onClick={onOpen}>{mark.here} here</button>
    : <span className="fd-mark" data-mark="here" title={mark.hereNames?.join("\n") || undefined}>{mark.here} here</span>) : null;
  const proposed = mark.proposed ? <span className="fd-mark" data-mark="proposed" title={mark.proposed}>{mark.skipped ? "skip " : ""}{mark.proposed}</span> : null;
  if (compact) return here || own || proposed ? <div className="fd-marks">{here}{proposed ?? own}</div> : null;
  if (!own && !here && !proposed && !mark.when && !mark.passes && !mark.varies && !mark.waits) return null;
  return (
    <div className="fd-marks">
      {proposed}
      {here}
      {proposed ? null : own}
      {mark.when ? <span className="fd-mark" data-mark="when" title={`Runs only when a change touches ${mark.when}`}>{mark.when}</span> : null}
      {mark.passes ? <span className="fd-caption">no command</span> : null}
      {mark.varies ? <span className="fd-mark">varies by target</span> : null}
      {mark.waits ? <span className="fd-mark" data-mark="waits">waits for the deploy</span> : null}
    </div>
  );
}

/** Where the drawing's ways back lead (the session, or the step a flow runs around): the routes that ride the rail. */
const RailTo = createContext<string>(SESSION_WORDS);

/**
 * Routes off the path, each drawn as what it is: a way back rides the rail (its outcome on the chip); a branch that
 * ends the run is an end, shaped like the flow's own; a route to another station names that station whole, its outcome
 * the part that gives way when the chip is narrow. In a definition every route shows; on a run only the route the run
 * took, red only where it stopped.
 */
function Routes({ routes, run }: { routes: SideRoute[]; run: RunLike }) {
  const quiet = useContext(QuietRoutes);
  const railTo = useContext(RailTo);
  const shown = run ? routes.filter((r) => runReached(run, r.toId)) : routes;
  if (!shown.length) return null;
  // The path leads: a step's other ways fold into one quiet line that opens a list over the page. A way back to the
  // session stays drawn, so the loop reads even where the rail wraps away.
  if (quiet && !run) {
    const rail = shown.filter((r) => ridesRail(r, railTo));
    const rest = shown.filter((r) => !ridesRail(r, railTo));
    return (
      <>
        {rail.length ? <RouteList routes={rail} run={run} /> : null}
        {rest.length ? <OtherWays routes={rest} /> : null}
      </>
    );
  }
  return <RouteList routes={shown} run={run} />;
}

/** A step's other ways, one quiet button that opens them over the page (never clipped by the lane), each in words: what
 *  happens, then where it goes. Esc or a press elsewhere closes it; it follows its button when the page scrolls. */
function OtherWays({ routes }: { routes: SideRoute[] }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  useWatchEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const onDown = (e: PointerEvent) => { const t = e.target as Node; if (!list.current?.contains(t) && !button.current?.contains(t)) close(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    // A scroll carries the list with its button; it closes once the button leaves the window.
    const follow = () => {
      const r = button.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) return close();
      const next = { left: Math.min(r.left, window.innerWidth - 300), top: r.bottom + 4 };
      setAt((cur) => (cur && cur.top === next.top && cur.left === next.left ? cur : next));
    };
    window.addEventListener("scroll", follow, true);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("scroll", follow, true); };
  }, [!!at]);
  const toggle = () => {
    if (at) return setAt(null);
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.min(r.left, window.innerWidth - 300), top: r.bottom + 4 });
  };
  return (
    <>
      <button ref={button} type="button" className="fd-routes-more" aria-expanded={!!at} onClick={toggle}>{routes.length} other {routes.length === 1 ? "way" : "ways"}</button>
      {at && typeof document !== "undefined" ? createPortal(
        <ul ref={list} className="fd-ways lw-widget" style={{ left: at.left, top: at.top }} role="list">
          {routes.map((r, i) => (
            <li key={i} className="fd-way" data-tone={r.tone}>
              <span className="fd-way-what">{r.outcome}</span>
              <span className="fd-way-tail">{routeTail(r)}</span>
            </li>
          ))}
        </ul>,
        document.body,
      ) : null}
    </>
  );
}

function RouteList({ routes: shown, run }: { routes: SideRoute[]; run: RunLike }) {
  const railTo = useContext(RailTo);
  return (
    <ul className="fd-routes">
      {shown.map((r, i) => {
        const form = ridesRail(r, railTo) ? "session" : !r.leadsTo ? "end" : r.tone === "back" ? "back" : "on";
        return (
          <li key={i} className="fd-route" data-form={form} data-tone={r.tone} data-taken={run ? "" : undefined} title={`${r.outcome}: ${routeTail(r)}`}>
            {form === "back" ? <><span className="fd-route-mark" aria-hidden>↺</span><span className="fd-route-to">{r.leadsTo}</span></>
              : form === "on" ? <><span className="fd-route-what">{r.outcome}</span><span className="fd-route-mark" aria-hidden>→</span><span className="fd-route-to">{r.leadsTo}</span></>
              : <>{form === "session" ? <span className="fd-route-mark" aria-hidden>↺</span> : null}<span className="fd-route-what">{r.outcome}</span>
                {/* Wrapped, the rail is gone, so a way back names where it goes. */}
                {form === "session" ? <span className="fd-route-to fd-route-rail">→ {railTo === SESSION_WORDS ? "Session" : railTo}</span> : null}</>}
          </li>
        );
      })}
    </ul>
  );
}

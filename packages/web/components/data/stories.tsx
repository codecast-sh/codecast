// The two story formats a dashboard can be redone in, on the same blocks
// and the same live data:
//
//   Scrollyteller  a big headline and a one-line summary, then each step's
//                  words beside its chart, each revealing as it scrolls in.
//   Visual short   the same steps as a short film: beats laid end to end
//                  (shared shortTimeline), a segmented timeline to scrub,
//                  numbers counting up and charts drawing in as each plays.
import { useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { ArrowDown, Pause, Play, RotateCcw } from "lucide-react";
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import { ChartBody, CheckMark, KpiBody, LiveText, TableBody, TextBody, type BlockEnv } from "./blocks";
import { blockCheck } from "./blockCheck";
import { KeyCap } from "../KeyCap";

type StoryProps = { title: string; layout: dashboard.DashboardLayout; elements: ArtifactElement[]; env: BlockEnv };

/** A block drawn large for a story, with its check in the corner. */
function StoryBlock({ b, env, reveal }: { b: ArtifactElement; env: BlockEnv; reveal: boolean }) {
  const check = blockCheck(b, env);
  return (
    <div className="relative rounded-2xl border border-sol-border/50 bg-sol-card p-5" data-block={b.key}>
      <div className="flex items-start gap-3 mb-3">
        <div className="min-w-0 flex-1">
          {b.title ? <div className="text-[15px] font-semibold text-sol-text">{String(b.title)}</div> : null}
          {b.caption ? <div className="text-meta text-sol-text-muted mt-0.5">{String(b.caption)}</div> : null}
        </div>
        {check ? <CheckMark check={check} onClick={() => env.onCheck?.(b.key)} /> : null}
      </div>
      {b.kind === "chart" ? (reveal ? <ChartBody b={b} env={env} height={340} compact={false} revealMs={1400} annotate /> : <div style={{ height: 340 }} />) : null}
      {b.kind === "table" ? <TableBody b={b} env={env} maxHeight={420} /> : null}
      {b.kind === "text" ? <TextBody b={b} env={env} /> : null}
    </div>
  );
}

function NumbersRow({ keys, env, run, size = "lg" }: { keys: string[]; env: BlockEnv; run: boolean; size?: "lg" | "stage" }) {
  return (
    <div className="story-numbers grid gap-4" data-count={keys.length === 1 ? 1 : keys.length % 3 === 0 ? 3 : 2}>
      {keys.map((k) => {
        const b = env.blocks.get(k);
        if (!b) return null;
        const check = blockCheck(b, env);
        return (
          <div key={k} className="rounded-2xl border border-sol-border/50 bg-sol-card px-5 py-4 min-w-0" data-block={k}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm text-sol-text-muted truncate flex-1">{String(b.title ?? "")}</span>
              {check ? <CheckMark check={check} onClick={() => env.onCheck?.(k)} /> : null}
            </div>
            <KpiBody b={b} env={env} size={size} countUp={run} />
          </div>
        );
      })}
    </div>
  );
}

// ── Scrollyteller ──

/**
 * The words a step reads as. A step an author left wordless still says
 * something true: a KPI with a comparison reads as its live direction
 * ("Agent spend {b_spend.trend}"), so the words can never disagree with the
 * number beside them.
 */
function stepWords(step: dashboard.StoryStep, env: BlockEnv): { title?: string; say?: string } {
  if (step.kind === "hero" || step.kind === "chapter") return {};
  if (step.title || step.say) return { title: step.title, say: step.say };
  if (step.kind === "numbers") {
    const lines = step.keys
      .map((k) => env.blocks.get(k))
      .filter((b): b is ArtifactElement => !!b && !!b.title)
      .map((b) => (b.compare ? `${String(b.title)} {${b.key}.trend}` : `${String(b.title)} {${b.key}}`));
    return { title: lines[0], say: lines.slice(1).join(" · ") || undefined };
  }
  return {};
}

export function ScrollyStory({ title, layout, elements, env }: StoryProps) {
  const steps = useMemo(() => dashboard.storySteps(title, layout, elements), [title, layout, elements]);
  const [hero, ...rest] = steps;
  const [active, setActive] = useState(0);
  // Each step ever shown keeps its visual mounted, so a chart draws in once and stays drawn.
  const [shown, setShown] = useState<Set<number>>(() => new Set([0]));
  const refs = useRef<Array<HTMLElement | null>>([]);
  useWatchEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    // The step crossing the middle band of the pane is the one being read.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = Number((e.target as HTMLElement).dataset.step);
          setActive(i);
          setShown((prev) => (prev.has(i) ? prev : new Set(prev).add(i)));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const el of refs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, [rest.length]);

  // Chapters break the flow full width; the steps between them share one pinned stage.
  const groups: Array<{ chapter?: number; steps: number[] }> = [];
  rest.forEach((s, i) => {
    if (s.kind === "chapter") return void groups.push({ chapter: i, steps: [] });
    const last = groups[groups.length - 1];
    if (last && last.chapter === undefined) last.steps.push(i);
    else groups.push({ steps: [i] });
  });
  // The stage of a group the reader is not in holds its nearest step: the first above it, the last below it.
  const onStage = (g: number[]) => (g.includes(active) ? active : active < g[0] ? g[0] : g[g.length - 1]);

  return (
    <div className="data-story story-pad" data-format="scrolly">
      {hero?.kind === "hero" ? (
        <section className="min-h-[72vh] flex flex-col items-center justify-center text-center max-w-[980px] mx-auto py-16">
          <h1 className="text-[length:clamp(34px,6cqw,68px)] leading-[1.06] font-bold tracking-[-0.03em] text-sol-text text-balance data-story-in" data-block="layout"><LiveText text={hero.headline} env={env} /></h1>
          {hero.summary ? (
            <p className="mt-6 text-[length:clamp(16px,1.9cqw,20px)] leading-relaxed text-sol-text-secondary max-w-[60ch] text-balance data-story-in" style={{ animationDelay: "160ms" }}>
              <LiveText text={hero.summary} env={env} />
            </p>
          ) : null}
          <div className="mt-14 inline-flex items-center gap-1.5 text-meta text-sol-text-dim data-story-in" style={{ animationDelay: "360ms" }}>
            Scroll <ArrowDown className="w-3.5 h-3.5 animate-bounce" />
          </div>
        </section>
      ) : null}
      {groups.map((g, gi) =>
        g.chapter !== undefined ? (
          <section key={`c${gi}`} ref={(el) => void (refs.current[g.chapter!] = el)} data-step={g.chapter} className="min-h-[60vh] flex flex-col items-center justify-center text-center max-w-[900px] mx-auto">
            {(() => {
              const c = rest[g.chapter!] as Extract<dashboard.StoryStep, { kind: "chapter" }>;
              return (
                <>
                  <h2 className={`text-[length:clamp(28px,4.4cqw,48px)] font-bold tracking-[-0.02em] text-sol-text text-balance transition-opacity duration-500 ${active === g.chapter ? "opacity-100" : "opacity-40"}`}>
                    <LiveText text={c.title} env={env} />
                  </h2>
                  {c.say ? <p className="mt-3 text-lg text-sol-text-muted max-w-[56ch] text-balance"><LiveText text={c.say} env={env} /></p> : null}
                </>
              );
            })()}
          </section>
        ) : (
          <div key={`g${gi}`} className="scrolly-group max-w-[1240px] mx-auto">
            <div className="scrolly-stage" aria-live="polite">
              <div className="scrolly-stage-inner">
                {g.steps.map((i) => (
                  <div key={i} className={`scrolly-visual ${onStage(g.steps) === i ? "is-on" : ""}`} aria-hidden={onStage(g.steps) !== i}>
                    {shown.has(i) || i === g.steps[0] ? <StepVisual step={rest[i]} env={env} run={shown.has(i)} /> : null}
                  </div>
                ))}
              </div>
            </div>
            <div className="scrolly-steps">
              {g.steps.map((i) => {
                const w = stepWords(rest[i], env);
                return (
                  <section key={i} ref={(el) => void (refs.current[i] = el)} data-step={i} className="scrolly-step">
                    <div className={`scrolly-card ${active === i ? "is-on" : ""}`}>
                      {w.title ? <h2 className="text-[length:clamp(22px,2.8cqw,32px)] leading-[1.18] font-bold tracking-[-0.02em] text-sol-text text-balance"><LiveText text={w.title} env={env} /></h2> : null}
                      {w.say ? <p className={`${w.title ? "mt-3" : ""} text-[17px] leading-relaxed text-sol-text-secondary`}><LiveText text={w.say} env={env} /></p> : null}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        ),
      )}
      <div className="h-[45vh]" />
    </div>
  );
}

function StepVisual({ step, env, run }: { step: dashboard.StoryStep; env: BlockEnv; run: boolean }) {
  if (step.kind === "numbers") return <NumbersRow keys={step.keys} env={env} run={run} />;
  const b = env.blocks.get(step.keys[0]);
  return b ? <StoryBlock b={b} env={env} reveal={run} /> : null;
}

// ── Visual short ──

export function VisualShort({ title, layout, elements, env }: StoryProps) {
  const steps = useMemo(() => dashboard.storySteps(title, layout, elements), [title, layout, elements]);
  const { beats, duration } = useMemo(() => dashboard.shortTimeline(steps), [steps]);
  const [t, setT] = useState(0);
  // The film starts once every number it shows has its answer, so it never spends a beat on a loading tile.
  const ready = useMemo(() => {
    for (const b of elements) {
      if (b.in_story === false) continue;
      const q = dashboard.blockQuery(b);
      if (!q) continue;
      const r = env.results.get(dashboard.queryKey(q));
      if (!r || (!r.refreshed_at && !r.error)) return false;
    }
    return true;
  }, [elements, env.results]);
  const [playing, setPlaying] = useState(false);
  const started = useRef(false);
  useWatchEffect(() => {
    if (ready && !started.current) {
      started.current = true;
      setPlaying(true);
    }
  }, [ready]);
  // Opening the evidence behind a number pauses the film; so does leaving the tab.
  const benv: BlockEnv = useMemo(() => ({ ...env, onCheck: (k: string) => { setPlaying(false); env.onCheck?.(k); } }), [env]);
  useEventListener("visibilitychange", () => document.hidden && setPlaying(false), document);
  const stage = useRef<HTMLDivElement>(null);
  const clock = useRef({ t: 0, last: 0 });

  useWatchEffect(() => {
    if (!playing) return;
    let raf = 0;
    clock.current.last = performance.now();
    const tick = (now: number) => {
      const next = Math.min(duration, clock.current.t + (now - clock.current.last));
      clock.current = { t: next, last: now };
      setT(next);
      if (next >= duration) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);

  const seek = (ms: number) => {
    clock.current.t = Math.max(0, Math.min(duration, ms));
    setT(clock.current.t);
  };
  const index = dashboard.beatAt(beats, t);
  const beat = beats[index];
  const ended = t >= duration && duration > 0;
  const toggle = () => {
    if (ended) seek(0);
    setPlaying((p) => !p || ended);
  };

  const onKey = (e: React.KeyboardEvent) => {
    // The player owns these keys while focused; the app's own arrow and space shortcuts must not see them.
    if ([" ", "k", "ArrowLeft", "ArrowRight"].includes(e.key)) e.stopPropagation();
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seek(beats[Math.min(beats.length - 1, index + 1)]?.start ?? duration);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      seek(t - (beat?.start ?? 0) > 800 ? beat.start : beats[Math.max(0, index - 1)]?.start ?? 0);
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center px-4 sm:px-8 py-6" data-format="short">
      <div
        ref={stage}
        tabIndex={0}
        onKeyDown={onKey}
        className="data-stage relative w-full max-w-[1080px] aspect-video max-h-[calc(100vh-220px)] rounded-2xl border border-sol-border/50 bg-sol-card overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/50 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.45)]"
        aria-label={`Visual short: ${title}`}
        data-short-stage
      >
        {beat && !ended ? (
          <div key={index} className="absolute inset-0 flex items-center justify-center p-[5%] data-beat-in">
            <Beat step={beat.step} env={benv} />
          </div>
        ) : null}
        {ended ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 data-beat-in">
            <div className="text-[length:clamp(20px,3cqw,32px)] font-bold text-sol-text text-center px-8 text-balance"><LiveText text={beats[0]?.title ?? title} env={env} /></div>
            <button type="button" onClick={toggle} className="inline-flex items-center gap-2 h-9 px-4 rounded-full bg-sol-text text-sol-bg text-sm font-medium">
              <RotateCcw className="w-4 h-4" /> Replay
            </button>
          </div>
        ) : null}
        {/* Half-stage hit areas step backward and forward, like a story viewer. */}
        <button type="button" aria-label="Previous beat" className="absolute left-0 top-0 bottom-0 w-[18%] cursor-w-resize" onClick={() => seek(beats[Math.max(0, index - 1)]?.start ?? 0)} />
        <button type="button" aria-label="Next beat" className="absolute right-0 top-0 bottom-0 w-[18%] cursor-e-resize" onClick={() => seek(beats[index + 1]?.start ?? duration)} />
      </div>

      <div className="w-full max-w-[1080px] mt-3 flex items-center gap-3">
        <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="w-8 h-8 rounded-full inline-flex items-center justify-center bg-sol-bg-alt text-sol-text hover:bg-sol-bg-highlight shrink-0" data-short-play>
          {playing && !ended ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
        </button>
        <div className="flex-1 flex gap-1 min-w-0" role="group" aria-label="Beats">
          {beats.map((b, i) => {
            const fill = t >= b.start + b.duration ? 1 : t <= b.start ? 0 : (t - b.start) / b.duration;
            return (
              <button
                key={i}
                type="button"
                title={b.title}
                aria-label={`Beat ${i + 1} of ${beats.length}${b.title ? `: ${b.title}` : ""}`}
                aria-current={i === index ? "step" : undefined}
                onClick={(e) => {
                  // A keyboard press (detail 0) goes to the beat's start; a pointer seeks to where it landed.
                  if (e.detail === 0) return seek(b.start);
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  seek(b.start + ((e.clientX - r.left) / r.width) * b.duration);
                }}
                className="group relative h-6 min-w-0 flex items-center"
                style={{ flexGrow: b.duration }}
              >
                <span className="relative w-full h-1 rounded-full bg-sol-border/50 overflow-hidden group-hover:h-1.5 transition-[height]">
                  <span className="absolute inset-y-0 left-0 bg-sol-text rounded-full" style={{ width: `${fill * 100}%` }} />
                </span>
              </button>
            );
          })}
        </div>
        <span className="text-meta tabular-nums text-sol-text-dim shrink-0 w-[84px] text-right">
          {fmtTime(t)} / {fmtTime(duration)}
        </span>
      </div>
      <div className="mt-2 text-meta text-sol-text-dim flex items-center gap-3">
        <span className="inline-flex items-center gap-1"><KeyCap>Space</KeyCap> play</span>
        <span className="inline-flex items-center gap-1"><KeyCap>←</KeyCap><KeyCap>→</KeyCap> beat</span>
      </div>
    </div>
  );
}

/** One number as a film beat: the claim, the figure large enough to read across a room, its change and its check. */
function BigNumber({ k, title, say, env }: { k: string; title?: string; say?: string; env: BlockEnv }) {
  const b = env.blocks.get(k);
  if (!b) return null;
  const check = blockCheck(b, env);
  return (
    <div className="w-full max-w-[86%] flex flex-col items-center text-center" data-block={k}>
      {title ? <h2 className="text-[length:clamp(16px,2.4cqw,28px)] font-bold tracking-[-0.02em] text-sol-text-secondary text-balance">{title}</h2> : null}
      <div className="mt-[3%] flex items-center gap-3">
        <span className="text-sol-text-muted text-[length:clamp(12px,1.4cqw,15px)]">{String(b.title ?? "")}</span>
        {check ? <CheckMark check={check} onClick={() => env.onCheck?.(k)} /> : null}
      </div>
      <div className="data-big-number w-full flex flex-col items-center">
        <KpiBody b={b} env={env} size="xl" countUp />
      </div>
      {say ? <p className="mt-[3%] text-[length:clamp(12px,1.5cqw,17px)] text-sol-text-secondary text-balance data-beat-in" style={{ animationDelay: "700ms" }}><LiveText text={say} env={env} /></p> : null}
    </div>
  );
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Beat({ step, env }: { step: dashboard.StoryStep; env: BlockEnv }) {
  if (step.kind === "hero") {
    return (
      <div className="text-center max-w-[86%]">
        <h1 data-block="layout" className="text-[length:clamp(26px,4.6cqw,56px)] leading-[1.06] font-bold tracking-[-0.03em] text-sol-text text-balance"><LiveText text={step.headline} env={env} /></h1>
        {step.summary ? (
          <p className="mt-5 text-[length:clamp(13px,1.6cqw,18px)] leading-relaxed text-sol-text-secondary text-balance data-beat-in" style={{ animationDelay: "500ms" }}>
            <LiveText text={step.summary} env={env} />
          </p>
        ) : null}
      </div>
    );
  }
  if (step.kind === "chapter") {
    return (
      <div className="text-center max-w-[86%]">
        <h2 className="text-[length:clamp(24px,4cqw,46px)] font-bold tracking-[-0.02em] text-sol-text"><LiveText text={step.title} env={env} /></h2>
        {step.say ? <p className="mt-3 text-[length:clamp(12px,1.6cqw,18px)] text-sol-text-secondary"><LiveText text={step.say} env={env} /></p> : null}
      </div>
    );
  }
  // A beat its author left wordless still says something true about its numbers.
  const w = stepWords(step, env);
  if (step.kind === "numbers") {
    if (step.keys.length === 1) return <BigNumber k={step.keys[0]} title={w.title} say={w.say} env={env} />;
    return (
      <div className="w-full">
        {w.title ? <h2 className="mb-5 text-[length:clamp(18px,2.6cqw,30px)] font-bold tracking-[-0.02em] text-sol-text text-center"><LiveText text={w.title} env={env} /></h2> : null}
        <NumbersRow keys={step.keys} env={env} run size="stage" />
        {w.say ? <p className="mt-4 text-center text-[length:clamp(12px,1.4cqw,16px)] text-sol-text-secondary"><LiveText text={w.say} env={env} /></p> : null}
      </div>
    );
  }
  const b = env.blocks.get(step.keys[0]);
  if (!b) return null;
  const check = blockCheck(b, env);
  return (
    <div className="w-full h-full flex flex-col" data-block={b.key}>
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
        <h2 className="text-[length:clamp(16px,2.4cqw,28px)] font-bold tracking-[-0.02em] text-sol-text"><LiveText text={step.title ?? String(b.title ?? "")} env={env} /></h2>
        {step.say ? <p className="mt-1 text-[length:clamp(12px,1.4cqw,16px)] text-sol-text-secondary"><LiveText text={step.say} env={env} /></p> : null}
        </div>
        {check ? <span className="relative z-10"><CheckMark check={check} onClick={() => env.onCheck?.(b.key)} /></span> : null}
      </div>
      <div className="flex-1 min-h-0">
        {b.kind === "chart" ? <ChartBody b={b} env={env} height="100%" compact={false} revealMs={1600} annotate /> : b.kind === "table" ? <TableBody b={b} env={env} maxHeight={320} /> : <TextBody b={b} env={env} />}
      </div>
    </div>
  );
}

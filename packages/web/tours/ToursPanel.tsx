"use client";
// The Tours panel: every tour, by area, with what it teaches and whether this
// person has seen it. Opened from the account menu, the command palette, the
// shortcuts panel, and the inbox's triage bar. Picking a row starts the tour
// (the layer goes to its page first).
import { useRef } from "react";
import { Check, Compass, X } from "lucide-react";
import { useTrackedStore } from "../store/inboxStore";
import { useEventListener } from "../hooks/useEventListener";
import { useMountEffect } from "../hooks/useMountEffect";
import { startTour } from "./engine";
import { TOURS } from "./registry";
import { tourOutcome } from "./seen";
import { TOUR_AREAS } from "./types";

export function ToursPanel() {
  const s = useTrackedStore([
    (st) => st.toursPanelOpen,
    (st) => st.clientState.tips?.completed?.length ?? 0,
    (st) => st.clientState.tips?.dismissed?.length ?? 0,
    (st) => st.clientState.tips?.level,
    (st) => st.clientState.ui?.org_nux_seen,
  ]);
  if (!s.toursPanelOpen) return null;
  return <Panel />;
}

function Panel() {
  const s = useTrackedStore([
    (st) => st.clientState.tips?.completed?.length ?? 0,
    (st) => st.clientState.tips?.dismissed?.length ?? 0,
    (st) => st.clientState.tips?.level,
  ]);
  const close = () => s.setToursPanelOpen(false);
  const box = useRef<HTMLDivElement | null>(null);
  useMountEffect(() => { box.current?.focus({ preventScroll: true }); });
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  }, undefined, { capture: true });
  const off = s.clientState.tips?.level === "none";
  const state = s.clientState;

  return (
    <div className="fixed inset-0 z-[10040] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Tours" data-tours-panel>
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px] animate-in fade-in-0 duration-200" onMouseDown={close} />
      <div ref={box} tabIndex={-1} className="relative w-full max-w-[560px] max-h-[86vh] flex flex-col rounded-2xl border outline-none overflow-hidden animate-in fade-in-0 zoom-in-95 duration-200" style={{ background: "var(--sol-bg)", borderColor: "color-mix(in srgb, var(--sol-border) 60%, transparent)", boxShadow: "0 30px 80px -30px rgba(0,0,0,0.6)" }}>
        <div className="px-6 pt-5 pb-3 flex items-start gap-3">
          <div className="min-w-0">
            <h2 className="text-[22px] leading-tight font-semibold tracking-tight flex items-center gap-2" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>
              <Compass className="w-5 h-5" style={{ color: "var(--sol-violet)" }} strokeWidth={1.75} /> Tours
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed max-w-[46ch]" style={{ color: "var(--sol-text-muted)" }}>
              Short walks through one feature each, on the real page. {off ? "Tips are off in Settings, so none starts on its own." : "A new one starts on its own the first time you meet its feature, once."}
            </p>
          </div>
          <button type="button" onClick={close} aria-label="Close" className="ml-auto -mr-2 -mt-1 w-7 h-7 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-alt" style={{ color: "var(--sol-text-dim)" }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4">
          {TOUR_AREAS.map((area) => {
            const tours = TOURS.filter((t) => t.area === area.area);
            if (!tours.length) return null;
            return (
              <section key={area.area} className="px-3 pt-3" data-tours-area={area.area}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="w-[7px] h-[7px] rounded-full" style={{ background: area.accent }} />
                  <h3 className="text-[11.5px] font-medium" style={{ color: "var(--sol-text-dim)" }}>{area.label}</h3>
                </div>
                <div className="flex flex-col gap-1">
                  {tours.map((t) => {
                    const outcome = tourOutcome(t, state);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => startTour(t.id, { replay: true })}
                        className="group text-left w-full rounded-xl border px-3.5 py-2.5 transition-colors hover:bg-sol-bg-alt"
                        style={{ borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }}
                        data-tour-row={t.id}
                        data-tour-seen={outcome ?? "new"}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[13.5px] font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{t.title}</span>
                          {outcome === "finished" && <span className="inline-flex items-center gap-1 text-[10.5px]" style={{ color: "var(--sol-green)" }}><Check className="w-3 h-3" /> seen</span>}
                          {outcome === "skipped" && <span className="text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>skipped</span>}
                          {!outcome && <span className="text-[10.5px] px-1.5 h-[16px] inline-flex items-center rounded-md" style={{ background: `color-mix(in srgb, ${area.accent} 16%, transparent)`, color: area.accent }}>new</span>}
                          <span className="ml-auto text-[11.5px] opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: area.accent }}>{outcome ? "Replay" : "Start"} →</span>
                        </div>
                        <p className="mt-0.5 text-[12px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>{t.teaches}</p>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

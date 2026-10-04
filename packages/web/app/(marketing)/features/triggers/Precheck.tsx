"use client";

import { useState } from "react";
import { SOL } from "../../blog/blogChrome";
import { Body, C, Nb, Section, Shell } from "./ui";

/** One illustrative day of an hourly trigger: main moved at these hours. */
const MOVED = new Set([10, 14, 17]);
const SLOTS = Array.from({ length: 14 }, (_, i) => 7 + i);

function Slot({ h, open, onHover }: { h: number; open: boolean; onHover: (h: number | null) => void }) {
  const ran = MOVED.has(h);
  return (
    <button
      type="button"
      onMouseEnter={() => onHover(h)}
      onFocus={() => onHover(h)}
      onMouseLeave={() => onHover(null)}
      onBlur={() => onHover(null)}
      aria-label={`${String(h).padStart(2, "0")}:00, precheck exited ${ran ? 0 : 1}${ran ? ", a session ran" : ", skipped"}`}
      className="group flex flex-col items-center gap-1.5 outline-none"
    >
      <span className="font-mono text-[10px]" style={{ color: SOL.base1 }}>{String(h).padStart(2, "0")}</span>
      <span
        className="flex h-9 w-9 items-center justify-center rounded-lg font-mono text-[13px] font-bold transition-transform group-hover:-translate-y-0.5"
        style={ran
          ? { backgroundColor: SOL.green, color: SOL.base3 }
          : { border: `1.5px dashed ${SOL.base1}`, color: SOL.base1, backgroundColor: open ? SOL.base2 : "transparent" }}
      >
        {ran ? 0 : 1}
      </span>
      <span className="h-6 w-px" style={{ backgroundColor: ran ? SOL.green : "transparent" }} />
      <span
        className="h-3 w-3 rounded-full"
        style={ran ? { backgroundColor: SOL.base03, boxShadow: `0 0 0 3px color-mix(in srgb, ${SOL.green} 30%, transparent)` } : { backgroundColor: "transparent" }}
      />
    </button>
  );
}

export function Precheck() {
  const [hover, setHover] = useState<number | null>(null);
  const ran = SLOTS.filter((h) => MOVED.has(h)).length;
  const detail = hover === null
    ? `${SLOTS.length} firings · ${SLOTS.length - ran} skipped · ${ran} sessions`
    : MOVED.has(hover)
      ? `${String(hover).padStart(2, "0")}:00 · exit 0 · main moved, a session ran`
      : `${String(hover).padStart(2, "0")}:00 · exit 1 · skipped, no session spent`;
  return (
    <Section
      id="precheck"
      title="A gate that costs nothing when the answer is no"
      lede={<>Most repeating jobs ask a question whose usual answer is no. Has main moved? Is the queue empty? Without a gate, a whole agent run is spent finding out. <C>--precheck</C> asks with a shell command first.</>}
    >
      <div className="rounded-2xl p-5 sm:p-6" style={{ backgroundColor: "#fffbf0", border: `1px solid ${SOL.base2}` }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[12px]">
          <span className="font-semibold" style={{ color: SOL.base03 }}>tr-44 · every 1h · one day</span>
          <span aria-live="polite" style={{ color: hover !== null && MOVED.has(hover) ? SOL.green : SOL.base01 }}>{detail}</span>
        </div>
        <div className="mt-5 grid grid-cols-7 gap-y-4 sm:grid-cols-[repeat(14,minmax(0,1fr))]">
          {SLOTS.map((h) => <Slot key={h} h={h} open={hover === h} onHover={setHover} />)}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]" style={{ color: SOL.base01 }}>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded" style={{ border: `1.5px dashed ${SOL.base1}` }} /> exit 1: skip recorded</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded" style={{ backgroundColor: SOL.green }} /> exit 0: the trigger runs</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: SOL.base03 }} /> an agent session</span>
        </div>
      </div>
      <div className="mt-10 grid gap-x-10 gap-y-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Shell
            lines={[`cast trigger add "Review what landed on main" --every 1h --spawn \\\n  --precheck 'test "$(git rev-parse origin/main)" != "$(cat .last-reviewed)"'`]}
          />
          <Body>
            The command runs in the project directory before each scheduled or repeating firing. Exit 0 runs the trigger. Any other exit, or 60 seconds without an answer, records a skipped run and re-arms on the normal cadence. A skip is not a failure, so it never uses up a retry.
          </Body>
        </div>
        <div className="space-y-4">
          <Shell
            lines={["cast trigger log tr-44"]}
            out={
              <span>
                Precheck: <span style={{ color: SOL.base01 }}><Nb text={'test "$(git rev-parse origin/main)" != "$(cat .last-reviewed)"'} /></span>{"\n"}
                <span style={{ color: SOL.yellow }}>skipped</span> 12m ago — precheck exited 1{"\n"}
              </span>
            }
          />
          <Body>
            Event triggers ignore the gate, since the event is already the reason to run, and so does <C>cast trigger run</C>. The <C>/cast-loop</C> skill uses this to drain a task queue: its precheck fails when <C>cast task ready</C> comes back empty, so an idle loop spends nothing.
          </Body>
        </div>
      </div>
    </Section>
  );
}

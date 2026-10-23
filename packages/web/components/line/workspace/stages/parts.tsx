"use client";
// Pieces every stage page draws the same way: its head with its figures, a
// per-day strip, a version chip, a gap (what is not backed yet), and the way
// back from an object open inside the stage.
import { type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { DAY } from "../../../../lib/line/flowStages";

export type Figure = { label: string; n: ReactNode; tone?: "live" | "warn" | "bad" | "you" | "dim" };

export function StageHead({ title, sub, figures, children }: { title: ReactNode; sub?: ReactNode; figures: Figure[]; children?: ReactNode }) {
  return (
    <header className="sd-head">
      <h2 className="sd-title">{title}</h2>
      {sub && <p className="sd-sub">{sub}</p>}
      <dl className="sd-figs">
        {figures.map((f) => (
          <div key={f.label} data-tone={f.tone}><dt>{f.label}</dt><dd className="lw-num">{f.n}</dd></div>
        ))}
      </dl>
      {children}
    </header>
  );
}

/** Counts per day, oldest first, today last; each bar says its day and count on hover, an empty day drawn as a floor. */
export function DayStrip({ days, now, label }: { days: readonly number[]; now: number; label: string }) {
  const max = Math.max(1, ...days);
  return (
    <div className="sd-days" role="img" aria-label={`${label} per day, last ${days.length} days: ${days.join(", ")}`} data-line-days={days.join(",")}>
      {days.map((n, i) => {
        const at = now - (days.length - 1 - i) * DAY;
        const day = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return <i key={i} data-zero={n ? undefined : ""} style={{ height: n ? `${Math.max(8, (n / max) * 100)}%` : undefined }} data-tip={`${day}: ${n.toLocaleString("en-US")} ${label}`} title={`${day}: ${n.toLocaleString("en-US")} ${label}`} />;
      })}
      <span className="sd-days-ends"><span>{new Date(now - (days.length - 1) * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span><span>today</span></span>
    </div>
  );
}

export function Version({ v, current }: { v: string | null; current?: boolean }) {
  if (!v) return null;
  return <span className="sd-ver" data-current={current ? "" : undefined} title={current ? `${v}: published now` : v}>{/^\d+$/.test(v) ? `v${v}` : v.slice(0, 7)}</span>;
}

/** Something this stage would show or let a person do whose backend does not exist yet: its state, and no act. */
export function Gap({ what, why }: { what: string; why: string }) {
  return <div className="sd-gap" data-line-stage-gap={what}><b>{what}</b><span>{why}</span></div>;
}

export function Back({ label, onBack, href }: { label: string; onBack: () => void; href: string }) {
  return (
    <a className="sd-back" href={href} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); onBack(); }} data-line-stage-back>
      <ChevronLeft className="w-3.5 h-3.5" aria-hidden />{label}
    </a>
  );
}

export function Section({ title, n, children, aside }: { title: ReactNode; n?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="sd-sec">
      <h3 className="sd-h">{title}{n != null && <span className="lw-num sd-h-n">{n}</span>}{aside && <span className="sd-h-aside">{aside}</span>}</h3>
      {children}
    </section>
  );
}

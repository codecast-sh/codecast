// The few shapes every Ops screen is built from, so the screens agree:
// a section is a heading and its content on the page (no box around it),
// a stat line is numbers side by side with small labels over them, the
// hero is the one number a page is about, and a surface is the single
// level of raised card a screen may use. Nothing nests a box in a box.
import type { CSSProperties, ReactNode } from "react";
import "./opsLayout.css";

export function OpsSection({ title, meta, action, children, id, className }: {
  title: ReactNode;
  /** A short dim note beside the title: a window, a count. */
  meta?: ReactNode;
  /** One control at the right of the heading. */
  action?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section className={`osx-sec${className ? ` ${className}` : ""}`} id={id}>
      <h2 className="osx-sec-head">
        <span className="osx-sec-title">{title}</span>
        {meta !== undefined && <span className="osx-sec-meta">{meta}</span>}
        {action && <span className="osx-sec-act">{action}</span>}
      </h2>
      {children}
    </section>
  );
}

export type Tone = "bad" | "good" | "warn" | "flat" | undefined;

export type StatItem = {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
  /** A second line under the value. */
  sub?: ReactNode;
  title?: string;
  key?: string;
};

export function StatLine({ items, size = "md", className }: { items: readonly StatItem[]; size?: "md" | "lg"; className?: string }) {
  return (
    <div className={`osx-stats${className ? ` ${className}` : ""}`} data-size={size}>
      {items.map((s, i) => (
        <div key={s.key ?? i} className="osx-stat" title={s.title}>
          <span className="osx-stat-label">{s.label}</span>
          <b className="osx-stat-value" data-tone={s.tone}>{s.value}</b>
          {s.sub !== undefined && <span className="osx-stat-sub">{s.sub}</span>}
        </div>
      ))}
    </div>
  );
}

/** The one number a page is about, with its state beside it and the stat line it leads. */
export function OpsHero({ value, state, stats, aside }: { value: ReactNode; state?: ReactNode; stats?: readonly StatItem[]; aside?: ReactNode }) {
  return (
    <div className="osx-hero">
      <div className="osx-hero-main">
        <b className="osx-hero-value">{value}</b>
        {state}
      </div>
      {stats && stats.length > 0 && <StatLine items={stats} />}
      {aside && <div className="osx-hero-aside">{aside}</div>}
    </div>
  );
}

/** A state as a colored dot and word: OK, Alerting, Muted. */
export function StateMark({ ink, children, title }: { ink: string; children: ReactNode; title?: string }) {
  return <span className="osx-state" style={{ ["--ink" as string]: ink } as CSSProperties} title={title}><i aria-hidden />{children}</span>;
}

/** The one raised level a screen may use: a card on the page, never inside another. */
export function Surface({ children, className, pad = true, as: Tag = "div", ...rest }: { children: ReactNode; className?: string; pad?: boolean; as?: "div" | "section" } & Record<`data-${string}`, string | undefined>) {
  return <Tag className={`osx-surface${className ? ` ${className}` : ""}`} data-pad={pad ? "" : undefined} {...rest}>{children}</Tag>;
}

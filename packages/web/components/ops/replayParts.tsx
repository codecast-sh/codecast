// Small pieces the replay list and the replay page share: a person's mark,
// a recording's activity strip, and its counts as glanceable figures.
import { AlertTriangle, Monitor, MousePointerClick, Repeat2, Smartphone, Tablet, WifiOff } from "lucide-react";
import { SHAPE_CELLS, type ReplayFacts, type ReplayShape } from "@codecast/shared/replay";
import type { OpsReplay } from "./opsTypes";
import { compactCount, osName, replayFigures, shortBrowser, type ReplayFigureKind } from "./replayModel";

const ACCENTS = ["blue", "violet", "cyan", "magenta", "green", "orange", "yellow"] as const;

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** A person's mark: initials on a tint picked by who they are, so one person reads the same on every row. */
export function PersonMark({ label, personKey, anonymous, size = 24 }: { label: string; personKey: string | null; anonymous: boolean; size?: number }) {
  const accent = ACCENTS[hashOf(personKey ?? label) % ACCENTS.length];
  const letters = anonymous ? "?" : label.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  return (
    <span
      className="rp-mark"
      aria-hidden
      data-anon={anonymous ? "true" : undefined}
      style={{ width: size, height: size, fontSize: size * 0.42, color: `var(--sol-${accent})`, background: `color-mix(in srgb, var(--sol-${accent}) ${anonymous ? 8 : 16}%, transparent)` }}
    >
      {letters}
    </span>
  );
}

/**
 * A recording's activity over its length: one bar per slice, its height how
 * much the person did, with a red tick where something failed. Drawn from the
 * row's shape, so the list paints it without reading the recording.
 */
export function ReplayStrip({ shape, width = 132, height = 18 }: { shape: ReplayShape | null | undefined; width?: number; height?: number }) {
  if (!shape) return <span className="rp-strip rp-strip-none" style={{ width, height }} aria-hidden />;
  const n = shape.strip.length || SHAPE_CELLS;
  const w = width / n;
  return (
    <svg className="rp-strip" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <rect x={0} y={height - 1} width={width} height={1} style={{ fill: "color-mix(in srgb, var(--sol-text-muted) 25%, transparent)" }} />
      {shape.strip.split("").map((c, i) => {
        const level = Number(c);
        if (!level) return null;
        const h = Math.max(2, (level / 9) * (height - 3));
        return <rect key={i} x={i * w + 0.5} y={height - 1 - h} width={Math.max(1, w - 1)} height={h} rx={0.5} style={{ fill: "color-mix(in srgb, var(--sol-text-muted) 70%, transparent)" }} />;
      })}
      {shape.marks.map((m) => (
        <rect key={`m${m}`} x={Math.min(width - 2, (m / 1000) * width)} y={0} width={2} height={height} style={{ fill: "var(--sol-red)" }} />
      ))}
    </svg>
  );
}

/** Clicks, errors, failed requests and rage clicks as icon and number; a zero is left out, except clicks (replayFigures). */
/** `compact`: a list cell, where a count over 999 reads 1.1k (the tooltip keeps the exact number); the list sizes its column to the widest row (figuresWidthPx). */
export function ReplayFigures({ replay: r, compact = false }: { replay: Pick<OpsReplay, "counts" | "shape" | "facts">; compact?: boolean }) {
  const n = (v: number) => (compact ? compactCount(v) : v.toLocaleString());
  return (
    <span className="rp-figs ops-num">
      {replayFigures(r).map((f) => {
        const { Icon, color, word } = FIGURE[f.kind];
        return (
          <span key={f.kind} className={color ? undefined : "ops-quiet"} style={color ? { color } : undefined} title={`${f.n.toLocaleString()} ${word}${f.n === 1 ? "" : "s"}`}>
            <Icon className="w-3 h-3" aria-hidden />{n(f.n)}
          </span>
        );
      })}
    </span>
  );
}

const FIGURE: Record<ReplayFigureKind, { Icon: typeof MousePointerClick; color: string | null; word: string }> = {
  clicks: { Icon: MousePointerClick, color: null, word: "click" },
  errors: { Icon: AlertTriangle, color: "var(--sol-red)", word: "error" },
  failed: { Icon: WifiOff, color: "var(--sol-orange)", word: "failed request" },
  rage: { Icon: Repeat2, color: "var(--sol-magenta)", word: "rage click" },
};

const DEVICE_ICON = { Mobile: Smartphone, Tablet, Desktop: Monitor } as const;

/**
 * Where a recording ran, as the vendor saw it: the device as an icon, then
 * browser, OS and country. Nothing when the vendor said nothing. `pick` makes
 * each part a filter (the list); without it they are plain.
 */
export function EnvMarks({ facts, pick, full }: { facts: ReplayFacts | null | undefined; pick?: (key: "browser" | "os" | "device" | "country", value: string) => void; full?: boolean }) {
  if (!facts || !(facts.browser || facts.os || facts.country || facts.device)) return null;
  const Icon = facts.device ? DEVICE_ICON[facts.device as keyof typeof DEVICE_ICON] ?? Monitor : null;
  const part = (key: "browser" | "os" | "country", value: string | undefined, text?: string) => {
    if (!value) return null;
    const label = text ?? value;
    return pick ? (
      <button key={key} type="button" className="rp-env-part" data-env={key} title={`Only ${label}`} onClick={(e) => { e.stopPropagation(); pick(key, value); }}>{label}</button>
    ) : (
      <span key={key} className="rp-env-part" data-env={key}>{label}</span>
    );
  };
  return (
    <span className="rp-env" title={[facts.device, facts.browser, facts.os && osName(facts.os), facts.country, facts.referrer && `from ${facts.referrer}`].filter(Boolean).join(" · ")}>
      {Icon && <Icon className="w-3 h-3" aria-label={facts.device} />}
      {part("browser", facts.browser, facts.browser && !full ? shortBrowser(facts.browser) : undefined)}
      {part("os", facts.os, facts.os ? osName(facts.os) : undefined)}
      {part("country", facts.country)}
      {full && facts.referrer && <span className="rp-env-part ops-dim" data-env="referrer">from {facts.referrer}</span>}
    </span>
  );
}

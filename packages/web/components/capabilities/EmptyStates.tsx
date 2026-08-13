"use client";

import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCheck,
  CircleDashed,
  Loader2,
  PackageSearch,
  Radio,
  SearchX,
  ServerOff,
} from "lucide-react";

/**
 * The absence vocabulary for /capabilities.
 *
 * A machine that has never sent an inventory is NOT a machine with nothing
 * installed. Telling those two apart is the whole reason this page exists: the
 * signal it sells is "your laptop is missing the skill you use every day", and
 * that claim is only true when we know what the laptop actually has. So every
 * state below names which of the two it is, and a silent daemon can never be
 * rendered as a clean machine.
 *
 * Three axes, kept separate on purpose:
 *   loading — we asked, no answer yet
 *   empty   — we have an answer and it is genuinely nothing
 *   unknown — nobody ever answered for this machine
 * plus `error`, which is a failure to ask.
 */

type Tone = "neutral" | "warn" | "error";

const TONE: Record<Tone, { icon: string; rule: string }> = {
  // Full-opacity var tokens only, or color-mix. A `/NN` opacity modifier on a
  // var-backed sol token emits no CSS at all (tailwind.config.ts has no
  // <alpha-value> placeholder on them), which is why the accents below are the
  // fixed-hex sol colors and the neutral rule uses color-mix.
  neutral: {
    icon: "text-sol-text-dim",
    rule: "border-[color-mix(in_srgb,var(--sol-border)_70%,transparent)]",
  },
  warn: { icon: "text-sol-yellow", rule: "border-sol-yellow/30" },
  error: { icon: "text-sol-red", rule: "border-sol-red/30" },
};

/** The one panel every empty/loading/error state on this surface renders into,
 *  so they cannot drift apart visually as states get added. */
export function SurfaceNotice({
  icon,
  title,
  tone = "neutral",
  children,
  action,
  compact,
}: {
  icon: ReactNode;
  title: ReactNode;
  tone?: Tone;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  const t = TONE[tone];
  return (
    <div
      className={`flex flex-col items-center justify-center text-center rounded-lg border border-dashed ${t.rule} bg-[color-mix(in_srgb,var(--sol-bg-alt)_55%,transparent)] ${
        compact ? "px-4 py-6 gap-2" : "px-6 py-12 gap-3"
      }`}
    >
      <div className={t.icon}>{icon}</div>
      <div className="text-sm text-sol-text font-medium">{title}</div>
      {children && (
        <div className="text-xs text-sol-text-muted max-w-md leading-relaxed">{children}</div>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Inline code, matching the `cast install` styling the settings pages use. */
export function Cmd({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[11px] px-1 py-[1px] rounded bg-sol-bg-inset text-sol-text">
      {children}
    </code>
  );
}

/** No device has ever heartbeated for this account. */
export function NoDevices() {
  return (
    <SurfaceNotice icon={<ServerOff className="w-6 h-6" />} title="No machines yet">
      Run <Cmd>cast daemon</Cmd> on a machine and it starts reporting what it has
      installed. The comparison needs at least one; it gets interesting at two.
    </SurfaceNotice>
  );
}

/** Devices exist, but none of them has sent an inventory. */
export function NothingReportedYet({ deviceCount }: { deviceCount: number }) {
  return (
    <SurfaceNotice icon={<Radio className="w-6 h-6" />} title="Nothing reported yet" tone="warn">
      {deviceCount === 1 ? "Your machine is" : `All ${deviceCount} machines are`} known to
      codecast but {deviceCount === 1 ? "has" : "have"} not sent an inventory. That is not the
      same as having nothing installed — it means the CLI on{" "}
      {deviceCount === 1 ? "it" : "them"} predates capability reporting. Update with{" "}
      <Cmd>cast update</Cmd>.
    </SurfaceNotice>
  );
}

/**
 * Every machine answered, and the answer was nothing.
 *
 * The opposite of the state above and easy to confuse with it, which is why they
 * are two components: one blames a daemon that has never spoken, the other
 * reports a bare machine truthfully. Getting them the wrong way round tells a
 * user to update a CLI that is already current.
 */
export function NothingInstalled({ deviceCount }: { deviceCount: number }) {
  return (
    <SurfaceNotice icon={<PackageSearch className="w-6 h-6" />} title="Nothing installed yet">
      {deviceCount === 1 ? "Your machine reports" : `All ${deviceCount} machines report`} a clean
      Claude Code: no skills, commands, subagents, plugins or MCP servers. Add one on any machine
      and it shows up here on the next report.
    </SurfaceNotice>
  );
}

/** One column's worth of "we do not know", used inside the matrix. */
export function DeviceNotReported({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-sol-yellow">
      <CircleDashed className="w-3 h-3" />
      <span className="truncate">not reported yet</span>
      <span className="sr-only">{name}</span>
    </span>
  );
}

/** We asked and are waiting. Shaped like the matrix so the layout does not jump. */
export function LoadingMatrix({ rows = 6, cols = 3 }: { rows?: number; cols?: number }) {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading fleet inventory">
      <div className="flex items-center gap-2 mb-3">
        <div className="h-3 w-40 rounded bg-sol-bg-highlight" />
        <div className="flex-1" />
        {Array.from({ length: cols }, (_, i) => (
          <div key={i} className="h-3 w-16 rounded bg-sol-bg-highlight" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-2 py-2 border-t border-sol-border">
          <div
            className="h-3 rounded bg-sol-bg-highlight"
            style={{ width: `${120 + ((r * 37) % 90)}px` }}
          />
          <div className="flex-1" />
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="h-3 w-16 rounded bg-sol-bg-highlight" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function LoadingCards({ count = 6 }: { count?: number }) {
  return (
    <div
      className="grid gap-3 animate-pulse [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]"
      aria-busy="true"
      aria-label="Loading catalog"
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border border-sol-border bg-sol-card p-4 space-y-2.5">
          <div className="h-3 w-32 rounded bg-sol-bg-highlight" />
          <div className="h-2.5 w-full rounded bg-sol-bg-highlight" />
          <div className="h-2.5 w-3/4 rounded bg-sol-bg-highlight" />
          <div className="h-4 w-24 rounded bg-sol-bg-highlight" />
        </div>
      ))}
    </div>
  );
}

/** A failure to ask — a dead query, a rejected fetch. Never conflated with empty. */
export function SurfaceError({
  title = "Couldn't load that",
  detail,
  onRetry,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <SurfaceNotice icon={<AlertTriangle className="w-6 h-6" />} title={title} tone="error">
      {detail ? <span className="font-mono text-[11px] break-words">{detail}</span> : null}
      {onRetry && (
        <div className="mt-2">
          <button
            onClick={onRetry}
            className="text-xs text-sol-magenta hover:underline"
            type="button"
          >
            Try again
          </button>
        </div>
      )}
    </SurfaceNotice>
  );
}

/** A filter or query matched nothing. Distinct from "there is nothing". */
export function NoMatches({ query, onClear }: { query?: string; onClear?: () => void }) {
  return (
    <SurfaceNotice icon={<SearchX className="w-6 h-6" />} title="No matches" compact>
      {query ? (
        <>
          Nothing matches <span className="font-mono text-sol-text">{query}</span>.
        </>
      ) : (
        "Nothing matches the current filters."
      )}
      {onClear && (
        <button onClick={onClear} className="ml-1 text-sol-magenta hover:underline" type="button">
          Clear
        </button>
      )}
    </SurfaceNotice>
  );
}

/** Every machine agrees. Worth saying out loud — it is the answer to the question
 *  the page asks, not an empty result. */
export function AllInSync({ deviceCount }: { deviceCount: number }) {
  return (
    <SurfaceNotice icon={<CheckCheck className="w-6 h-6" />} title="No drift" compact>
      All {deviceCount} machines report the same capabilities, at the same pins.
    </SurfaceNotice>
  );
}

/** The public catalog has not been ingested for this deployment yet. */
export function CatalogUnavailable({ detail }: { detail?: string }) {
  return (
    <SurfaceNotice icon={<PackageSearch className="w-6 h-6" />} title="Catalog not loaded" tone="warn">
      {detail ??
        "Nothing has been ingested from the plugin marketplaces yet. A machine running the daemon fills this in from Claude Code's own catalog."}
    </SurfaceNotice>
  );
}

/** Small inline spinner for a refresh in flight while content is already shown. */
export function InlineSpinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim">
      <Loader2 className="w-3 h-3 animate-spin" />
      {label}
    </span>
  );
}

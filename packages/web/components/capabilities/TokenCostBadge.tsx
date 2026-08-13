"use client";

import { useMemo } from "react";
import { Gauge, Zap } from "lucide-react";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";

/**
 * Context cost, split the way it is actually paid.
 *
 * `alwaysOn` is loaded into EVERY session whether or not the capability is ever
 * used — it is rent. `onInvoke` is loaded only when the agent reaches for the
 * thing, so it is a price you choose to pay. Collapsing the two into one number
 * would hide the only part a person can act on, which is why no other catalog's
 * "size" figure is useful here.
 *
 * Claude Code's own `claude plugin details` reports both, and calls them an
 * estimate. We carry `source` and `measuredAt` on every value and say so on the
 * tooltip, so an estimate is never rendered as a measurement. An absent cost
 * renders "—" — the number simply does not exist off the Claude path, and a
 * dash is the honest answer, not an error.
 */
export interface TokenCost {
  /** Tokens added to every session's context. */
  alwaysOn?: number;
  /** Tokens loaded only when the agent invokes it. */
  onInvoke?: number;
  /** Who produced the number. Anything but "measured" renders as an estimate. */
  source?: "claude-plugin-details" | "measured" | "estimated";
  /** When the number was produced, epoch ms. */
  measuredAt?: number;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

/** Sum of the rent across a set — a machine's whole inventory, or a loadout. */
export function alwaysOnTotal(costs: Array<TokenCost | undefined>): {
  total: number;
  known: number;
  unknown: number;
} {
  let total = 0;
  let known = 0;
  let unknown = 0;
  for (const c of costs) {
    if (c && typeof c.alwaysOn === "number" && Number.isFinite(c.alwaysOn)) {
      total += c.alwaysOn;
      known++;
    } else unknown++;
  }
  return { total, known, unknown };
}

/** Rent thresholds. A session's budget is finite, so the colour tracks what the
 *  number does to it rather than tracking "big number bad". */
function rentTone(alwaysOn: number | undefined): string {
  if (alwaysOn === undefined) return "text-sol-text-dim";
  if (alwaysOn >= 5000) return "text-sol-orange";
  if (alwaysOn >= 1000) return "text-sol-yellow";
  return "text-sol-text-muted";
}

function provenance(cost: TokenCost | undefined): string {
  if (!cost) return "No cost reported for this capability.";
  const measured = cost.source === "measured";
  const when =
    typeof cost.measuredAt === "number" && Number.isFinite(cost.measuredAt)
      ? new Date(cost.measuredAt).toLocaleString()
      : null;
  const who =
    cost.source === "claude-plugin-details"
      ? "estimated by claude plugin details"
      : measured
        ? "measured"
        : "estimated";
  return when ? `${who}, ${when}` : who;
}

/**
 * The badge. `variant="full"` labels both halves; `variant="compact"` shows only
 * the rent, for a dense row.
 */
export function TokenCostBadge({
  cost,
  variant = "full",
}: {
  cost?: TokenCost;
  variant?: "full" | "compact";
}) {
  const hasRent = cost && typeof cost.alwaysOn === "number";
  const hasInvoke = cost && typeof cost.onInvoke === "number";

  const tip = useMemo(
    () => (
      <span className="flex flex-col gap-0.5 text-left">
        <span>
          <span className="text-sol-text">
            {hasRent ? formatTokens(cost!.alwaysOn!) : "—"}
          </span>{" "}
          tokens in every session
        </span>
        <span>
          <span className="text-sol-text">
            {hasInvoke ? formatTokens(cost!.onInvoke!) : "—"}
          </span>{" "}
          more only when invoked
        </span>
        <span className="text-sol-text-dim">{provenance(cost)}</span>
      </span>
    ),
    [cost, hasRent, hasInvoke],
  );

  return (
    <ShortcutTooltip label={tip} side="top">
      <span
        className="inline-flex items-center gap-1.5 h-5 px-1.5 rounded border border-sol-border bg-sol-bg-inset text-[10px] font-mono whitespace-nowrap cursor-default"
        // Not a title attribute — the app uses JS tooltips everywhere, and a
        // native one would be both unstyled and slow to appear.
      >
        <Gauge className={`w-3 h-3 ${rentTone(cost?.alwaysOn)}`} />
        <span className={rentTone(cost?.alwaysOn)}>
          {hasRent ? formatTokens(cost!.alwaysOn!) : "—"}
        </span>
        {variant === "full" && (
          <>
            <span className="text-sol-text-dim">always</span>
            <span className="text-sol-border">|</span>
            <Zap className="w-3 h-3 text-sol-text-dim" />
            <span className="text-sol-text-muted">
              {hasInvoke ? formatTokens(cost!.onInvoke!) : "—"}
            </span>
            <span className="text-sol-text-dim">on use</span>
          </>
        )}
      </span>
    </ShortcutTooltip>
  );
}

/**
 * The aggregate — "this machine pays 8.2k tokens in every session". Says how
 * many entries had no number rather than quietly summing them as zero, because
 * a total that silently omits half its inputs is worse than no total.
 */
export function TokenCostTotal({
  costs,
  label = "always-on",
}: {
  costs: Array<TokenCost | undefined>;
  label?: string;
}) {
  const { total, known, unknown } = useMemo(() => alwaysOnTotal(costs), [costs]);
  if (known === 0) {
    return (
      <span className="text-[11px] font-mono text-sol-text-dim" title="No costs reported">
        — {label}
      </span>
    );
  }
  return (
    <ShortcutTooltip
      label={
        <span>
          {formatTokens(total)} tokens from {known}{" "}
          {known === 1 ? "capability" : "capabilities"}
          {unknown > 0 ? `; ${unknown} reported no cost` : ""}
        </span>
      }
      side="top"
    >
      <span className="inline-flex items-center gap-1 text-[11px] font-mono cursor-default">
        <Gauge className={`w-3 h-3 ${rentTone(total)}`} />
        <span className={rentTone(total)}>{formatTokens(total)}</span>
        <span className="text-sol-text-dim">{label}</span>
        {unknown > 0 && <span className="text-sol-text-dim">+{unknown}?</span>}
      </span>
    </ShortcutTooltip>
  );
}

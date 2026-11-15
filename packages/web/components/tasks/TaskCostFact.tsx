"use client";
// What a task has cost (convex taskCost.cost), as one fact in the task header:
// list price, tokens and sessions, with the billed and subscription split in
// its hover card. Hidden until at least one of its sessions reported tokens.

import type { TaskCost } from "@codecast/convex/convex/taskCost";
import { HoverCard } from "../ui/HoverCard";
import { usd } from "../../lib/line/flowStages";
import { formatTokens } from "../charter/charterMeta";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <>
      <span className="text-sol-text-dim">{label}</span>
      <span className={`text-right font-mono tabular-nums ${tone ?? "text-sol-text"}`}>{value}</span>
    </>
  );
}

export function TaskCostFact({ cost, className }: { cost: TaskCost; className: string }) {
  const subscriptions = cost.providers.map((p) => (p === "claude" ? "Claude Code" : "Codex")).join(", ");
  const card = (
    <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-meta">
      <Row label="Billed" value={usd(cost.billed_usd)} tone={cost.billed_usd > 0 ? "text-sol-yellow" : "text-sol-text-muted"} />
      <Row label={subscriptions ? `Subscription (${subscriptions})` : "Subscription"} value={usd(cost.subscription_usd)} tone="text-sol-text-muted" />
      <Row label="List price" value={usd(cost.list_usd)} />
      <div className="col-span-2 my-1 border-t border-sol-border/40" />
      <Row label="Tokens" value={formatTokens(cost.tokens)} />
      {cost.unpriced_tokens > 0 && <Row label="Unpriced model" value={formatTokens(cost.unpriced_tokens)} tone="text-sol-text-muted" />}
      <Row label="Sessions" value={String(cost.sessions)} />
      {cost.uncounted > 0 && <Row label="No token data" value={String(cost.uncounted)} tone="text-sol-text-muted" />}
      {cost.runs > 0 && <Row label="Workflow runs" value={String(cost.runs)} />}
    </div>
  );
  return (
    <HoverCard card={card} className="w-64" align="start" side="bottom">
      <span data-task-cost className={`${className} cursor-default font-mono tabular-nums`}>
        {usd(cost.list_usd)} · {formatTokens(cost.tokens)} tokens · {plural(cost.sessions, "session")}
      </span>
    </HoverCard>
  );
}

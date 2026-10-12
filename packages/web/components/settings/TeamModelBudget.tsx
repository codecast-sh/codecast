"use client";
/**
 * The team's monthly model budget (docs/architecture/learning-loop.md LL10):
 * what codecast may spend on model calls for this team's loop, judging
 * moments, grouping findings into problems and a graph's call steps, and what
 * it has spent this month. A cap of $0 is off and nothing that needs it runs.
 * Every member reads it; an admin sets the cap.
 *
 * Read through the store (settings feed `teamBudget`). A save is the store's
 * setTeamBudget action: the row shows the new cap at once, and the server's
 * answer replaces it.
 */
import { useEffect, useState } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Gauge } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./ui";
import { MeterBar } from "../plan/UsageMeter";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { useInboxStore } from "../../store/inboxStore";
import { BUDGET_PURPOSES, budgetWords, type BudgetSummary } from "@codecast/shared/contracts/modelCall";

const PURPOSE_LABEL = { judge: "Judging moments", grouping: "Grouping findings", call: "Model steps in workflows" } as const;
const dollars = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleString(undefined, { month: "long", timeZone: "UTC" });

export function TeamModelBudget({ teamId, isAdmin }: { teamId: Id<"teams">; isAdmin: boolean }) {
  const { data } = useSettingsData("teamBudget", String(teamId));
  const budget = data as (BudgetSummary & { team_id: string }) | null | undefined;
  const [draft, setDraft] = useState("");
  useEffect(() => { if (budget) setDraft(budget.cap_usd > 0 ? String(budget.cap_usd) : ""); }, [budget?.cap_usd]);
  if (!budget) return null;

  const cap = budget.cap_usd;
  const used = budget.spent_usd;
  const known = cap > 0;
  const next = draft.trim() === "" ? 0 : Number(draft.replace(/^\$/, ""));
  const valid = Number.isFinite(next) && next >= 0 && next <= 100_000;
  const changed = valid && Math.round(next * 100) / 100 !== cap;

  const apply = () => {
    if (changed) useInboxStore.getState().setTeamBudget(String(teamId), next);
  };

  const spentBy = BUDGET_PURPOSES.filter((p) => budget.by_purpose[p] > 0);
  return (
    <SettingsSection
      title="Model budget"
      icon={Gauge}
      description="What codecast may spend each month on model calls for this team: judging moments, grouping findings into problems, and single model steps in your workflows. At $0 none of them run."
    >
      <SettingsRow label={`This month${budget.month ? `, ${monthName(budget.month)}` : ""}`} description={budgetWords(budget)} alignTop>
        <div className="flex w-48 flex-col gap-1.5 pt-1">
          <MeterBar
            label="Model budget used this month"
            known={known}
            cap={cap}
            used={used}
            full={known && used >= cap}
            fill={{ used: known ? Math.min(1, used / cap) : 0, held: known ? Math.min(1 - Math.min(1, used / cap), budget.held_usd / cap) : 0 }}
            minUsedPx={3}
          />
          <div className="flex justify-between text-[11px] tabular-nums text-sol-text-dim">
            <span>{dollars(used)}</span>
            <span>{known ? `of ${dollars(cap)}` : "off"}</span>
          </div>
        </div>
      </SettingsRow>
      {spentBy.length > 0 && (
        <SettingsRow label="Where it went">
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-xs tabular-nums">
            {spentBy.map((p) => (
              <div key={p} className="contents">
                <dt className="text-sol-text-muted">{PURPOSE_LABEL[p]}</dt>
                <dd className="text-right text-sol-text">{dollars(budget.by_purpose[p])}</dd>
              </div>
            ))}
          </dl>
        </SettingsRow>
      )}
      <SettingsRow
        label="Monthly cap"
        description={isAdmin ? "The most it may spend in a calendar month (UTC). Calls past it are skipped until the next month or a higher cap." : "Only team admins can change the cap."}
      >
        {isAdmin ? (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); apply(); }}>
            <div className="relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-sol-text-dim">$</span>
              <Input
                inputMode="decimal"
                aria-label="Monthly cap in dollars"
                aria-invalid={!valid}
                value={draft}
                placeholder="0"
                onChange={(e) => setDraft(e.target.value)}
                className="h-8 w-24 pl-5 text-right tabular-nums"
              />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={!changed}>
              {next === 0 && cap > 0 ? "Turn off" : cap === 0 && next > 0 ? "Turn on" : "Save"}
            </Button>
          </form>
        ) : (
          <span className="text-sm tabular-nums text-sol-text-muted">{known ? dollars(cap) : "Off"}</span>
        )}
      </SettingsRow>
      {budget.history.length > 0 && (
        <SettingsRow label="Earlier months">
          <span className="text-xs tabular-nums text-sol-text-muted">
            {budget.history.slice(0, 3).map((h) => `${monthName(h.month)} ${dollars(h.spent_usd)}`).join(" · ")}
          </span>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

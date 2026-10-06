// What the plan screen shows, read once for Settings > Plan on the web
// (app/settings/plan) and on the phone (packages/mobile components/hosted/
// PlanPage.tsx): the month's figures from the wallet, the plan they belong
// to, which plans are upgrades, where the month's usage went and the
// account's history in plain words. Every number comes from the wallet
// (useWallet) and the PLANS catalog.
import { useMemo } from "react";
import { planOf } from "@codecast/shared/contracts/assistant";
import { useWallet } from "../../hooks/useWallet";
import { accountLine, meterFill, upgradesFrom } from "./lane";
import { useLaneConversations, useLaneTitles } from "./useLane";

/** A day the way the plan screen says it: "October 21". */
export function planDay(at: number | null): string | null {
  return at ? new Date(at).toLocaleDateString([], { month: "long", day: "numeric" }) : null;
}

/** The month's meter alone: the wallet's figures, the plan they belong to,
 *  how full the meter is and the day it starts fresh. The shell's usage
 *  meter reads this; the plan screen adds the rest (usePlanFigures). */
export function usePlanMeter(feed = true) {
  const { wallet, ready } = useWallet(feed);
  // Until the first read lands there are no figures to show, only a quiet meter.
  const known = !!wallet || ready;
  const plan = planOf(wallet?.plan);
  const figures = wallet ?? { used_usd: 0, reserved_usd: 0, cap_usd: plan.included_usd, topup_usd: 0, remaining_usd: plan.included_usd, period_end: null, conversations: [] };
  return {
    wallet,
    known,
    plan,
    /** The month every amount of work is measured in (monthShare): the plan's
     *  full allowance, not the period's cap, which a mid-month plan change
     *  prorates. The cap only fills the meter. */
    month: plan.included_usd,
    figures,
    fill: meterFill(figures),
    full: figures.used_usd >= figures.cap_usd,
    resets: planDay(figures.period_end),
  };
}

export function usePlanFigures() {
  const meter = usePlanMeter();
  const { wallet, plan } = meter;
  const upgrades = useMemo(() => new Set(upgradesFrom(plan.id).map((p) => p.id)), [plan.id]);
  const names = useLaneTitles(useLaneConversations());
  const history = useMemo(
    () => (wallet?.account ?? []).flatMap((line) => {
      const said = accountLine(line, plan);
      return said ? [{ ...said, at: line.at }] : [];
    }),
    [wallet?.account, plan],
  );
  return {
    ...meter,
    upgrades,
    /** Each conversation's name by id, for "Where it went". */
    names,
    lines: wallet?.conversations ?? [],
    history,
  };
}

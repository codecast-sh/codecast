// What the plan screen shows, read once for the web lane (app/simple/plan)
// and the phone's (packages/mobile app/(simple)): the month's figures from
// the wallet, the plan they belong to, which plans are upgrades, where the
// month's usage went and the account's history in plain words. Every number
// comes from the wallet (useWallet) and the PLANS catalog.
import { useMemo } from "react";
import { planOf } from "@codecast/shared/contracts/assistant";
import { useWallet } from "../../hooks/useWallet";
import { accountLine, meterFill, upgradesFrom } from "./lane";
import { useLaneConversations, useLaneTitles } from "./useLane";

/** A day the way the plan screen says it: "October 21". */
export function planDay(at: number | null): string | null {
  return at ? new Date(at).toLocaleDateString([], { month: "long", day: "numeric" }) : null;
}

export function usePlanFigures() {
  const { wallet, ready } = useWallet();
  // Until the first read lands there are no figures to show, only a quiet meter.
  const known = !!wallet || ready;
  const plan = planOf(wallet?.plan);
  const figures = wallet ?? { used_usd: 0, reserved_usd: 0, cap_usd: plan.included_usd, topup_usd: 0, remaining_usd: plan.included_usd, period_end: null, conversations: [] };
  const upgrades = useMemo(() => new Set(upgradesFrom(plan.id).map((p) => p.id)), [plan.id]);
  const names = useLaneTitles(useLaneConversations());
  const history = useMemo(
    () => (wallet?.account ?? []).flatMap((line) => {
      const said = accountLine(line);
      return said ? [{ ...said, at: line.at }] : [];
    }),
    [wallet?.account],
  );
  return {
    wallet,
    known,
    plan,
    figures,
    fill: meterFill(figures),
    full: figures.used_usd >= figures.cap_usd,
    upgrades,
    /** Each conversation's name by id, for "Where it went". */
    names,
    resets: planDay(figures.period_end),
    lines: wallet?.conversations ?? [],
    history,
  };
}

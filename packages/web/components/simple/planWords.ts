// What a hosted assistant plan gives, in plain words, for every surface that
// shows the plans: Settings > Plan, the phone and the public pricing page. A
// leaf over the PLANS catalog, so the public pages read it without the store.
import { PLANS, PLAN_CATALOG, TYPICAL_REQUEST_USD, routineFloor, type PlanSpec } from "@codecast/shared/contracts/assistant";
import { cadenceLabel } from "../../lib/cadence";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function dollars(usd: number): string {
  const v = Math.max(0, usd);
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
}

/** A count said roughly, rounded down to its leading digit (625 reads "600"),
 *  so a measured estimate never reads more precise than it is. */
function roughly(n: number): number {
  if (n < 10) return Math.max(1, Math.floor(n));
  const step = 10 ** Math.floor(Math.log10(n));
  return Math.floor(n / step) * step;
}

/** How much work a plan includes. The Free month is sized in everyday
 *  requests (TYPICAL_REQUEST_USD, measured), and each paid plan as a multiple
 *  of it, never as a dollar figure beside its price. */
export function allowancePoint(plan: PlanSpec): string {
  const base = PLANS[PLAN_CATALOG.free];
  if (plan.included_usd <= base.included_usd || base.included_usd <= 0) {
    return `Room for about ${roughly(plan.included_usd / TYPICAL_REQUEST_USD)} everyday requests a month`;
  }
  return `${Math.round(plan.included_usd / base.included_usd)} times the ${base.label} allowance each month`;
}

/** What each plan gives, in plain words. Every number comes from PLANS. */
export function planPoints(plan: PlanSpec): string[] {
  const { max } = plan.routines;
  const routines = `${max === null ? "Unlimited routines" : plural(max, "routine")}, ${cadenceLabel(routineFloor(plan)).replace(/^every /, "at most every ")}`;
  const together = plan.concurrent_turns === 1 ? "Works on one request at a time" : `Works on ${plan.concurrent_turns === 2 ? "two" : plan.concurrent_turns} requests at once`;
  const thinking = plan.strong_model !== plan.default_model ? "Deeper thinking for hard problems" : null;
  return [allowancePoint(plan), routines, together, ...(thinking ? [thinking] : [])];
}

export function planPrice(plan: PlanSpec): string {
  return `${dollars(plan.price_usd).replace(/\.00$/, "")} a month`;
}

// What a hosted assistant's plans look like. The app owns its catalog (the
// prices, allowances and limits are its product, so it keeps the values);
// this module owns the shape every surface reads them through and the one
// lookup, so the wallet and the app agree on what an unknown id means.
// Imports nothing, so a phone or web bundle can load it alone.

export interface PlanSpec<Id extends string = string> {
  id: Id;
  label: string;
  /** Monthly price in US dollars. */
  price_usd: number;
  /** Model usage the price includes each period, in US dollars at cost. */
  included_usd: number;
  /** The model a turn runs on unless the work calls for the strong one. */
  default_model: string;
  /** The model for hard work; the default model itself on plans without one. */
  strong_model: string;
  routines: {
    /** How many routines may be armed at once; null is unlimited. */
    max: number | null;
    /** The shortest interval a routine may repeat at; null is no floor. */
    min_interval_ms: number | null;
  };
  /** How many turns of one person may run at the same time. */
  concurrent_turns: number;
  /** The most one turn may reserve from the wallet, in US dollars at cost:
   *  the ceiling a single run of the loop spends up to. */
  turn_ceiling_usd: number;
}

/** An app's plans: every plan by id, and the one with nothing to pay, which
 *  an unknown id and a period nobody paid for both fall back to. */
export interface PlanCatalog<Id extends string = string> {
  plans: Readonly<Record<Id, PlanSpec<Id>>>;
  free: Id;
}

/** The plan for a stored id; anything unknown or absent is the free plan. */
export function planIn<Id extends string>(catalog: PlanCatalog<Id>, id: string | null | undefined): PlanSpec<Id> {
  return id && Object.prototype.hasOwnProperty.call(catalog.plans, id) ? catalog.plans[id as Id] : catalog.plans[catalog.free];
}

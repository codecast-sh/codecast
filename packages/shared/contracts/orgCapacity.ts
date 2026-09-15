// The capacity model (docs/architecture/org-staffing.md S2): what one role can
// hold, when a person's span is too wide, and how often the chart may move.
// ONE module, read by the server health query (org.health flags), by the
// role cap defaults, and rendered into the analyzer prompt, so the product
// never argues with itself about a threshold.
//
// Every number is a default with a reason. The analyzer reasons with them and
// may argue for an exception in a change's rationale; the health query flags
// against them as they stand.

/** Daily caps a role starts with (org-roles-standing.md T1). */
export const DEFAULT_ROLE_CAPS = { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400_000 } as const;

export type CapacityThreshold = { value: number; unit: string; reason: string };

/** What one role can hold. A role is one context window: its frame is capped
 *  at 3000 characters of facts and its brief is short, so a scope must fit in
 *  what one agent keeps in its head between wakes. */
export const ROLE_CAPACITY = {
  open_tasks: { value: 25, unit: "open tasks in scope", reason: "above this the frame overflows into counts and the role stops seeing individual tasks" },
  in_flight: { value: 8, unit: "tasks in progress or in review in scope", reason: "each in-flight task is a thread the role follows across wakes; more than this and one of them is dropped" },
  active_plans: { value: 4, unit: "active plans in scope", reason: "a plan is a goal with its own progress; a role directs toward a handful, not a portfolio" },
  live_hands: { value: DEFAULT_ROLE_CAPS.hands_per_day, unit: "live hands", reason: "equals the default hands cap; every hand reports a state line into the frame" },
  direct_reports: { value: 5, unit: "child roles", reason: "each report's brief line is read every wake; past this the role manages managers, and that is a layer" },
  wake_load: { value: 0.7, unit: "of the wake cap (today, or the 7 day average)", reason: "a role that wakes this close to its cap has no headroom for an immediate wake" },
  token_load: { value: 0.8, unit: "of the token cap (today, or the 7 day average)", reason: "past this the flush starts holding system wakes and the role goes quiet mid-day" },
  decision_latency_min: { value: 5, unit: "minutes from ask to recommendation", reason: "the hop deadline on the decision ladder; a role slower than this is a bottleneck for its hands" },
  review_stall_hours: { value: 24, unit: "hours a task sits in review", reason: "a review that waits a day means nobody owns the verdict" },
  idle_days: { value: 14, unit: "days with no scope event", reason: "two quiet weeks means the scope has no work, or the work happens somewhere the role cannot see" },
  peer_sends: { value: 5, unit: "sends between two roles in 7 days, when they outnumber the work done", reason: "two roles that talk more than they ship are coordinating a scope that should be one role's, or a decision that should be a person's" },
} as const satisfies Record<string, CapacityThreshold>;

/** How many roles one person can answer for. */
export const PERSON_SPAN = {
  direct_roles: { value: 7, unit: "roles reporting straight to one person", reason: "each role escalates budget and people questions to its person; above this, propose a layer" },
} as const satisfies Record<string, CapacityThreshold>;

/** How often the chart may move. A chart that changes every review never
 *  settles, and a role's brief is only useful once it has lived in a scope. */
export const STABILITY = {
  move_cooldown_days: { value: 7, unit: "days since a role's last move", reason: "a role moved this week has not had time to show whether the move worked" },
  split_after_breaches: { value: 2, unit: "consecutive reviews with an overload flag", reason: "one busy week is a spike; two is a scope that does not fit" },
  split_on_first_breach_ratio: { value: 2, unit: "times the model on the busiest load count (open tasks, in flight, or active plans)", reason: "a scope twice the model is structural, not a busy week; it splits on the first breach without waiting for a second review" },
  retire_after_idle_days: { value: 14, unit: "idle days before a retirement is proposed", reason: "a quiet role in a quiet workspace is not a problem; a role idle this long while the company works is" },
} as const satisfies Record<string, CapacityThreshold>;

export type RoleCapacityKey = keyof typeof ROLE_CAPACITY;

/** The number behind a threshold, for code that compares. */
export function capacity<K extends RoleCapacityKey>(key: K): number { return ROLE_CAPACITY[key].value; }

// Health flags (S3). The codes are the vocabulary the health query emits, the
// org page renders as badges, and the analyzer prompt teaches; one list.
export const FLAG_CODES = ["overloaded", "wide_span", "idle", "slow_to_recommend", "review_stall", "cap_hit", "unowned", "no_charter", "chatter", "unfiled_plan"] as const;
export type FlagCode = (typeof FLAG_CODES)[number];
export type FlagSeverity = "info" | "warn" | "blocker";
export type HealthFlag = { code: FlagCode; severity: FlagSeverity; detail: string };

/** What each flag means, in the words every surface uses. */
export const FLAG_MEANING: Record<FlagCode, string> = {
  overloaded: "a role's load is past one or more thresholds of the capacity model",
  wide_span: "a person or role has more direct reports than the model allows",
  idle: "a role's scope had no event for the idle window",
  slow_to_recommend: "a role's median time from ask to recommendation is past the hop deadline",
  review_stall: "a task in the role's scope has sat in review past the stall window",
  cap_hit: "a role hit its wake or token cap on recent days",
  unowned: "a project has no owner role",
  no_charter: "a project or plan has no goal, or a role has no charter",
  chatter: "two roles exchange more sends than either exchanges with its hands or its person",
  unfiled_plan: "a plan with open work is filed under no project, so no role's scope can see it",
};

function line(name: string, t: CapacityThreshold): string {
  const shown = t.value < 1 ? `${Math.round(t.value * 100)}%` : String(t.value);
  return `- ${name}: ${shown} ${t.unit}. ${t.reason}.`;
}

/** The capacity model as markdown for a prompt. The analyzer reads it here and
 *  nowhere else, so a changed threshold reaches the prompt without a rewrite. */
export function renderCapacityModel(): string {
  const roles = Object.entries(ROLE_CAPACITY).map(([k, t]) => line(k, t)).join("\n");
  const span = Object.entries(PERSON_SPAN).map(([k, t]) => line(k, t)).join("\n");
  const stability = Object.entries(STABILITY).map(([k, t]) => line(k, t)).join("\n");
  const flags = FLAG_CODES.map((c) => `- ${c}: ${FLAG_MEANING[c]}`).join("\n");
  return [
    "One role holds one context window. Its frame carries at most 3000 characters of facts and its brief is short, so a scope has to fit in what one agent can keep in its head between wakes. These are the defaults; each has a reason, and you may argue for an exception in a change's rationale.",
    "",
    "What one role can hold:",
    roles,
    "",
    "What one person can answer for:",
    span,
    "",
    "How often the chart may move:",
    stability,
    "",
    "The flags org.health raises against this model:",
    flags,
  ].join("\n");
}

// ── Flags from signals (S3) ──────────────────────────────────────────────────
//
// The one place the model is compared against a role's, a person's or the
// company's signals. org.health computes the signals and calls this; the
// analyzer reads the same flags in `cast org health --json`; a test can feed
// it numbers with no database. Pure: no reads, no clock.

export type RoleSignals = {
  kind: "role";
  /** Names the seat in every detail: "@growth". */
  handle: string;
  load: { open_tasks: number; in_flight: number; active_plans: number; live_hands: number; direct_reports: number };
  spend: {
    wakes_today: number; wakes_7d_avg: number; wakes_cap: number;
    tokens_today: number; tokens_7d_avg: number | null; tokens_cap: number;
    cap_hits_7d: number;
  };
  flow: {
    decisions_7d: number;
    median_recommend_min: number | null;
    review_stalls: number;
    done_7d: number;
    sends_7d: { to: Array<{ handle: string; n: number }>; from: Array<{ handle: string; n: number }> };
  };
  /** Consecutive earlier reviews at which this role was flagged overloaded
   *  (org_roles.overload_streak). A split waits for the second breach, and
   *  this is how a review tells a first breach from a second. */
  breaches?: number;
  /** Days since the last scope event; null when the scope never had one. */
  idle_days: number | null;
  /** Days since the role was created: a new seat with no event is not idle yet. */
  age_days: number;
  has_charter: boolean;
};

export type PersonSignals = {
  kind: "person";
  name: string;
  direct_roles: number;
};

export type CompanySignals = {
  kind: "company";
  unowned_projects: Array<{ id: string; title: string }>;
  unfiled_tasks: number;
  plans_without_goal: Array<{ id: string; title: string }>;
  projects_without_charter: Array<{ id: string; title: string }>;
  /** Plans with open work and no project; each is one `file` change away from a scope. */
  unfiled_plans: Array<{ id: string; title: string; short_id?: string; open_tasks: number }>;
};

export type CapacitySignals = RoleSignals | PersonSignals | CompanySignals;

const pct = (n: number, cap: number): number => (cap > 0 ? n / cap : 0);
const pctText = (n: number, cap: number): string => `${Math.round(pct(n, cap) * 100)}%`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Which load counts sit past the model: [count, key, word, suffix]. ONE
 *  reading of "overloaded", used by the flags and by the health query when it
 *  records a review's breach streak. */
export function overloadDetails(load: RoleSignals["load"]): Array<[number, RoleCapacityKey, string, string]> {
  const out: Array<[number, RoleCapacityKey, string, string]> = [];
  const over = (key: RoleCapacityKey, n: number, word: string, suffix = "") => { if (n > capacity(key)) out.push([n, key, word, suffix]); };
  over("open_tasks", load.open_tasks, "open task");
  over("in_flight", load.in_flight, "task", " in flight");
  over("active_plans", load.active_plans, "active plan");
  over("live_hands", load.live_hands, "live hand");
  return out;
}
export function isOverloaded(load: RoleSignals["load"]): boolean { return overloadDetails(load).length > 0; }

/** How far the busiest load count sits past the model: the largest of open
 *  tasks, in flight and active plans, each divided by its threshold. 1 is the
 *  line; STABILITY.split_on_first_breach_ratio is where a split waits for no
 *  second review. org.health emits it as `overload_ratio`. */
export function overloadRatio(load: RoleSignals["load"]): number {
  return Math.max(load.open_tasks / capacity("open_tasks"), load.in_flight / capacity("in_flight"), load.active_plans / capacity("active_plans"));
}
export function splitsOnFirstBreach(load: RoleSignals["load"]): boolean {
  return overloadRatio(load) >= STABILITY.split_on_first_breach_ratio.value;
}

function roleFlags(r: RoleSignals): HealthFlag[] {
  const flags: HealthFlag[] = [];
  const who = `@${r.handle}`;

  // Overloaded: any load count past its threshold. One breach is a warning;
  // two or more means the scope does not fit in one head, and that blocks.
  const breaches = overloadDetails(r.load).map(([n, key, word, suffix]) => `${plural(n, word)}${suffix} (model: ${capacity(key)})`);
  if (breaches.length) {
    // The streak is what the stability rule reads: this breach plus the
    // consecutive earlier reviews that flagged the role is the count the
    // split rule compares to split_after_breaches.
    const earlier = r.breaches ?? 0;
    const streak = earlier + 1;
    const ratio = overloadRatio(r.load);
    // A scope twice the model is structural: it splits now, whatever the
    // streak says. Below that line the streak decides.
    const history = splitsOnFirstBreach(r.load)
      ? `; split now: ${Math.round(ratio * 10) / 10} times the model`
      : earlier ? `; flagged at ${plural(earlier, "earlier review")} in a row, so this is breach ${streak}` : "; first breach on record";
    const blocks = splitsOnFirstBreach(r.load) || breaches.length >= 2 || streak >= STABILITY.split_after_breaches.value;
    flags.push({ code: "overloaded", severity: blocks ? "blocker" : "warn", detail: `${who} holds ${breaches.join(", ")}${history}` });
  }

  if (r.load.direct_reports > capacity("direct_reports")) {
    flags.push({ code: "wide_span", severity: "warn", detail: `${who} has ${plural(r.load.direct_reports, "direct report")} (model: ${capacity("direct_reports")}); propose a layer` });
  }

  // Spend: a cap hit on a recent day is a warning; a day running at or past
  // the load line with no hit yet is information.
  if (r.spend.cap_hits_7d > 0) {
    flags.push({ code: "cap_hit", severity: "warn", detail: `${who} hit its wake or token cap on ${plural(r.spend.cap_hits_7d, "day")} this week` });
  } else {
    const wake = Math.max(pct(r.spend.wakes_today, r.spend.wakes_cap), pct(r.spend.wakes_7d_avg, r.spend.wakes_cap));
    const tokens = Math.max(pct(r.spend.tokens_today, r.spend.tokens_cap), pct(r.spend.tokens_7d_avg ?? 0, r.spend.tokens_cap));
    if (wake >= capacity("wake_load")) flags.push({ code: "cap_hit", severity: "info", detail: `${who} is at ${pctText(Math.max(r.spend.wakes_today, r.spend.wakes_7d_avg), r.spend.wakes_cap)} of its wake cap` });
    if (tokens >= capacity("token_load")) flags.push({ code: "cap_hit", severity: "info", detail: `${who} is at ${pctText(Math.max(r.spend.tokens_today, r.spend.tokens_7d_avg ?? 0), r.spend.tokens_cap)} of its token cap` });
  }

  if (r.flow.median_recommend_min !== null && r.flow.decisions_7d > 0 && r.flow.median_recommend_min > capacity("decision_latency_min")) {
    flags.push({ code: "slow_to_recommend", severity: "warn", detail: `${who} takes ${Math.round(r.flow.median_recommend_min)} min (median) from ask to recommendation over ${plural(r.flow.decisions_7d, "decision")}; the hop deadline is ${capacity("decision_latency_min")}` });
  }
  if (r.flow.review_stalls > 0) {
    flags.push({ code: "review_stall", severity: "warn", detail: `${plural(r.flow.review_stalls, "task")} in ${who}'s scope in review for more than ${capacity("review_stall_hours")}h` });
  }

  // Idle: no scope event for the window. A seat younger than the window with
  // no event yet is new, not idle.
  const quiet = r.idle_days ?? r.age_days;
  if (quiet >= capacity("idle_days")) {
    flags.push({ code: "idle", severity: "info", detail: r.idle_days === null ? `${who}'s scope has had no event since the role was created ${plural(r.age_days, "day")} ago` : `${who}'s scope has had no event for ${plural(r.idle_days, "day")}` });
  }

  // Chatter: the busiest peer exchange, when it outnumbers the work shipped.
  const peers = new Map<string, number>();
  for (const s of [...r.flow.sends_7d.to, ...r.flow.sends_7d.from]) peers.set(s.handle, (peers.get(s.handle) ?? 0) + s.n);
  const [peer, n] = Array.from(peers.entries()).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (peer && n >= capacity("peer_sends") && n > r.flow.done_7d) {
    flags.push({ code: "chatter", severity: "info", detail: `${who} and @${peer} exchanged ${plural(n, "send")} this week against ${plural(r.flow.done_7d, "task")} done` });
  }

  if (!r.has_charter) flags.push({ code: "no_charter", severity: "info", detail: `${who} has no charter` });
  return flags;
}

function personFlags(p: PersonSignals): HealthFlag[] {
  if (p.direct_roles > PERSON_SPAN.direct_roles.value) {
    return [{ code: "wide_span", severity: "warn", detail: `${p.name} answers for ${plural(p.direct_roles, "role")} directly (model: ${PERSON_SPAN.direct_roles.value}); propose a layer` }];
  }
  return [];
}

function companyFlags(c: CompanySignals): HealthFlag[] {
  const flags: HealthFlag[] = [];
  for (const p of c.unowned_projects) flags.push({ code: "unowned", severity: "warn", detail: `project "${p.title}" has no owner role` });
  for (const p of c.projects_without_charter) flags.push({ code: "no_charter", severity: "info", detail: `project "${p.title}" has no goal` });
  for (const p of c.plans_without_goal) flags.push({ code: "no_charter", severity: "info", detail: `plan "${p.title}" has no goal` });
  if (c.unfiled_tasks > 0) flags.push({ code: "unowned", severity: "info", detail: `${plural(c.unfiled_tasks, "open task")} filed under no project or plan` });
  for (const p of c.unfiled_plans) flags.push({ code: "unfiled_plan", severity: "info", detail: `plan "${p.title}"${p.short_id ? ` (${p.short_id})` : ""} has ${plural(p.open_tasks, "open task")} and no project` });
  return flags;
}

/** The flags one set of signals raises against the model. */
export function capacityFlags(input: CapacitySignals): HealthFlag[] {
  switch (input.kind) {
    case "role": return roleFlags(input);
    case "person": return personFlags(input);
    case "company": return companyFlags(input);
  }
}

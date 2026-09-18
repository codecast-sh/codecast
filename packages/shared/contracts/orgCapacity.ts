// The capacity model (docs/architecture/org-staffing.md S2): what loads one
// role, what its scope merely holds, when a person's span is too wide, and
// how often the chart may move. ONE module, read by the server health query
// (org.health flags), by the role cap defaults, and rendered into the
// analyzer prompt, so the product never argues with itself about a threshold.
//
// Every number is a default with a reason. The analyzer reasons with them and
// may argue for an exception in a change's rationale; the health query flags
// against them as they stand.
//
// Load and ledger are two different things. A role does not do its scope's
// tasks; hands and people do. What loads a role is what reaches it and asks
// for its attention: the work items that change in its scope each day (a line
// in its next frame), the decisions routed to it (an immediate wake with a
// deadline), the hands it supervises (a state line each), the stalls it must
// unstick, and how often it runs into its wake cap. The size of its ledger
// (open tasks, tasks in flight, active plans) is context: it says how much the
// frame lists before it overflows into counts, and a ledger far over the line
// is a records problem (stale rows, unfiled plans) or a filing seam before it
// is ever a seat problem. The overloaded flag reads the load; the ledger gets
// its own information flag and never drives a split.

/** Daily caps a role starts with (org-roles-standing.md T1). */
export const DEFAULT_ROLE_CAPS = { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400_000 } as const;

export type CapacityThreshold = { value: number; unit: string; reason: string };

/** What loads one role. A role is one context window: its frame is capped at
 *  3000 characters of facts (about thirty lines) and its brief is short, so
 *  the flow into a seat must fit in what one agent keeps in its head between
 *  wakes. The first five keys are the load axes the overloaded flag reads;
 *  the rest are the other thresholds health flags on their own. */
export const ROLE_CAPACITY = {
  items_per_day: { value: 30, unit: "distinct work items that reached the role's frames (rows of its wake outbox), per day over 7 days", reason: "each changed item is one line the role reads at its next wake and holds until the item settles; the frame carries about thirty lines of facts, so past thirty a day the role reads counts, not items, and stops following any one thread" },
  decisions_per_day: { value: 4, unit: "decisions routed to the role, per day over 7 days", reason: "every routed decision is an immediate wake with a 5 minute hop deadline; past four a day the seat spends its attention on recommendations rather than direction and each new ask queues behind the last" },
  live_hands: { value: DEFAULT_ROLE_CAPS.hands_per_day, unit: "live hands, against the role's own hands cap (this default when it has none)", reason: "equals the role's hands cap; every hand reports a state line into the frame and asks for direction when it settles, and a person who raised a seat's cap has already said it may hold more" },
  open_stalls: { value: 3, unit: "stalls the role must unstick: tasks stuck in review, hands that reported blocked or needs context this week, and sessions of the role that have waited on a person past the session wait window with no escalation", reason: "a stall is a thread the role chases at every wake until it moves; past three at once one of them waits a day, and a day is the review stall window" },
  cap_hit_days: { value: 1, unit: "days in the last 7 the role hit its wake or token cap", reason: "one day at the cap is a spike; more than one in a week means the flow into the seat exceeds what its wake budget lets it read, and immediate wakes start being held" },
  direct_reports: { value: 5, unit: "child roles", reason: "each report's brief line is read every wake; past this the role manages managers, and that is a layer" },
  wake_load: { value: 0.7, unit: "of the wake cap (today, or the 7 day average)", reason: "a role that wakes this close to its cap has no headroom for an immediate wake" },
  token_load: { value: 0.8, unit: "of the token cap (today, or the 7 day average)", reason: "past this the flush starts holding system wakes and the role goes quiet mid-day" },
  decision_latency_min: { value: 5, unit: "minutes from ask to recommendation", reason: "the hop deadline on the decision ladder; a role slower than this is a bottleneck for its hands" },
  review_stall_hours: { value: 24, unit: "hours a task sits in review", reason: "a review that waits a day means nobody owns the verdict" },
  session_wait_hours: { value: 24, unit: "hours one of the role's sessions waits on a person with no escalation", reason: "the role's sessions stay out of the person's inbox, so a wait the role neither answered nor escalated is a wait nobody can see; after a day it is a stall" },
  idle_days: { value: 14, unit: "days with no scope event", reason: "two quiet weeks means the scope has no work, or the work happens somewhere the role cannot see" },
  bypass_done_7d: { value: 10, unit: "tasks closed in a role's scope in 7 days with no hand filed under the seat and no decision routed to it", reason: "a scope that ships this much while nothing passes through its seat is worked around the role, not by it; the seat is a reader of other people's sessions, and the founder should either route the work through it or stop paying for the seat" },
  peer_sends: { value: 5, unit: "sends between two roles in 7 days, when they outnumber the work done", reason: "two roles that talk more than they ship are coordinating a scope that should be one role's, or a decision that should be a person's" },
} as const satisfies Record<string, CapacityThreshold>;

/** What one role's scope holds. Context, reported next to the load and never
 *  a reason to split: the frame lists this much individually and shows the
 *  rest as counts, so a ledger over these lines is first a question of
 *  whether the records are true (stale rows, plans filed under no project)
 *  and of where the seams are, and only then of whether the seat fits. */
export const ROLE_LEDGER = {
  open_tasks: { value: 25, unit: "open tasks in scope", reason: "what the frame lists one by one before it overflows into counts; above this the role sees totals, which is fine for a ledger it does not work itself" },
  in_flight: { value: 8, unit: "tasks in progress or in review in scope", reason: "the threads the frame names individually; more than this and it names the newest and counts the rest" },
  active_plans: { value: 4, unit: "active plans in scope", reason: "a plan is a goal with its own progress line; past a handful the frame summarizes them" },
} as const satisfies Record<string, CapacityThreshold>;

/** How many roles one person can answer for. */
export const PERSON_SPAN = {
  direct_roles: { value: 7, unit: "roles reporting straight to one person", reason: "each role escalates budget and people questions to its person; above this, propose a layer" },
} as const satisfies Record<string, CapacityThreshold>;

/** How often the chart may move. A chart that changes every review never
 *  settles, and a role's brief is only useful once it has lived in a scope. */
export const STABILITY = {
  move_cooldown_days: { value: 7, unit: "days since a role's last move", reason: "a role moved this week has not had time to show whether the move worked" },
  split_after_breaches: { value: 2, unit: "consecutive reviews with an overload flag", reason: "one busy week is a spike; two is a flow that does not fit" },
  split_on_first_breach_ratio: { value: 2, unit: "times the model on the busiest volume axis (items a day, decisions a day, or live hands)", reason: "a flow twice the model is structural, not a busy week; it splits on the first breach without waiting for a second review. Stalls and cap hits are symptoms, not volume, and never make a split on their own; the ledger never does" },
  retire_after_idle_days: { value: 14, unit: "idle days before a retirement is proposed", reason: "a quiet role in a quiet workspace is not a problem; a role idle this long while the company works is" },
} as const satisfies Record<string, CapacityThreshold>;

export type RoleCapacityKey = keyof typeof ROLE_CAPACITY;
export type RoleLedgerKey = keyof typeof ROLE_LEDGER;

/** The number behind a threshold, for code that compares. */
export function capacity<K extends RoleCapacityKey>(key: K): number { return ROLE_CAPACITY[key].value; }
export function ledgerLine<K extends RoleLedgerKey>(key: K): number { return ROLE_LEDGER[key].value; }

// Health flags (S3). The codes are the vocabulary the health query emits, the
// org page renders as badges, and the analyzer prompt teaches; one list.
export const FLAG_CODES = ["overloaded", "bypassed", "wide_ledger", "wide_span", "idle", "slow_to_recommend", "review_stall", "cap_hit", "unowned", "no_charter", "chatter", "unfiled_plan", "stale_plan", "stale_task", "stale_project", "program_ended"] as const;
export type FlagCode = (typeof FLAG_CODES)[number];
export type FlagSeverity = "info" | "warn" | "blocker";
export type HealthFlag = { code: FlagCode; severity: FlagSeverity; detail: string };

/** What each flag means, in the words every surface uses. */
export const FLAG_MEANING: Record<FlagCode, string> = {
  overloaded: "the load reaching a role (items changing a day, decisions a day, live hands, stalls, cap hit days) is past one or more lines of the model",
  bypassed: "work in a role's scope that never reaches it: tasks close and sit in flight in the scope while no hand is filed under the seat and no decision is routed to it; the seat is neither idle nor loaded, it is worked around",
  wide_ledger: "a role's scope holds more open tasks, tasks in flight or active plans than the frame lists individually; context on size, and a records or filing question before it is a seat question",
  wide_span: "a person or role has more direct reports than the model allows",
  idle: "a role's scope had no event for the idle window",
  slow_to_recommend: "a role's median time from ask to recommendation is past the hop deadline",
  review_stall: "a task in the role's scope has sat in review past the stall window",
  cap_hit: "a role hit its wake or token cap on recent days",
  unowned: "a project has no owner role",
  no_charter: "a project or plan has no goal, or a role has no charter",
  chatter: "two roles exchanged at least the peer sends line in a week, and more sends than tasks were done in the scope",
  unfiled_plan: "a plan with open work is filed under no project, so no role's scope can see it",
  stale_plan: "a plan still open whose evidence says it is finished or abandoned: every task closed, or its open tasks untouched for the stale window with no live session on it",
  stale_task: "a task still open whose evidence says it is finished or never started: in progress with no session bound and no write for the stale window, in progress with every session done for that window, or commits carrying its id already landed",
  stale_project: "a project nothing has touched for the activity window: no task, plan, session or commit",
  program_ended: "a program role's end condition is met (its plan or project is done, or its date is past); the next review proposes the retire or the review its tenure names",
};

function line(name: string, t: CapacityThreshold): string {
  const shown = t.value < 1 ? `${Math.round(t.value * 100)}%` : String(t.value);
  return `- ${name}: ${shown} ${t.unit}. ${t.reason}.`;
}

/** The capacity model as markdown for a prompt. The analyzer reads it here and
 *  nowhere else, so a changed threshold, a changed axis or a changed way of
 *  reading the numbers reaches the prompt without a rewrite. */
export function renderCapacityModel(): string {
  const roles = Object.entries(ROLE_CAPACITY).map(([k, t]) => line(k, t)).join("\n");
  const ledger = Object.entries(ROLE_LEDGER).map(([k, t]) => line(k, t)).join("\n");
  const span = Object.entries(PERSON_SPAN).map(([k, t]) => line(k, t)).join("\n");
  const stability = Object.entries(STABILITY).map(([k, t]) => line(k, t)).join("\n");
  const flags = FLAG_CODES.map((c) => `- ${c}: ${FLAG_MEANING[c]}`).join("\n");
  return [
    "One role holds one context window. Its frame carries at most 3000 characters of facts and its brief is short, so what flows into a seat has to fit in what one agent can keep in its head between wakes. A role does not do its scope's tasks; hands and people do. What loads a role is what reaches it and asks for its attention; what its scope holds is context. These are the defaults; each has a reason, and you may argue for an exception in a change's rationale.",
    "",
    "What loads a role (the overloaded flag reads the first five; the rest raise their own flags):",
    roles,
    "",
    "What a role's scope holds (context, reported next to the load; never a reason to split on its own):",
    ledger,
    "",
    "What one person can answer for:",
    span,
    "",
    "How often the chart may move:",
    stability,
    "",
    "The flags org.health raises against this model:",
    flags,
    "",
    "How to read the numbers. `cast org health` is the model's own reading: `load` is what reached the seat over the last seven days (work items in its frames a day, decisions a day, live hands against its own cap, open stalls, cap hit days; `flow.items_changed_7d` is the scope's churn, which is not load), `ledger` is what its scope holds today (open tasks, in flight, active plans), `overload_ratio` is the busiest volume axis divided by its line, and `counted` says which projects, plans and tasks the row read and by what rule, so you can cite the same rows. A role's brief counts more (every plan under its projects, whatever its status) and a wake log shows single days; cite the health numbers as the breach and the brief's as context, and say which is which.",
    "",
    "How to size with it. A seat is right when the flow into it fits: count, from the inputs and the health rows, the items that will change in its scope each day, the decisions that will route to it, the hands it will read and the stalls it will chase, after the record changes in the same proposal have taken the stale rows out. Every role and every scope change states, in its rationale, the seat's resulting load against the model and its ledger as context, counted from the projects and plans it will own after the file changes in the same proposal; when a load axis is over the model, the rationale argues the exception or the change is split along a seam so each seat's flow fits. A wide ledger with a quiet flow is not a seat problem: bring the records in line, file the plans where they belong, and read the load again. A role needs a report when its own scope holds a seam (a repo, a package, a project with its own plans) whose flow would fit one agent and is past the lines when held together. A person needs a layer when the roles reporting straight to them pass the span. A role should be split when its load has breached the model in consecutive reviews, or at once when a volume axis is at twice the model, along a seam its own work shows; it should be merged with a sibling when both are idle or both watch the same scope and talk to each other more than they ship. A project needs an owner when it has sessions, tasks or plans and no role's scope covers it. Budget: `cast org health` reports `company.caps_total`, the daily hands, wakes and tokens the active roles may spend today. Every role and budget change states its caps with the evidence behind each number (a role's wakes over seven days, its tokens, its hands). A seat with no history spends what its routine needs: for a seat that only reviews, 0 hands, 8 wakes and 200,000 tokens a day is the default, stated as a default until a week of wakes says otherwise, so two reviews of the same company do not price the same seat differently by taste. The summary states the company total after the proposal next to the total today; the person allows or trims that total, so never write it as unchanged when a seat is added.",
  ].join("\n");
}

// ── Flags from signals (S3) ──────────────────────────────────────────────────
//
// The one place the model is compared against a role's, a person's or the
// company's signals. org.health computes the signals and calls this; the
// analyzer reads the same flags in `cast org health --json`; a test can feed
// it numbers with no database. Pure: no reads, no clock.

/** The load that reached a role over the last seven days. */
export type RoleLoad = {
  /** Distinct tasks and plans in scope that changed, per day (7 day average). */
  items_per_day: number;
  /** Decisions routed to the role, per day (7 day average). */
  decisions_per_day: number;
  live_hands: number;
  /** The role's own hands cap (capsFor); the default cap when absent. */
  hands_cap?: number;
  direct_reports: number;
  /** Tasks stuck in review past the stall window, hands that reported blocked or needs context this week,
   *  and the role's sessions that waited on a person past the session wait window with no escalation. */
  open_stalls: number;
  /** Days in the last seven the role hit its wake or token cap. */
  cap_hit_days: number;
};

/** What a role's scope holds today. Context, never load. */
export type RoleLedger = { open_tasks: number; in_flight: number; active_plans: number };

export type RoleSignals = {
  kind: "role";
  /** Names the seat in every detail: "@growth". */
  handle: string;
  load: RoleLoad;
  ledger: RoleLedger;
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
    /** Sessions filed under the seat inside the scan window, in any state. */
    hands_window?: number;
  };
  /** A whole workspace seat (the chief of staff) reviews and directs nothing,
   *  so work passing it by is its design, not a finding. */
  reviews_only?: boolean;
  /** The scope names no project or plan that still exists. */
  scope_empty?: boolean;
  /** Consecutive earlier reviews at which this role was flagged overloaded
   *  (org_roles.overload_streak). A split waits for the second breach, and
   *  this is how a review tells a first breach from a second. */
  breaches?: number;
  /** Days since the last scope event; null when the scope never had one. */
  idle_days: number | null;
  /** Days since the role was created: a new seat with no event is not idle yet. */
  age_days: number;
  has_charter: boolean;
  /** A program role whose end condition is met (org-staffing.md S10): what
   *  ended and what the tenure says happens next. Null for a standing role,
   *  a program still running, or a role with no tenure. */
  program_ended?: { ended: string; then: "retire" | "review" } | null;
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
  /** Records whose evidence says they are finished (org-staffing.md S9). Each
   *  is one status change away from true; the analyzer proposes the sync
   *  before it proposes staffing. */
  stale?: StaleWork;
};

/** The stale lists org.analysisInputs and org.health share (S9). One reading
 *  of "stale", computed by convex/lib/orgActivity from the rows. */
export type StalePlanReason = "every task closed" | "no activity 21d" | "bound sessions all done";
export type StaleTaskReason = "in progress, no session 14d" | "in progress, sessions done 14d" | "commits landed, still open";
export type StalePlan = { short_id: string; title: string; status: string; last_task_activity_at: number | null; sessions_live: number; reason: StalePlanReason };
export type StaleTask = { short_id: string; title: string; status: string; last_session_activity_at: number | null; reason: StaleTaskReason };
export type StaleProject = { id: string; title: string; reason: "no activity 30d" };
export type StaleWork = { plans: StalePlan[]; tasks: StaleTask[]; projects: StaleProject[] };

export type CapacitySignals = RoleSignals | PersonSignals | CompanySignals;

const pct = (n: number, cap: number): number => (cap > 0 ? n / cap : 0);
const pctText = (n: number, cap: number): string => `${Math.round(pct(n, cap) * 100)}%`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const perDay = (n: number): string => `${Math.round(n * 10) / 10}`;

/** Which load axes sit past the model: [shown count, key, phrase]. ONE reading
 *  of "overloaded", used by the flags and by the health query when it records
 *  a review's breach streak. */
export function overloadDetails(load: RoleLoad): Array<[number, RoleCapacityKey, string]> {
  const out: Array<[number, RoleCapacityKey, string]> = [];
  const over = (key: RoleCapacityKey, n: number, phrase: string) => { if (n > capacity(key)) out.push([n, key, phrase]); };
  over("items_per_day", load.items_per_day, `${perDay(load.items_per_day)} items changing a day`);
  over("decisions_per_day", load.decisions_per_day, `${perDay(load.decisions_per_day)} decisions a day`);
  if (load.live_hands > handsLine(load)) out.push([load.live_hands, "live_hands", plural(load.live_hands, "live hand")]);
  over("open_stalls", load.open_stalls, plural(load.open_stalls, "open stall"));
  over("cap_hit_days", load.cap_hit_days, `${plural(load.cap_hit_days, "cap hit day")} this week`);
  return out;
}
export function isOverloaded(load: RoleLoad): boolean { return overloadDetails(load).length > 0; }
/** The line a role's live hands are read against: its own cap, else the default. */
export function handsLine(load: RoleLoad): number { return load.hands_cap && load.hands_cap > 0 ? load.hands_cap : capacity("live_hands"); }
/** The model's line for one load axis of one role. */
export function loadLine(key: RoleCapacityKey, load: RoleLoad): number { return key === "live_hands" ? handsLine(load) : capacity(key); }

/** How far the busiest VOLUME axis sits past the model: the largest of items
 *  a day, decisions a day and live hands, each divided by its line. 1 is the
 *  line; STABILITY.split_on_first_breach_ratio is where a split waits for no
 *  second review. Stalls and cap hits are symptoms and stay out of it, so a
 *  bad week of reviews never reads as a structural split. org.health emits it
 *  as `overload_ratio`. */
export function overloadRatio(load: RoleLoad): number {
  return Math.max(load.items_per_day / capacity("items_per_day"), load.decisions_per_day / capacity("decisions_per_day"), load.live_hands / handsLine(load));
}
export function splitsOnFirstBreach(load: RoleLoad): boolean {
  return overloadRatio(load) >= STABILITY.split_on_first_breach_ratio.value;
}

/** Which ledger counts sit past what the frame lists individually. */
export function ledgerDetails(ledger: RoleLedger): Array<[number, RoleLedgerKey, string]> {
  const out: Array<[number, RoleLedgerKey, string]> = [];
  const over = (key: RoleLedgerKey, n: number, phrase: string) => { if (n > ledgerLine(key)) out.push([n, key, phrase]); };
  over("open_tasks", ledger.open_tasks, plural(ledger.open_tasks, "open task"));
  over("in_flight", ledger.in_flight, `${plural(ledger.in_flight, "task")} in flight`);
  over("active_plans", ledger.active_plans, plural(ledger.active_plans, "active plan"));
  return out;
}

function ledgerText(l: RoleLedger): string {
  return `${l.open_tasks} open, ${l.in_flight} in flight, ${plural(l.active_plans, "active plan")}`;
}

function roleFlags(r: RoleSignals): HealthFlag[] {
  const flags: HealthFlag[] = [];
  const who = `@${r.handle}`;

  // Overloaded: any load axis past its line. One breach is a warning; two or
  // more means the flow does not fit in one head, and that blocks. The ledger
  // rides along as context so the reader sees both at once.
  const breaches = overloadDetails(r.load).map(([, key, phrase]) => `${phrase} (model: ${loadLine(key, r.load)})`);
  if (breaches.length) {
    // The streak is what the stability rule reads: this breach plus the
    // consecutive earlier reviews that flagged the role is the count the
    // split rule compares to split_after_breaches.
    const earlier = r.breaches ?? 0;
    const streak = earlier + 1;
    const ratio = overloadRatio(r.load);
    // A flow twice the model on a volume axis is structural: it splits now,
    // whatever the streak says. Below that line the streak decides.
    const history = splitsOnFirstBreach(r.load)
      ? `; split now: ${Math.round(ratio * 10) / 10} times the model`
      : earlier ? `; flagged at ${plural(earlier, "earlier review")} in a row, so this is breach ${streak}` : "; first breach on record";
    const blocks = splitsOnFirstBreach(r.load) || breaches.length >= 2 || streak >= STABILITY.split_after_breaches.value;
    flags.push({ code: "overloaded", severity: blocks ? "blocker" : "warn", detail: `${who} carries ${breaches.join(", ")}${history}; ledger ${ledgerText(r.ledger)}` });
  }

  // Bypassed: the scope ships and the seat sees none of it pass through. Not
  // idle (work happens) and not loaded (nothing asks for it): worked around.
  const handsWindow = r.flow.hands_window ?? r.load.live_hands;
  if (!r.reviews_only && r.flow.done_7d >= capacity("bypass_done_7d") && handsWindow === 0 && r.flow.decisions_7d === 0) {
    flags.push({ code: "bypassed", severity: "warn", detail: `${who}'s scope closed ${plural(r.flow.done_7d, "task")} this week (line: ${capacity("bypass_done_7d")}) and holds ${r.ledger.in_flight} in flight, none of it through the seat: no hand is filed under it and no decision was routed to it. Route the work through the seat (file its sessions under ${who}) or treat the seat as a reader and size its budget as one` });
  }

  // Wide ledger: the scope lists more than the frame shows one by one.
  // Information: a records or filing question first, a seat question only
  // when the load says so too.
  const wide = ledgerDetails(r.ledger).map(([, key, phrase]) => `${phrase} (frame lists: ${ledgerLine(key)})`);
  if (wide.length) {
    const quiet = !breaches.length;
    flags.push({ code: "wide_ledger", severity: "info", detail: `${who}'s scope holds ${wide.join(", ")}; ${quiet ? "its load is inside the model, so this is size, not overload: bring records in line or file by seam before reading it as a seat" : "read the load above for whether the seat fits"}` });
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
    const line = ` (model: ${capacity("idle_days")} days)`;
    flags.push({ code: "idle", severity: "info", detail: r.scope_empty ? `${who}'s scope names no project or plan that still exists, so nothing can reach it${line}` : r.idle_days === null ? `${who}'s scope has had no event since the role was created ${plural(r.age_days, "day")} ago${line}` : `${who}'s scope has had no event for ${plural(r.idle_days, "day")}${line}` });
  }

  // A program's end condition met: the seat outlived its reason to exist.
  if (r.program_ended) {
    flags.push({ code: "program_ended", severity: "warn", detail: `${who} is a program role and ${r.program_ended.ended}; its tenure says ${r.program_ended.then === "retire" ? "retire it" : "review it"}` });
  }

  // Chatter: the busiest peer exchange, when it outnumbers the work shipped.
  const peers = new Map<string, number>();
  for (const s of [...r.flow.sends_7d.to, ...r.flow.sends_7d.from]) peers.set(s.handle, (peers.get(s.handle) ?? 0) + s.n);
  const [peer, n] = Array.from(peers.entries()).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  if (peer && n >= capacity("peer_sends") && n > r.flow.done_7d) {
    flags.push({ code: "chatter", severity: "info", detail: `${who} and @${peer} exchanged ${plural(n, "send")} this week (model: ${capacity("peer_sends")}) against ${plural(r.flow.done_7d, "task")} done` });
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
  // Stale records (S9): information, and a sync change rather than a seat.
  for (const p of c.stale?.plans ?? []) flags.push({ code: "stale_plan", severity: "info", detail: `plan "${p.title}" (${p.short_id}) is ${p.status} but ${p.reason}` });
  for (const t of c.stale?.tasks ?? []) flags.push({ code: "stale_task", severity: "info", detail: `task "${t.title}" (${t.short_id}) is ${t.status.replace("_", " ")}: ${t.reason}` });
  for (const p of c.stale?.projects ?? []) flags.push({ code: "stale_project", severity: "info", detail: `project "${p.title}" has had ${p.reason}` });
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

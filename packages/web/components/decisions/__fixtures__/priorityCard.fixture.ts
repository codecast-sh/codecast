// A synthetic priority change card (plan pl-1131) for the card's tests and
// its preview page (preview/priority-card.html). Every name, title and quote
// is invented: this repository is public. It holds every PriorityChangeKind
// once or more, quotes and events, a new priority whose milestones hang off
// it (`parent`), and a words table with a top priority nobody talked about.
import type { PriorityCard, PriorityChange } from "@codecast/shared/contracts/priorityCard";

const RUN_AT = Date.UTC(2026, 10, 24, 18, 1); // Tue 24 Nov 2026
const min = (m: number) => RUN_AT - m * 60_000;
const quote = (text: string, session: string, session_title: string, minutesAgo: number) =>
  ({ kind: "quote", text, session, session_title, at: min(minutesAgo) }) as const;

const changes: PriorityChange[] = [
  // #9 Checkout survives a flaky network
  {
    id: "c1", kind: "move", priority: "pri-14", from: 9, to: 3,
    evidence: [quote("Checkout is the thing customers actually feel this week. It should sit near the top until the retries are solid.", "k3v8qpa", "Retry storm on the payment step", 220)],
  },
  {
    id: "c2", kind: "milestone_done", priority: "pri-14", step_key: "s2",
    milestone: { title: "Retries back off instead of hammering the gateway", state: "open" },
    evidence: [{ kind: "event", text: "Merged “Exponential backoff for payment retries”", ref: "acme/bakery#212", at: min(95) }],
  },
  {
    id: "c3", kind: "to_critical", priority: "pri-14", step_key: "s4",
    milestone: { title: "A cart survives a dropped connection", state: "open" },
    evidence: [quote("If the cart disappears when the train goes into a tunnel we lose the order. That one is not optional.", "k3v8qpa", "Retry storm on the payment step", 180)],
  },
  {
    id: "c4", kind: "serves", priority: "pri-14", from: "Faster pages everywhere", to: "The holiday rush without an outage",
    evidence: [quote("This is all in service of the holiday rush, really. The load test is at https://status.example.com/load-tests/holiday-rush-2026/checkout-under-flaky-network-conditions-run-7", "m2c9xte", "Holiday traffic plan", 410)],
  },

  // #4 Onboarding under a minute
  {
    id: "c5", kind: "rename", priority: "pri-8", from: "Onboarding under a minute", to: "A new account places its first order in a minute",
    evidence: [quote("The minute only matters if it ends in an order. Signing up fast and then bouncing is not the goal.", "r7d2hzw", "Onboarding funnel review", 300)],
  },
  {
    id: "c6", kind: "rename_milestone", priority: "pri-8", step_key: "s1", from: "Email verification flow", to: "Verification waits until after the first order",
    milestone: { title: "Email verification flow", state: "open" },
    evidence: [quote("Let them order first and verify the email after. Asking up front is where we lose half of them.", "r7d2hzw", "Onboarding funnel review", 290)],
  },
  {
    id: "c7", kind: "milestone_reopen", priority: "pri-8", step_key: "s3",
    milestone: { title: "Welcome tour", state: "done" },
    evidence: [
      quote("The welcome tour is broken again on small phones, the last card is off screen.", "w4n6jfb", "Small screen layout bugs", 140),
      { kind: "event", text: "Task reopened: “Tour's last card clips on narrow screens”", ref: "ct-4471", at: min(130) },
    ],
  },
  {
    id: "c8", kind: "to_polish", priority: "pri-8", step_key: "s5",
    milestone: { title: "Animated arrows on the tour", state: "open" },
    evidence: [quote("The arrows are nice to have. They don't block anything.", "r7d2hzw", "Onboarding funnel review", 280)],
  },
  {
    id: "c9", kind: "drop_milestone", priority: "pri-8", step_key: "s6",
    milestone: { title: "Sign in with a text message", state: "open" },
    evidence: [quote("Nobody asked for text message sign-in. Let's drop it.", "r7d2hzw", "Onboarding funnel review", 275)],
  },
  {
    id: "c10", kind: "merge", priority: "pri-8", from: "Welcome emails people open", target: "pri-31",
    evidence: [quote("The welcome email work is really part of onboarding, it shouldn't be its own line.", "r7d2hzw", "Onboarding funnel review", 260)],
  },

  // #7 Order history search
  {
    id: "c11", kind: "done", priority: "pri-11",
    evidence: [{ kind: "event", text: "Last critical milestone closed: “Search finds an order by any item in it”", ref: "ct-4380", at: min(50) }],
  },

  // New: Recipe import from a link
  {
    id: "c12", kind: "new_priority", priority: "new-1", to: 12,
    evidence: [
      quote("I keep wanting to paste a recipe link and have the ingredients land in the cart. We should try it.", "p5h1guc", "Ideas for the spring menu", 350),
      quote("Maybe not this month though, the checkout work comes first.", "p5h1guc", "Ideas for the spring menu", 345),
    ],
  },
  { id: "c13", kind: "new_milestone", priority: "new-1", step_key: "n1", parent: "c12", to: "A pasted link fills the cart with its ingredients", evidence: [] },
  { id: "c14", kind: "new_milestone", priority: "new-1", step_key: "n2", parent: "c12", to: "Missing ingredients offer a substitute", evidence: [] },

  // Gift cards (done, reopened)
  {
    id: "c15", kind: "reopen", priority: "pri-3",
    evidence: [quote("Gift card balances are showing zero again for some people. We need to pick that back up.", "t8b3kdr", "Support inbox sweep", 70)],
  },
  {
    id: "c16", kind: "new_milestone", priority: "pri-3", step_key: "s7", to: "The balance shows on every receipt",
    evidence: [quote("If the balance were on the receipt, half of these tickets would never come in.", "t8b3kdr", "Support inbox sweep", 65)],
  },
];

export const priorityCardFixture: PriorityCard = {
  v: 1,
  workspace: "user:fixture",
  run_id: "run-fixture-1",
  run: {
    at: RUN_AT,
    window: { from: RUN_AT - 24 * 3_600_000, to: RUN_AT },
    sessions: 14,
    calls: 2,
    cost_usd: 0.38,
    runs_since_last_card: 3,
    runs_today: 2,
  },
  groups: [
    { priority: "pri-14", rank: 9, title: "Checkout survives a flaky network", changes: ["c1", "c2", "c3", "c4"] },
    { priority: "pri-8", rank: 4, title: "Onboarding under a minute", changes: ["c5", "c6", "c7", "c8", "c9", "c10"] },
    { priority: "pri-11", rank: 7, title: "Order history search", changes: ["c11"] },
    { priority: "new-1", rank: null, title: "Recipe import from a link", changes: ["c12", "c13", "c14"] },
    { priority: "pri-3", rank: null, title: "Gift cards", changes: ["c15", "c16"] },
  ],
  changes,
  words: [
    { priority: "pri-14", rank: 9, title: "Checkout survives a flaky network", share: 0.31 },
    { priority: null, rank: null, title: "Not on your list", share: 0.24 },
    { priority: "pri-8", rank: 4, title: "Onboarding under a minute", share: 0.22 },
    { priority: "pri-3", rank: null, title: "Gift cards", share: 0.1 },
    { priority: "pri-11", rank: 7, title: "Order history search", share: 0.08 },
    { priority: "pri-2", rank: 2, title: "Bakery dashboard loads fast", share: 0.05 },
    { priority: "pri-1", rank: 1, title: "Payments never double charge", share: 0 },
  ],
  suggested: changes.map((c) => c.id),
  held: null,
};

/** The fixture's change ids minus the new priority and its milestones: the screenshots' "some unticked" state. */
export const fixtureTickedSome = priorityCardFixture.suggested.filter((id) => !["c12", "c13", "c14"].includes(id));

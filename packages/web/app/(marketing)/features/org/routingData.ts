
/*
 * The routing section's data: four rules tried in order (shared/contracts/orgRoute.ts
 * routeWork) and the incoming items a reader can drop through them. Each item
 * carries what each rule found when it was tested, the line that decides, and
 * for line 4 the router's read (ROUTER_CONFIDENT 0.8, ROUTER_MARGIN 0.3).
 */

export const CONFIDENT = 0.8;
export const MARGIN = 0.3;

export type Line = 1 | 2 | 3 | 4;

export const LINES: { n: Line; name: string; rule: string }[] = [
  { n: 1, name: "Named", rule: "Addressed to a role or a person" },
  { n: 2, name: "Anchored", rule: "Names a task, plan or project; its owner decides" },
  { n: 3, name: "Started", rule: "A new session stays with whoever started it" },
  { n: 4, name: "Read", rule: "One model call reads every role's charter and area" },
];

export type Read = { top: { id: string; c: number }; second: { id: string; c: number }; reason: string };

export type Item = {
  id: string;
  source: string;
  text: string;
  /** What each tested line found, in order, up to and including the deciding line. */
  notes: string[];
  decide: Line;
  /** A role id from kit ROLES, or a person id for line 3. */
  owner: { role: string } | { person: string } | null;
  why: string;
  task?: { id: string; title: string };
  read?: Read;
  cmd?: string;
};

export const ITEMS: Item[] = [
  {
    id: "signups",
    source: "Chat · #general",
    text: "Signups dropped 20% since Tuesday, can someone look",
    notes: ["no @handle, no --to", "no task, plan or project", "not a new session", "read 10 roles"],
    decide: 4,
    owner: { role: "growth" },
    why: "signups are a growth number; its area holds the site",
    task: { id: "ct-418", title: "Signups down 20% since Tuesday" },
    read: { top: { id: "growth", c: 0.86 }, second: { id: "eng", c: 0.42 }, reason: "signups are a growth number; its area holds the site" },
    cmd: `cast route "Signups dropped 20% since Tuesday, can someone look"`,
  },
  {
    id: "error",
    source: "Sentry webhook",
    text: "Checkout 500s since the 14:02 deploy",
    notes: ["no @handle, no --to", "no task, plan or project", "not a new session", "read 10 roles"],
    decide: 4,
    owner: { role: "eng" },
    why: "checkout broke with a deploy; its area is the codebase",
    task: { id: "ct-419", title: "Checkout 500s since the 14:02 deploy" },
    read: { top: { id: "eng", c: 0.92 }, second: { id: "infra", c: 0.4 }, reason: "checkout broke with a deploy; its area is the codebase" },
    cmd: `curl -X POST …/cli/route -d '{"request":"Checkout 500s since the 14:02 deploy"}'`,
  },
  {
    id: "email",
    source: "Email to support@",
    text: "The app logs me out every hour. Can I get March refunded?",
    notes: ["no @handle, no --to", "no task, plan or project", "not a new session", "read 10 roles"],
    decide: 4,
    owner: null,
    why: "two roles fit; it files nothing",
    task: { id: "ct-422", title: "Logged out hourly, asks for a March refund" },
    read: { top: { id: "support", c: 0.61 }, second: { id: "mobile", c: 0.55 }, reason: "a refund is customer mail; the logouts are the app" },
    cmd: `cast route "The app logs me out every hour. Can I get March refunded?"`,
  },
  {
    id: "mention",
    source: "Chat · #eng",
    text: "@mobile the TestFlight build is failing",
    notes: ["@mobile in the line"],
    decide: 1,
    owner: { role: "mobile" },
    why: "named @mobile",
    task: { id: "ct-420", title: "TestFlight build is failing" },
    cmd: `cast route "the TestFlight build is failing" --to @mobile`,
  },
  {
    id: "plan",
    source: "Request in plan Q4 launch",
    text: "Write the launch post for the new pricing page",
    notes: ["no @handle, no --to", "plan Q4 launch is in @cmo's area"],
    decide: 2,
    owner: { role: "growth" },
    why: "@cmo names its plan Q4 launch",
    task: { id: "ct-421", title: "Write the launch post" },
    cmd: `cast route "Write the launch post for the new pricing page" --plan pl-31`,
  },
  {
    id: "session",
    source: "New session · Leo's laptop",
    text: "claude in ~/src/app, no task yet",
    notes: ["no @handle, no --to", "no task, plan or project", "started on Leo's machine"],
    decide: 3,
    owner: { person: "leo" },
    why: "no task, plan or project; it stays with whoever started it",
  },
];

export const item = (id: string): Item => ITEMS.find((i) => i.id === id)!;

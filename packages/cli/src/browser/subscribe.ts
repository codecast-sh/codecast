/**
 * `cast browser subscribe`: wake this session when its tab changes.
 *
 * An agent that hands the human a step in the browser (a sign-in, a
 * permission, a form only they can fill) or waits on the page itself (an
 * export finishing, a build going green, a reply arriving) ends its turn
 * instead of polling or asking to be told. The subscription is the shared
 * one (@platform/cli-kit/subscribe): a codecast trigger bound to this
 * session whose precheck is `cast browser subscription check <id>`. Each
 * check reads the session's own tab once and exits 0 only when the condition
 * has just become true, so waiting spends no agent turn and the wake lands in
 * the session that asked.
 *
 * A condition is any mix of: a description a model judges against the page
 * text, a URL pattern, text on the page, a selector, a JS expression, leaving
 * a sign-in page, or any change at all. All given parts must hold. The model
 * runs only when every other part holds and the page text differs from what
 * it last judged, so a quiet page costs nothing.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Command } from "commander";
import {
  check,
  readSubscriptions,
  subscribe,
  unsubscribe,
  untilText,
  type CastRunner,
  type Resolved,
  type Subscription,
  type SubscriptionSource,
} from "@platform/cli-kit/subscribe";
import { CHEAP_MODEL } from "@codecast/shared/contracts/modelOptions";
import type { ModelCallResult, ModelCallSpec } from "@codecast/shared/contracts/modelCall";
import { globMatch } from "@codecast/shared/contracts/deployTargets";
import { codecastDir } from "../codecastDir.js";
import { resolveCastInvocation } from "../castInvocation.js";
import { signInHost } from "./siteGuard.js";
import { evalInPage, type PageCtx } from "./pageEval.js";

export type PageCondition = {
  /** Plain words a model judges against the page: "the export finished". */
  described?: string;
  /** A URL glob (`**\/dashboard*`), or a substring when it has no `*`. */
  url?: string;
  text?: string;
  selector?: string;
  /** A JS expression, awaited, judged truthy. */
  fn?: string;
  signedIn?: boolean;
  /** Any change to the page text since the subscription started (or last woke). */
  change?: boolean;
};

export type PageState = { url: string; title: string; text: string; selector: boolean | null; fn: boolean | null };

type Data = {
  tab: string;
  condition: PageCondition;
  /** Was the condition true at the last check: a wake is a rise from false. */
  met: boolean;
  /** Text hash `change` compares against. */
  baseline?: string;
  /** The model's last answer and the text hash it judged. */
  judged?: { hash: string; met: boolean; why: string };
  /** The last check that could not read the page or reach the model. */
  error?: string;
  url?: string;
};

export type Judge = (described: string, page: PageState) => Promise<{ met: boolean; why: string } | { error: string }>;

const TEXT_CAP = 40_000;
const JUDGE_TEXT_CAP = 12_000;
export const BROWSER_SUB_EVERY = "30s";
export const BROWSER_SUB_FOR = "2h";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The condition in a few words, for the trigger title and the wake prompt. */
export function describeCondition(c: PageCondition): string {
  const parts: string[] = [];
  if (c.described) parts.push(`"${c.described}"`);
  if (c.signedIn) parts.push("signed in");
  if (c.url) parts.push(`URL ${c.url}`);
  if (c.text) parts.push(`text "${c.text}"`);
  if (c.selector) parts.push(`selector ${c.selector}`);
  if (c.fn) parts.push(`fn ${c.fn}`);
  if (c.change) parts.push("page changed");
  return parts.join(" and ");
}

export function urlMatches(pattern: string, url: string): boolean {
  return pattern.includes("*") ? globMatch(pattern, url) : url.includes(pattern);
}

/** One in-page read: everything any condition needs, in a single evaluate. */
export function pageReadScript(c: PageCondition): string {
  return [
    `const __cs = { url: location.href, title: document.title, text: (document.body?.innerText ?? "").slice(0, ${TEXT_CAP}), selector: null, fn: null };`,
    c.selector ? `__cs.selector = !!document.querySelector(${JSON.stringify(c.selector)});` : "",
    c.fn ? `__cs.fn = !!(await (async () => (${c.fn}))());` : "",
    "__cs",
  ].filter(Boolean).join("\n");
}

/**
 * Whether the condition holds on this page, and the data to keep. Pure but
 * for the judge, which is asked only when every other part holds and the text
 * changed since its last answer.
 */
export async function evaluateCondition(
  c: PageCondition,
  page: PageState,
  data: Pick<Data, "baseline" | "judged">,
  judge: Judge,
): Promise<{ met: boolean; judged?: Data["judged"]; error?: string }> {
  const hash = hashText(page.text);
  const plain =
    (!c.url || urlMatches(c.url, page.url)) &&
    (!c.text || page.text.toLowerCase().includes(c.text.toLowerCase())) &&
    (!c.selector || page.selector === true) &&
    (!c.fn || page.fn === true) &&
    (!c.signedIn || signInHost(page.url) === null) &&
    (!c.change || hash !== data.baseline);
  if (!plain || !c.described) return { met: plain, judged: data.judged };
  if (data.judged?.hash === hash) return { met: data.judged.met, judged: data.judged };
  const answer = await judge(c.described, page);
  if ("error" in answer) return { met: false, judged: data.judged, error: answer.error };
  return { met: answer.met, judged: { hash, ...answer } };
}

const JUDGE_SYSTEM = [
  "You watch a browser tab for someone waiting on it.",
  "They describe a state of the page. Given the page as it is now, say whether that state holds.",
  "Judge only from what the page shows; when the page does not show it, it does not hold.",
  'Answer with one JSON object: {"met": true|false, "why": "<one short sentence naming what on the page decided it>"}.',
].join(" ");

export function judgePrompt(described: string, page: PageState): string {
  return [
    `Waiting for: ${described}`,
    "",
    `URL: ${page.url}`,
    `Title: ${page.title}`,
    "Page text:",
    page.text.slice(0, JUDGE_TEXT_CAP),
  ].join("\n");
}

/**
 * A judge on the workspace's model budget, or on this machine's Claude Code
 * login when the budget refuses: the person waiting is at this machine, so
 * their own login is the natural payer when the team has not set a budget.
 */
export function modelJudge(onBudget: (spec: ModelCallSpec) => Promise<ModelCallResult>, onLogin: (spec: ModelCallSpec) => Promise<ModelCallResult>): Judge {
  return async (described, page) => {
    const spec: ModelCallSpec = { model: CHEAP_MODEL, max_tokens: 300, system: JUDGE_SYSTEM, prompt: judgePrompt(described, page), output: "json" };
    let r = await onBudget(spec);
    if (!r.ok && r.reason === "budget") r = await onLogin(spec);
    if (!r.ok) return { error: `a description cannot be judged: ${r.error}; subscribe with --url/--text/--selector/--fn instead` };
    const j = r.json as { met?: unknown; why?: unknown } | undefined;
    if (typeof j?.met !== "boolean") return { error: "the model's answer held no met: true|false" };
    return { met: j.met, why: typeof j.why === "string" ? j.why : "" };
  };
}

export function browserWakePrompt(sub: Subscription, until: string): string {
  const d = sub.data as Data;
  return [
    `Your browser tab now matches ${sub.label} (cast browser subscription ${sub.id}).`,
    "",
    `1. Look at it: \`${sub.read}\`. It is your own tab, where you left it.`,
    `2. ${sub.note ? `Carry on: ${sub.note}` : "Carry on with the work you were waiting on this page for."}`,
    sub.once
      ? "3. The subscription has ended; nothing to clean up."
      : `3. It wakes you again each time this becomes true, until ${until}. When you no longer need it: \`cast browser unsubscribe ${sub.id}\`.`,
    ...(d.condition.described ? ["", "`cast browser subscriptions` shows why the model judged it met."] : []),
  ].join("\n");
}

/**
 * The command the precheck runs. An installed cast is `cast` on the daemon's
 * PATH, which follows updates; a run from source arms a precheck that calls
 * that same source, since the installed binary may not know this verb yet.
 */
export function browserCli(): string {
  const { cmd, prefixArgs } = resolveCastInvocation();
  return prefixArgs.length ? [cmd, ...prefixArgs, "browser"].map((a) => JSON.stringify(a)).join(" ") : "cast browser";
}

export type BrowserSubDeps = {
  /** This session's tab, as at subscribe time. */
  currentTab: () => Promise<PageCtx>;
  /** The tab a stored subscription watches, rebuilt from its key when a check runs under the daemon. */
  tabFor: (tab: string) => Promise<PageCtx>;
  judge: (session: string | undefined) => Judge;
  /** Reads a tab; readPage, but for tests. */
  read?: (o: PageCtx, c: PageCondition) => Promise<PageState | { error: string }>;
  file?: string;
};

export async function readPage(o: PageCtx, c: PageCondition): Promise<PageState | { error: string }> {
  const r = await evalInPage(pageReadScript(c), o);
  if (!r.ok) return { error: r.hint ? `${r.output} (${r.hint})` : r.output };
  try {
    return JSON.parse(r.output) as PageState;
  } catch {
    return { error: `the page read returned ${r.output.slice(0, 120)}` };
  }
}

/** The SubscriptionSource for one condition on one tab; `incoming` answers from the stored data alone. */
export function browserSource(deps: BrowserSubDeps, resolve?: () => Promise<Resolved>): SubscriptionSource {
  return {
    cli: browserCli(),
    noun: "page match",
    file: deps.file ?? path.join(codecastDir(), "browser", "subscriptions.json"),
    resolve: async () => {
      if (!resolve) throw new Error("no condition to subscribe to");
      return resolve();
    },
    async incoming(sub) {
      const data = sub.data as Data;
      const page = await (deps.read ?? readPage)(await deps.tabFor(data.tab), data.condition).catch((err) => ({ error: (err as Error).message }));
      if ("error" in page) return { count: 0, cursor: sub.cursor, data: { ...data, error: page.error } };
      const r = await evaluateCondition(data.condition, page, data, deps.judge(sub.session));
      const rose = r.met && !data.met;
      const next: Data = {
        ...data,
        met: r.met,
        judged: r.judged,
        url: page.url,
        error: r.error,
        // After a wake, `change` waits for the page to move on from this one.
        baseline: rose && data.condition.change ? hashText(page.text) : data.baseline,
      };
      return { count: rose ? 1 : 0, cursor: sub.cursor + (rose ? 1 : 0), data: next };
    },
    wakePrompt: browserWakePrompt,
  };
}

export type SubscribeFlags = {
  url?: string; text?: string; selector?: string; fn?: string; signedIn?: boolean; change?: boolean;
  note?: string; each?: boolean; every: string; for: string; json?: boolean;
};

export function conditionFrom(described: string[] | undefined, o: SubscribeFlags): PageCondition {
  const c: PageCondition = {};
  const words = (described ?? []).join(" ").trim();
  if (words) c.described = words;
  if (o.url) c.url = o.url;
  if (o.text) c.text = o.text;
  if (o.selector) c.selector = o.selector;
  if (o.fn) c.fn = o.fn;
  if (o.signedIn) c.signedIn = true;
  if (o.change) c.change = true;
  return c;
}

/**
 * Subscribe, or say the condition already holds. A once subscription whose
 * condition is true right now is not armed: the agent goes straight on.
 */
export async function subscribeToPage(
  deps: BrowserSubDeps,
  condition: PageCondition,
  o: Pick<SubscribeFlags, "note" | "each" | "every" | "for"> & { session?: string; cast?: CastRunner },
): Promise<{ already: PageState; why?: string } | { sub: Subscription; existing: boolean }> {
  const tab = await deps.currentTab();
  const page = await (deps.read ?? readPage)(tab, condition);
  if ("error" in page) throw new Error(`cannot read this session's tab: ${page.error}`);
  const baseline = hashText(page.text);
  const now = await evaluateCondition(condition, page, { baseline }, deps.judge(o.session));
  if (now.error) throw new Error(now.error);
  if (now.met && !o.each) return { already: page, why: now.judged?.why };
  const label = describeCondition(condition);
  const data: Data = { tab: tab.session, condition, met: now.met, baseline, judged: now.judged, url: page.url };
  const source = browserSource(deps, async () => ({
    key: `tab:${tab.session}:${JSON.stringify(condition)}`,
    label,
    read: "cast browser snapshot -i",
    cursor: 0,
    data,
  }));
  return subscribe(source, label, { note: o.note, every: o.every, for: o.for, session: o.session, once: !o.each, cast: o.cast });
}

export function registerBrowserSubscriptions(br: Command, deps: BrowserSubDeps & { session: () => string | undefined }): void {
  const source = browserSource(deps);

  br.command("subscribe [description...]")
    .description("Wake this session when its tab reaches a state (a description a model judges, or --url/--text/--selector/--fn/--signed-in/--change); returns at once, so end your turn")
    .option("--signed-in", "the tab has left the sign-in page")
    .option("--url <pattern>", "the URL matches a glob (**/done*), or contains this text")
    .option("--text <text>", "the page shows this text")
    .option("--selector <css>", "an element matching this selector exists")
    .option("--fn <js>", "this JS expression is truthy (awaited)")
    .option("--change", "the page text changes at all")
    .option("--note <text>", "what to do when it wakes you; the wake prompt carries it")
    .option("--each", "wake again every time it becomes true (default: once, then it ends)")
    .option("--every <duration>", "how often to look", BROWSER_SUB_EVERY)
    .option("--for <duration>", "stop looking after this long", BROWSER_SUB_FOR)
    .option("--json", "print the subscription as JSON")
    .action(async (words: string[] | undefined, o: SubscribeFlags) => {
      const condition = conditionFrom(words, o);
      if (!describeCondition(condition)) fail("say what to wait for: a description, or --signed-in, --url, --text, --selector, --fn, --change");
      const session = deps.session();
      if (!session) fail("only an agent session can subscribe: the wake goes back into the session that owns the tab");
      try {
        const r = await subscribeToPage(deps, condition, { ...o, session });
        if ("already" in r) {
          console.log(`Already true now (${r.already.url})${r.why ? `: ${r.why}` : ""}. Nothing armed; carry on.`);
          return;
        }
        if (o.json) return console.log(JSON.stringify(r.sub, null, 2));
        const { sub } = r;
        console.log(`${r.existing ? "Already subscribed" : "Subscribed"} ${sub.id}: ${sub.trigger} checks this tab every ${sub.every} for ${sub.label}, until ${untilText(sub.expires_at)}.`);
        console.log(`${sub.once ? "The first match wakes this session and ends it" : "Each match wakes this session"}. End your turn now (cast state --status dormant naming ${sub.id}). Cancel: cast browser unsubscribe ${sub.id}`);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  br.command("unsubscribe <ids...>")
    .description("End browser subscriptions by id")
    .action((ids: string[]) => {
      const ended = unsubscribe(source, ids);
      if (ended.length === 0) fail(`no browser subscription matches ${ids.join(", ")} (cast browser subscriptions lists them)`);
      for (const s of ended) console.log(`Ended ${s.id} (${s.label}); ${s.trigger ?? "no trigger"} cancelled.`);
    });

  br.command("subscriptions")
    .description("This machine's browser subscriptions: what each waits for and what it last saw")
    .option("--json", "full rows")
    .action((o: { json?: boolean }) => {
      const subs = readSubscriptions(source.file);
      if (o.json) return console.log(JSON.stringify(subs, null, 2));
      if (subs.length === 0) return console.log("No browser subscriptions. cast browser subscribe makes one.");
      for (const s of subs) {
        const d = s.data as Data;
        const seen = d.error ? `error: ${d.error}` : `${d.met ? "met" : "not yet"}${d.url ? ` on ${d.url}` : ""}${d.judged?.why ? ` (${d.judged.why})` : ""}`;
        console.log(`${s.id}  ${s.label}  ${s.trigger ?? "-"} every ${s.every}, until ${untilText(s.expires_at)}, ${s.once ? "once" : "each"}, session ${s.session?.slice(0, 7) ?? "-"}\n    ${seen}`);
      }
    });

  br.command("subscription", { hidden: true })
    .description("The trigger's side of a browser subscription")
    .command("check <id>")
    .description("Exit 0 when the subscription's condition just became true (the trigger's precheck runs this)")
    .action(async (id: string) => {
      const r = await check(source, id);
      console.log(r.message);
      process.exit(r.code);
    });
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

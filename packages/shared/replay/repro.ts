// A replay as a Playwright test (docs/architecture/external-data.md X5): the
// navigation, clicks, typed placeholders, keys and submits up to the failure
// the replay recorded, then an assertion that the failure does not happen.
// It fails today and passes once the bug is fixed, which is what an agent
// turning a replay into a fix needs. Locators come from the recorded label
// and role (getByRole, getByLabel), the way a person finds a control; the CSS
// selector is the fallback when neither was recorded.
import type { ReplayEvent } from "../contracts/replay";
import { primaryFailure, sortReplayEvents, urlPath, type ReplayFailure } from "./events";

export interface ReproOptions {
  /** The origin the test runs against; recorded URLs keep their path, query and hash. */
  baseUrl: string;
  /** The test's name. Defaults to one built from the failure. */
  name?: string;
}

/** Roles getByRole accepts that a recorded role is likely to name. Anything else falls back to text or selector. */
const ARIA_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
  "combobox", "listbox", "textbox", "searchbox", "spinbutton", "slider", "row", "cell", "gridcell", "heading", "img",
  "treeitem", "dialog", "navigation", "listitem",
]);

/** A navigation this soon after an action is that action's consequence: wait for it rather than go there. */
const FOLLOW_MS = 2_000;

const lit = (s: string) => JSON.stringify(s);

function locator(e: { label?: string; role?: string; selector?: string; text?: string }, kind: "click" | "field"): string {
  const label = e.label?.trim();
  if (kind === "field" && label) return `page.getByLabel(${lit(label)})`;
  if (e.role && ARIA_ROLES.has(e.role) && label) return `page.getByRole(${lit(e.role)}, { name: ${lit(label)} })`;
  if (label && kind === "click") return `page.getByText(${lit(label)}, { exact: true })`;
  if (e.selector) return `page.locator(${lit(e.selector)})`;
  return `page.getByText(${lit(e.text ?? "")})`;
}

/** A value of the recorded length that the field will accept. Values are never recorded, so this is all a repro can type. */
export function placeholderValue(label: string, length: number): string {
  const l = label.toLowerCase();
  if (/e-?mail/.test(l)) return "user@example.com";
  if (/pass(word|code)?|pin\b/.test(l)) return "Passw0rd!x".padEnd(Math.max(10, length), "x");
  if (/phone|tel\b|mobile/.test(l)) return "5555550123";
  if (/zip|postal/.test(l)) return "94110";
  if (/\b(amount|qty|quantity|age|count|number)\b/.test(l)) return "1".padEnd(Math.max(1, Math.min(length, 6)), "0");
  if (/url|website|link/.test(l)) return "https://example.com";
  if (/date/.test(l)) return "2026-01-01";
  const n = Math.max(1, Math.min(length || 4, 60));
  return "test text ".repeat(Math.ceil(n / 10)).slice(0, n);
}

/** Text a matcher can look for: the message without stamps, ids and numbers that change run to run. */
function stableNeedle(message: string): string {
  const first = message.split("\n")[0].trim();
  const words = first.split(/\s+/).filter((w) => !/\d{3,}|[0-9a-f]{8,}/i.test(w));
  return words.join(" ").slice(0, 120);
}

function failureCheck(f: ReplayFailure | undefined): { note: string; lines: string[] } {
  if (!f) {
    return {
      note: "no failure was recorded; the test asserts the flow stays clean",
      lines: [
        "  expect(pageErrors, \"page errors\").toEqual([]);",
        "  expect(consoleErrors, \"console errors\").toEqual([]);",
        "  expect(failedRequests, \"failed requests\").toEqual([]);",
      ],
    };
  }
  if (f.type === "network") {
    const path = urlPath(f.url).split("?")[0];
    return {
      note: `recorded: ${f.method} ${path} answered ${f.status || "nothing"}`,
      lines: [
        `  const recorded = failedRequests.filter((r) => r.method === ${lit(f.method.toUpperCase())} && new URL(r.url).pathname === ${lit(path)});`,
        "  expect(recorded, \"the request that failed in the replay\").toEqual([]);",
      ],
    };
  }
  const needle = stableNeedle(f.message);
  const list = f.type === "error" ? "pageErrors" : "consoleErrors";
  return {
    note: `recorded: ${f.type === "error" ? "page error" : "console error"} ${lit(f.message.split("\n")[0].slice(0, 160))}`,
    lines: [
      `  const recorded = ${list}.filter((m) => m.includes(${lit(needle)}));`,
      `  expect(recorded, "the ${f.type === "error" ? "page" : "console"} error from the replay").toEqual([]);`,
    ],
  };
}

/** The steps up to the failure, as Playwright statements, and when the last action of them happened. */
function steps(events: ReplayEvent[], stopAt: number): { lines: string[]; lastActionAt: number } {
  const out: string[] = [];
  let navigated = false;
  let lastActionAt = -Infinity;
  for (let i = 0; i < events.length && events[i].t <= stopAt; i++) {
    const e = events[i];
    const next = events[i + 1];
    switch (e.type) {
      case "nav": {
        const path = urlPath(e.url);
        if (navigated && e.t - lastActionAt <= FOLLOW_MS) out.push(`  await page.waitForURL((u) => u.pathname === ${lit(path.split(/[?#]/)[0])});`);
        else out.push(`  await page.goto(new URL(${lit(path)}, BASE_URL).toString());`);
        navigated = true;
        break;
      }
      case "click":
        out.push(`  await ${locator(e, "click")}.click();`);
        lastActionAt = e.t;
        break;
      case "input":
        // Keystrokes into one field arrive as a run; only the last length matters.
        if (next?.type === "input" && next.selector === e.selector && next.t <= stopAt) break;
        out.push(`  await ${locator(e, "field")}.fill(${lit(placeholderValue(e.label, e.length))}); // ${e.length} chars recorded, value never kept`);
        lastActionAt = e.t;
        break;
      case "key":
        out.push(`  await page.keyboard.press(${lit(e.key)});`);
        lastActionAt = e.t;
        break;
      case "submit":
        // A submit right after a click or Enter is that action's result; replaying it would submit twice.
        if (e.t - lastActionAt <= 1_000) break;
        out.push(`  await ${e.selector ? `page.locator(${lit(e.selector)})` : "page.locator(\"form\").first()"}.evaluate((f) => (f as HTMLFormElement).requestSubmit());`);
        lastActionAt = e.t;
        break;
      case "scroll":
        if (next?.type === "scroll" && next.t <= stopAt) break;
        out.push(`  await page.evaluate(() => window.scrollTo(0, ${Math.round(e.y)}));`);
        break;
      case "mark":
        out.push(`  // app mark: ${e.name}`);
        break;
      default:
        break;
    }
  }
  if (!navigated) out.unshift("  await page.goto(BASE_URL);");
  return { lines: out, lastActionAt };
}

/**
 * How long the repro waits after its last step before asserting: twice the
 * recorded gap from the last action to the failure plus a second, at least
 * two seconds and at most thirty. A waitForLoadState check would resolve at
 * once (the page loaded long before), and the assertion would run ahead of
 * the click's fetch and throw.
 */
function settleMs(failure: ReplayFailure | undefined, lastActionAt: number): number {
  const gap = failure && Number.isFinite(lastActionAt) ? Math.max(0, failure.t - lastActionAt) : 0;
  return Math.min(30_000, Math.max(2_000, Math.round(gap * 2 + 1_000)));
}

/** The Playwright test (TypeScript source) that replays the recording up to its failure. */
export function toRepro(input: readonly ReplayEvent[], opts: ReproOptions): string {
  const events = sortReplayEvents(input);
  const failure = primaryFailure(events);
  const stopAt = failure ? failure.t : Infinity;
  const check = failureCheck(failure);
  const replayed = steps(events, stopAt);
  const name = opts.name ?? (failure ? `replay: ${failure.type === "network" ? `${failure.method} ${urlPath(failure.url)} ${failure.status}` : failure.message.split("\n")[0].slice(0, 80)} does not happen` : "replay runs clean");
  return [
    "import { test, expect } from \"@playwright/test\";",
    "",
    `const BASE_URL = process.env.BASE_URL ?? ${lit(opts.baseUrl)};`,
    "",
    `// Generated from a codecast replay. ${check.note}.`,
    "// Typed values are placeholders: the recorder keeps only how many characters were typed.",
    `test(${lit(name)}, async ({ page }) => {`,
    "  const pageErrors: string[] = [];",
    "  const consoleErrors: string[] = [];",
    "  const failedRequests: { method: string; url: string; status: number }[] = [];",
    "  page.on(\"pageerror\", (err) => pageErrors.push(`${err.name}: ${err.message}`));",
    "  page.on(\"console\", (msg) => { if (msg.type() === \"error\") consoleErrors.push(msg.text()); });",
    "  page.on(\"response\", (res) => { if (res.status() >= 400) failedRequests.push({ method: res.request().method(), url: res.url(), status: res.status() }); });",
    "  page.on(\"requestfailed\", (req) => failedRequests.push({ method: req.method(), url: req.url(), status: 0 }));",
    "",
    ...replayed.lines,
    "",
    "  // Give the page as long to fail as it took in the recording, with room to spare.",
    `  await page.waitForTimeout(${settleMs(failure, replayed.lastActionAt)});`,
    ...check.lines,
    "});",
    "",
  ].join("\n");
}

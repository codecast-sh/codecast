import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { check, readSubscriptions, type CastRunner } from "@platform/cli-kit/subscribe";
import {
  browserSource,
  browserWakePrompt,
  describeCondition,
  evaluateCondition,
  hashText,
  modelJudge,
  pageReadScript,
  subscribeToPage,
  urlMatches,
  type BrowserSubDeps,
  type Judge,
  type PageState,
} from "./subscribe";

const page = (over: Partial<PageState> = {}): PageState => ({ url: "https://app.example.com/home", title: "Home", text: "Welcome back", selector: null, fn: null, ...over });
const never: Judge = async () => { throw new Error("the judge should not be asked"); };

describe("evaluateCondition", () => {
  test("signed in is leaving the sign-in page", async () => {
    expect((await evaluateCondition({ signedIn: true }, page({ url: "https://accounts.google.com/v3/signin" }), {}, never)).met).toBe(false);
    expect((await evaluateCondition({ signedIn: true }, page(), {}, never)).met).toBe(true);
  });

  test("every given part must hold; text is case-insensitive", async () => {
    const c = { url: "**/home", text: "WELCOME" };
    expect((await evaluateCondition(c, page(), {}, never)).met).toBe(true);
    expect((await evaluateCondition(c, page({ url: "https://app.example.com/login" }), {}, never)).met).toBe(false);
  });

  test("change compares the text against the baseline", async () => {
    const baseline = hashText("Welcome back");
    expect((await evaluateCondition({ change: true }, page(), { baseline }, never)).met).toBe(false);
    expect((await evaluateCondition({ change: true }, page({ text: "Export ready" }), { baseline }, never)).met).toBe(true);
  });

  test("the model judges only when the rest holds and the text is new to it", async () => {
    let asked = 0;
    const judge: Judge = async () => { asked++; return { met: true, why: "the banner says done" }; };
    const c = { described: "the export finished", url: "**/home" };
    const first = await evaluateCondition(c, page(), {}, judge);
    expect(first).toEqual({ met: true, judged: { hash: hashText("Welcome back"), met: true, why: "the banner says done" } });
    await evaluateCondition(c, page(), { judged: first.judged }, judge);
    await evaluateCondition(c, page({ url: "https://app.example.com/login" }), {}, judge);
    expect(asked).toBe(1);
  });

  test("a judge error is not a match and is reported", async () => {
    const r = await evaluateCondition({ described: "x" }, page(), {}, async () => ({ error: "budget off" }));
    expect(r).toMatchObject({ met: false, error: "budget off" });
  });
});

test("the judge falls back to this machine's login when the budget refuses, and only then", async () => {
  const used: string[] = [];
  const answer = (who: string, r: any) => async () => { used.push(who); return r; };
  const yes = { ok: true, text: "", json: { met: true, why: "banner" }, usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0, model: "m" };
  const refused = { ok: false, reason: "budget", error: "off", cost_usd: 0, model: "m" };
  expect(await modelJudge(answer("budget", refused), answer("login", yes))("x", page())).toEqual({ met: true, why: "banner" });
  expect(used).toEqual(["budget", "login"]);
  const failed = { ok: false, reason: "failed", error: "timeout", cost_usd: 0, model: "m" };
  const r = await modelJudge(answer("budget", failed), answer("login2", yes))("x", page());
  expect("error" in r && r.error).toContain("timeout");
  expect(used).not.toContain("login2");
});

test("urlMatches: a glob, else a substring", () => {
  expect(urlMatches("**/done*", "https://x.com/a/done?ok")).toBe(true);
  expect(urlMatches("/settings", "https://x.com/settings/billing")).toBe(true);
  expect(urlMatches("**/done", "https://x.com/a/pending")).toBe(false);
});

test("the page read asks only for what the condition uses", () => {
  expect(pageReadScript({ text: "x" })).not.toContain("querySelector");
  expect(pageReadScript({ selector: "#ok" })).toContain('document.querySelector("#ok")');
  expect(pageReadScript({ fn: "window.done" })).toContain("(window.done)");
});

/** A tab whose page the test sets, a fake cast, and a subscription file in a temp dir. */
function rig(start: PageState) {
  let current = start;
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const cast: CastRunner = (args, stdin) => {
    calls.push({ args, stdin });
    return args[1] === "add" ? { status: 0, stdout: "+ Trigger tr-7 every 30s\n", stderr: "" } : { status: 0, stdout: "", stderr: "" };
  };
  const deps: BrowserSubDeps = {
    currentTab: async () => ({ session: "env-abc-real" }),
    tabFor: async (tab) => ({ session: tab }),
    judge: () => never,
    read: async () => current,
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brsub-")), "subscriptions.json"),
  };
  const opts = { every: "30s", for: "2h", session: "jx7abc", cast };
  return { deps, calls, cast, opts, set: (p: Partial<PageState>) => { current = page(p); } };
}

describe("subscribe and check", () => {
  test("arms a trigger bound to the session, with the browser's precheck and wake prompt", async () => {
    const r = rig(page({ url: "https://accounts.google.com/signin" }));
    const out = await subscribeToPage(r.deps, { signedIn: true }, { ...r.opts, note: "export the report" });
    if (!("sub" in out)) throw new Error("expected a subscription");
    const add = r.calls[0]!;
    expect(add.args[add.args.indexOf("--precheck") + 1]).toEndWith(` subscription check ${out.sub.id}`);
    expect(add.args[add.args.indexOf("--every") + 1]).toBe("30s");
    expect(add.args[add.args.indexOf("--for") + 1]).toBe("jx7abc");
    expect(add.stdin).toContain("Carry on: export the report");
    expect(out.sub.once).toBe(true);
    expect((out.sub.data as any).tab).toBe("env-abc-real");
  });

  test("a condition already true arms nothing", async () => {
    const r = rig(page());
    const out = await subscribeToPage(r.deps, { signedIn: true }, r.opts);
    expect("already" in out).toBe(true);
    expect(r.calls).toHaveLength(0);
  });

  test("a once subscription wakes on the rise, then cancels its trigger", async () => {
    const r = rig(page({ url: "https://accounts.google.com/signin" }));
    const out = await subscribeToPage(r.deps, { signedIn: true }, r.opts);
    const id = (out as any).sub.id;
    const source = browserSource(r.deps);
    expect((await check(source, id, { cast: r.cast })).code).toBe(1);
    r.set({});
    expect((await check(source, id, { cast: r.cast })).code).toBe(0);
    expect((await check(source, id, { cast: r.cast })).code).toBe(1);
    expect(r.calls.at(-1)!.args).toEqual(["trigger", "cancel", "tr-7"]);
    expect(readSubscriptions(r.deps.file!)).toHaveLength(0);
  });

  test("--each wakes on every rise and --change re-baselines after each wake", async () => {
    const r = rig(page({ text: "0 comments" }));
    const out = await subscribeToPage(r.deps, { change: true }, { ...r.opts, each: true });
    const id = (out as any).sub.id;
    const source = browserSource(r.deps);
    const codes: number[] = [];
    for (const text of ["0 comments", "1 comment", "1 comment", "2 comments"]) {
      r.set({ text });
      codes.push((await check(source, id, { cast: r.cast })).code);
    }
    expect(codes).toEqual([1, 0, 1, 0]);
    expect(readSubscriptions(r.deps.file!)[0]!.wakes).toBe(2);
  });

  test("a page that cannot be read is a quiet check that records why", async () => {
    const r = rig(page({ url: "https://accounts.google.com/signin" }));
    const out = await subscribeToPage(r.deps, { signedIn: true }, r.opts);
    const id = (out as any).sub.id;
    const broken = browserSource({ ...r.deps, read: async () => ({ error: "the bridge is down" }) });
    expect((await check(broken, id, { cast: r.cast })).code).toBe(1);
    expect((readSubscriptions(r.deps.file!)[0]!.data as any).error).toBe("the bridge is down");
  });

  test("the wake prompt names the tab, the note and whether it ended", () => {
    const base = { id: "s-2", label: '"the export finished"', read: "cast browser snapshot -i", note: "download the CSV", data: { condition: { described: "the export finished" } } } as any;
    const once = browserWakePrompt({ ...base, once: true }, "Nov 4, 9:00 PM");
    expect(once).toContain("Your browser tab now matches \"the export finished\"");
    expect(once).toContain("Carry on: download the CSV");
    expect(once).toContain("has ended");
    expect(browserWakePrompt(base, "Nov 4, 9:00 PM")).toContain("cast browser unsubscribe s-2");
  });

  test("describeCondition joins every part", () => {
    expect(describeCondition({ signedIn: true, url: "**/home" })).toBe("signed in and URL **/home");
    expect(describeCondition({})).toBe("");
  });
});


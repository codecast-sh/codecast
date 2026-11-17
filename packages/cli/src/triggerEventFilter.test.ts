// The `--on` filter and its narrowing flags (triggerEventFilter.ts). The source
// lookup itself runs on the server when the trigger is saved
// (convex ingest.test.ts "trigger source filters").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildEventFilter, narrowingWithoutOn } from "./triggerEventFilter.js";

const errors: string[] = [];
const realError = console.error;
const realExit = process.exit;
beforeEach(() => {
  errors.length = 0;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  process.exit = ((code?: number) => { throw new Error(`exit ${code ?? 0}`); }) as never;
});
afterEach(() => {
  console.error = realError;
  process.exit = realExit;
});

const noCheckout = async () => undefined;

describe("buildEventFilter", () => {
  test("--source narrows a source event and passes the ref on trimmed for the server to resolve", async () => {
    expect(await buildEventFilter("error_new", { source: " src-5 " }, noCheckout)).toEqual({ event_type: "error_new", source: "src-5" });
    expect(await buildEventFilter("error_new", { source: "" }, noCheckout)).toEqual({ event_type: "error_new" });
  });

  test("--source on an event no source reports is refused", async () => {
    await expect(buildEventFilter("pr_opened", { source: "web", repo: "" }, noCheckout)).rejects.toThrow(/exit 1/);
    expect(errors[0]).toContain("--source only narrows");
  });

  test("a pull request event takes the checkout's repository unless --repo says otherwise", async () => {
    const here = async () => "codecast-sh/codecast";
    expect((await buildEventFilter("pr_opened", {}, here)).repository).toBe("codecast-sh/codecast");
    expect((await buildEventFilter("pr_opened", { repo: "" }, here)).repository).toBeUndefined();
    expect(await buildEventFilter("pr_opened", { pr: "12", repo: "a/b" }, here)).toMatchObject({ repository: "a/b", pr_number: 12 });
  });

  test("a bad --pr and an unknown event are refused", async () => {
    await expect(buildEventFilter("pr_opened", { pr: "x" }, noCheckout)).rejects.toThrow(/exit 1/);
    await expect(buildEventFilter("nope", {}, noCheckout)).rejects.toThrow(/exit 1/);
    expect(errors[1]).toContain('Unknown event "nope"');
  });

  test("page_state watches the one page --page names, narrowed by --collection, and needs it", async () => {
    expect(await buildEventFilter("page_state", { page: " abc123 " }, noCheckout)).toEqual({ event_type: "page_state", page_id: "abc123" });
    expect(await buildEventFilter("page_state", { page: "abc123", collection: "requests, answers" }, noCheckout)).toEqual({ event_type: "page_state", page_id: "abc123", collections: ["requests", "answers"] });
    await expect(buildEventFilter("page_state", {}, noCheckout)).rejects.toThrow(/exit 1/);
    expect(errors[0]).toContain("--page");
    await expect(buildEventFilter("chat_message", { channel: "#x", page: "abc" }, noCheckout)).rejects.toThrow(/exit 1/);
    expect(narrowingWithoutOn({ page: "abc" })).toBe("--page");
  });

  test("chat_message watches the one channel --channel names, and needs it", async () => {
    expect(await buildEventFilter("chat_message", { channel: "#intake" }, noCheckout)).toEqual({ event_type: "chat_message", channel_id: "#intake" });
    await expect(buildEventFilter("chat_message", {}, noCheckout)).rejects.toThrow(/exit 1/);
    expect(errors[0]).toContain("--channel");
    await expect(buildEventFilter("pr_opened", { channel: "#intake", repo: "" }, noCheckout)).rejects.toThrow(/exit 1/);
    expect(errors[1]).toContain("--channel only narrows");
  });

  test("an event one typo away names the near match", async () => {
    await expect(buildEventFilter("pr_commentz", {}, noCheckout)).rejects.toThrow(/exit 1/);
    expect(errors[0]).toContain("Next step: did you mean pr_comment?");
  });
});

describe("narrowingWithoutOn", () => {
  test("names the flag that would be dropped without --on", () => {
    expect(narrowingWithoutOn({ source: "web" })).toBe("--source");
    expect(narrowingWithoutOn({ repo: "" })).toBe("--repo");
    expect(narrowingWithoutOn({ on: "error_new", source: "web" })).toBeUndefined();
    expect(narrowingWithoutOn({})).toBeUndefined();
    expect(narrowingWithoutOn({ channel: "#intake" })).toBe("--channel");
  });
});

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROMOTE,
  GROUP_KINDS,
  INGEST_LIMITS,
  TRANSITIONS,
  generateIngestKey,
  hashIngestKey,
  ingestKeyPrefix,
  isGroupedLogLevel,
  isIngestKey,
  kindTriggerEvents,
  sourceFilterAdmits,
  transitionSignalKind,
  transitionTriggerEvent,
  validateIngestBatch,
  sourceConfigProblem,
} from "./ingest";
import { INGEST_TRIGGER_EVENTS, TRIGGER_EVENT_LABELS, TRIGGER_EVENT_SHORTHANDS } from "./triggerEvents";
import { SIGNAL_KINDS } from "./signalFingerprint";

const NOW = Date.UTC(2026, 9, 3, 12);

function ok(body: unknown) {
  const result = validateIngestBatch(body, NOW);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result;
}

describe("validateIngestBatch", () => {
  test("accepts every item type and fills the envelope", () => {
    const result = ok({
      sdk: { name: "@platform/analytics", version: "1.2.0" },
      release: "web@1.4",
      environment: "production",
      items: [
        { type: "error", message: "boom", stack: "Error: boom\n    at f (app.js:1:2)", at: NOW - 1000 },
        { type: "log", level: "warn", message: "slow", at: NOW },
        { type: "job_failed", job: "sync", error: "timeout", attempt: 2, at: NOW },
        { type: "check", id: "inv-1", ok: false, title: "orphans", at: NOW },
        { type: "event", name: "signup", props: { plan: "pro" }, at: NOW },
        { type: "deploy", version: "1.4", sha: "abc", at: NOW },
        { type: "replay", replay_id: "r1", chunks: 2, counts: { clicks: 3 }, at: NOW },
      ],
    });
    expect(result.envelope).toEqual({ sdk: { name: "@platform/analytics", version: "1.2.0" }, release: "web@1.4", environment: "production" });
    expect(result.items.map((i) => i.type)).toEqual(["error", "log", "job_failed", "check", "event", "deploy", "replay"]);
    expect(result.rejected).toEqual([]);
  });

  test("a bad item is rejected by index and the rest go through", () => {
    const result = ok({
      items: [
        { type: "error", at: NOW },
        { type: "error", message: "real", at: NOW },
        { type: "check", id: "x", ok: "no" },
        { type: "nope" },
        "string",
        { type: "log", message: "no level" },
      ],
    });
    expect(result.items).toHaveLength(1);
    expect(result.rejected.map((r) => r.index)).toEqual([0, 2, 3, 4, 5]);
    expect(result.envelope.sdk).toEqual({ name: "unknown", version: "0" });
  });

  test("structural problems refuse the batch with a status the SDK acts on", () => {
    expect(validateIngestBatch("{not json", NOW)).toMatchObject({ ok: false, status: 400 });
    expect(validateIngestBatch([], NOW)).toMatchObject({ ok: false, status: 400 });
    expect(validateIngestBatch({ items: "x" }, NOW)).toMatchObject({ ok: false, status: 400 });
    const many = { items: Array.from({ length: INGEST_LIMITS.max_items + 1 }, () => ({ type: "event", name: "x" })) };
    expect(validateIngestBatch(many, NOW)).toMatchObject({ ok: false, status: 413 });
    const huge = JSON.stringify({ items: [{ type: "error", message: "x".repeat(INGEST_LIMITS.max_bytes) }] });
    expect(validateIngestBatch(huge, NOW)).toMatchObject({ ok: false, status: 413 });
  });

  test("exactly the item cap is accepted, and a raw string body parses", () => {
    const body = { items: Array.from({ length: INGEST_LIMITS.max_items }, () => ({ type: "event", name: "x" })) };
    expect(ok(JSON.stringify(body)).items).toHaveLength(INGEST_LIMITS.max_items);
  });

  test("long fields are clipped, big objects replaced by a note", () => {
    const [item] = ok({
      items: [{
        type: "error",
        message: "m".repeat(5000),
        stack: "s".repeat(40_000),
        context: { blob: "c".repeat(20_000) },
        tags: { a: "t".repeat(500), n: 3, nested: { no: 1 } },
        at: NOW,
      }],
    }).items;
    if (item.type !== "error") throw new Error("type");
    expect(item.message).toHaveLength(INGEST_LIMITS.message_chars);
    expect(item.stack).toHaveLength(INGEST_LIMITS.stack_chars);
    expect(item.context?._truncated).toBeDefined();
    expect(item.tags).toEqual({ a: "t".repeat(INGEST_LIMITS.tag_value_chars), n: "3" });
  });

  test("timestamps: ISO strings parse, missing and far-future become now", () => {
    const items = ok({
      items: [
        { type: "event", name: "a", at: "2026-10-03T11:00:00Z" },
        { type: "event", name: "b" },
        { type: "event", name: "c", at: NOW + 3600_000 },
        { type: "event", name: "d", at: NOW + 60_000 },
      ],
    }).items;
    expect(items.map((i) => i.at)).toEqual([Date.UTC(2026, 9, 3, 11), NOW, NOW, NOW + 60_000]);
  });

  test("absent optional fields leave no undefined keys", () => {
    const [item] = ok({ items: [{ type: "check", id: "a", ok: true, at: NOW }] }).items;
    expect(Object.keys(item).sort()).toEqual(["at", "id", "ok", "type"]);
  });
});

describe("log levels", () => {
  test("only warn and above are grouped", () => {
    expect(["debug", "info", "warn", "error", "fatal"].map((l) => isGroupedLogLevel(l as any))).toEqual([false, false, true, true, true]);
  });
});

describe("transitions", () => {
  test("every trigger name a transition fires is an armable shorthand in the ingest set", () => {
    for (const kind of GROUP_KINDS) {
      for (const t of TRANSITIONS) {
        const name = transitionTriggerEvent(kind, t);
        if (!name) continue;
        expect(TRIGGER_EVENT_SHORTHANDS[name]).toEqual({ event_type: name });
        expect(INGEST_TRIGGER_EVENTS).toContain(name);
      }
    }
  });

  test("errors and warning logs share the error names; other kinds fire their own", () => {
    expect(transitionTriggerEvent("error", "new")).toBe("error_new");
    expect(transitionTriggerEvent("log", "regressed")).toBe("error_regressed");
    expect(transitionTriggerEvent("error", "spike")).toBe("error_spike");
    expect(transitionTriggerEvent("job", "job_failed")).toBe("job_failed");
    expect(transitionTriggerEvent("check", "check_failed")).toBe("check_failed");
    expect(transitionTriggerEvent("check", "check_recovered")).toBe("check_recovered");
    expect(transitionTriggerEvent("metric", "metric_alert")).toBe("metric_alert");
    expect(transitionTriggerEvent("metric", "metric_recovered")).toBe("metric_recovered");
    expect(transitionTriggerEvent(undefined, "deploy")).toBe("deploy");
  });

  test("resolutions and new non-error groups fire nothing", () => {
    expect(transitionTriggerEvent("error", "resolved")).toBeUndefined();
    expect(transitionTriggerEvent("job", "new")).toBeUndefined();
    expect(transitionTriggerEvent("check", "new")).toBeUndefined();
  });

  test("the promotion kind map (X6)", () => {
    expect(transitionSignalKind("new")).toBe("bug");
    expect(transitionSignalKind("regressed")).toBe("regression");
    expect(transitionSignalKind("spike")).toBe("regression");
    expect(transitionSignalKind("check_failed")).toBe("bug");
    expect(transitionSignalKind("job_failed")).toBe("bug");
    expect(transitionSignalKind("metric_alert")).toBe("ux");
    expect(transitionSignalKind("resolved")).toBeUndefined();
    expect(transitionSignalKind("deploy")).toBeUndefined();
    for (const t of TRANSITIONS) {
      const k = transitionSignalKind(t);
      if (k) expect(SIGNAL_KINDS).toContain(k);
    }
  });

  test("the default promote set only names transitions that promote", () => {
    for (const t of DEFAULT_PROMOTE) expect(transitionSignalKind(t)).toBeDefined();
  });
});

describe("ingest keys", () => {
  test("shape cc_ing_ plus 32 base62, never repeated", () => {
    const keys = new Set(Array.from({ length: 200 }, generateIngestKey));
    expect(keys.size).toBe(200);
    for (const key of keys) {
      expect(key).toMatch(/^cc_ing_[0-9A-Za-z]{32}$/);
      expect(isIngestKey(key)).toBe(true);
    }
  });

  test("anything else is not a key", () => {
    expect(isIngestKey(undefined)).toBe(false);
    expect(isIngestKey("cc_ing_short")).toBe(false);
    expect(isIngestKey("cc_ing_" + "a".repeat(31) + "-")).toBe(false);
  });

  test("the prefix shows 8 random characters after the fixed head", () => {
    expect(ingestKeyPrefix("cc_ing_ABCDEFGHrest" + "x".repeat(20))).toBe("cc_ing_ABCDEFGH");
  });

  test("the hash is lowercase hex sha256 and stable", async () => {
    const h = await hashIngestKey("cc_ing_abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashIngestKey("cc_ing_abc")).toBe(h);
    expect(await hashIngestKey("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("sourceFilterAdmits", () => {
  test("no filter admits every source; a filter admits its own name in any spelling", () => {
    expect(sourceFilterAdmits(undefined, "union")).toBe(true);
    expect(sourceFilterAdmits("", "union")).toBe(true);
    expect(sourceFilterAdmits(" Union ", "union")).toBe(true);
    expect(sourceFilterAdmits("union", "web")).toBe(false);
    expect(sourceFilterAdmits("union", undefined)).toBe(false);
  });
});

describe("kindTriggerEvents", () => {
  test("every name a group can fire is an armable ingestion trigger with a label", () => {
    for (const kind of GROUP_KINDS) {
      for (const name of kindTriggerEvents(kind)) {
        expect(INGEST_TRIGGER_EVENTS).toContain(name);
        expect(TRIGGER_EVENT_LABELS[name]).toBeTruthy();
      }
    }
  });

  test("names only what a group of the kind can fire", () => {
    expect(kindTriggerEvents("error")).toEqual(["error_new", "error_regressed", "error_spike"]);
    expect(kindTriggerEvents("log")).toEqual(["error_new", "error_regressed", "error_spike"]);
    expect(kindTriggerEvents("job")).toEqual(["job_failed"]);
    expect(kindTriggerEvents("check")).toEqual(["check_failed", "check_recovered"]);
    expect(kindTriggerEvents("metric")).toEqual(["metric_alert", "metric_recovered"]);
    expect(kindTriggerEvents("replay_issue")).toEqual([]);
  });
});

describe("sourceConfigProblem", () => {
  test("a setting for another provider, or a value its provider does not take, is refused", () => {
    expect(sourceConfigProblem("sentry", { org: "acme", projects: ["web", "11"], environments: ["production"] })).toBeNull();
    expect(sourceConfigProblem("posthog", { project_id: "77" })).toBeNull();
    expect(sourceConfigProblem("sdk", { allowed_origins: ["https://app.acme.dev"] })).toBeNull();
    expect(sourceConfigProblem("posthog", { project_id: "abc" })).toMatch(/PostHog project id/);
    expect(sourceConfigProblem("posthog", { org: "acme" })).toBe("org does not apply to a posthog source");
    expect(sourceConfigProblem("sentry", { projects: ["web", "../x"] })).toMatch(/not a Sentry project slug/);
    expect(sourceConfigProblem("sentry", { allowed_origins: ["https://x"] })).toMatch(/does not apply/);
    expect(sourceConfigProblem("app", undefined)).toBeNull();
  });
});

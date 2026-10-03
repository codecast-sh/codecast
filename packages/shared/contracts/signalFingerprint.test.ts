import { describe, expect, test } from "bun:test";
import { evalsSignalFingerprint, insightSignalFingerprint } from "./signalFingerprint";

describe("evalsSignalFingerprint", () => {
  test("names the surface and the check or freeze", () => {
    expect(evalsSignalFingerprint("title", "json")).toBe("evals:title:json");
    expect(evalsSignalFingerprint(" title ", " abc123 ")).toBe("evals:title:abc123");
  });
});

describe("insightSignalFingerprint", () => {
  test("is stable and shaped insight:<session>:<8 hex>", () => {
    const fp = insightSignalFingerprint("jx7c6zk", "Convex deploy fails on the schema check");
    expect(fp).toMatch(/^insight:jx7c6zk:[0-9a-f]{8}$/);
    expect(insightSignalFingerprint("jx7c6zk", "Convex deploy fails on the schema check")).toBe(fp);
  });

  test("case, spacing and end punctuation restate the same blocker", () => {
    const fp = insightSignalFingerprint("jx7c6zk", "Convex deploy fails on the schema check");
    expect(insightSignalFingerprint("jx7c6zk", "  convex deploy  fails on the\nschema check.")).toBe(fp);
  });

  test("a different blocker or session is a different fingerprint", () => {
    const fp = insightSignalFingerprint("jx7c6zk", "Convex deploy fails on the schema check");
    expect(insightSignalFingerprint("jx7c6zk", "Tests time out under load")).not.toBe(fp);
    expect(insightSignalFingerprint("jx7aaaa", "Convex deploy fails on the schema check")).not.toBe(fp);
  });
});

import {
  checkFingerprint,
  groupFingerprint,
  jobFingerprint,
  metricFingerprint,
  normalizeErrorMessage,
  parseStackFrame,
  sdkErrorFingerprint,
  sentryIssueFingerprint,
  topInAppFrame,
} from "./signalFingerprint";

describe("groupFingerprint", () => {
  test("segment and fp, with the source prefix in front when set", () => {
    expect(groupFingerprint(undefined, "error", "abc")).toBe("error:abc");
    expect(groupFingerprint("  ", "job", "sync")).toBe("job:sync");
    expect(groupFingerprint("union", "metric", "mw-3")).toBe("union:metric:mw-3");
  });

  test("a check joins the line finder's invariant scheme", () => {
    expect(groupFingerprint("union", "check", checkFingerprint(" orphan_contacts "))).toBe("union:invariant:orphan_contacts");
  });
});

describe("normalizeErrorMessage", () => {
  test("numbers, uuids and hex runs fold away", () => {
    expect(normalizeErrorMessage("User 42 not found")).toBe(normalizeErrorMessage("User 97 not found"));
    expect(normalizeErrorMessage("row 3f2504e0-4f89-11d3-9a0c-0305e82c3301 missing")).toBe("row <uuid> missing");
    expect(normalizeErrorMessage("bad ptr 0xDEADBEEF")).toBe("bad ptr <hex>");
    expect(normalizeErrorMessage("commit 9fceb02d0ae598e95dc970b74767f19372d61af8 gone")).toBe("commit <hex> gone");
    expect(normalizeErrorMessage("took 1.5s  of\n 30")).toBe("took <n>s of <n>");
  });

  test("words made of hex letters survive", () => {
    expect(normalizeErrorMessage("deadbeef facade")).toBe("deadbeef facade");
  });
});

describe("topInAppFrame", () => {
  test("V8: skips library frames and drops line, column, origin and content hash", () => {
    const stack = [
      "Error: boom",
      "    at Object.fn (/app/node_modules/react-dom/index.js:10:5)",
      "    at handleClick (https://codecast.sh/assets/index-a1B2c3D4e5.js:120:33)",
      "    at main (https://codecast.sh/assets/main.js:1:1)",
    ].join("\n");
    expect(topInAppFrame(stack)).toBe("handleClick@/assets/index.js");
  });

  test("V8 frame without a function name", () => {
    expect(topInAppFrame("Error\n    at /srv/app/jobs/sync.ts:4:2")).toBe("<anon>@/srv/app/jobs/sync.ts");
  });

  test("Gecko and Safari frames", () => {
    expect(topInAppFrame("submit@https://x.dev/app.js?v=3:9:1\n@https://x.dev/vendor.js:1:1")).toBe("submit@/app.js");
  });

  test("a message line with an email is not a frame", () => {
    expect(topInAppFrame("Error: no user a@b.com\n    at load (/srv/users.ts:3:1)")).toBe("load@/srv/users.ts");
  });

  test("nothing in-app, or no stack", () => {
    expect(topInAppFrame(undefined)).toBeUndefined();
    expect(topInAppFrame("Error\n    at node:internal/process:1:1\n    at <anonymous>")).toBeUndefined();
  });
});

describe("sdkErrorFingerprint", () => {
  test("the same error from another build or another id is one group", () => {
    const a = sdkErrorFingerprint({ message: "Order 12 failed", stack: "Error\n    at pay (https://x/assets/pay-AbCdEf12.js:10:2)" });
    const b = sdkErrorFingerprint({ message: "Order 99 failed", stack: "Error\n    at pay (https://x/assets/pay-ZyXwVu98.js:44:7)" });
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toBe(a);
  });

  test("a different frame or message is a different group", () => {
    const a = sdkErrorFingerprint({ message: "Order 12 failed", stack: "Error\n    at pay (/a.js:1:1)" });
    expect(sdkErrorFingerprint({ message: "Order 12 failed", stack: "Error\n    at refund (/a.js:1:1)" })).not.toBe(a);
    expect(sdkErrorFingerprint({ message: "Cart 12 failed", stack: "Error\n    at pay (/a.js:1:1)" })).not.toBe(a);
  });

  test("the caller's own fingerprint wins", () => {
    expect(sdkErrorFingerprint({ message: "x", fingerprint: " checkout-timeout " })).toBe("checkout-timeout");
  });
});

describe("source-specific fingerprints", () => {
  test("sentry, job and metric", () => {
    expect(sentryIssueFingerprint(4123)).toBe("sentry-4123");
    expect(jobFingerprint("  Sync Contacts ")).toBe("sync_contacts");
    expect(metricFingerprint(" mw-4 ")).toBe("mw-4");
  });
});

describe("parseStackFrame", () => {
  test("reads V8 and Gecko frames and marks the product's own code", () => {
    expect(parseStackFrame("    at save (https://app.example.com/assets/index-a1B2c3D4e5.js:10:4)")).toEqual({
      fn: "save",
      loc: "https://app.example.com/assets/index-a1B2c3D4e5.js:10:4",
      file: "/assets/index.js",
      in_app: true,
    });
    expect(parseStackFrame("at render (/srv/node_modules/react-dom/cjs/react-dom.js:1:2)")?.in_app).toBe(false);
    expect(parseStackFrame("at node:internal/process:1:1")?.in_app).toBe(false);
    expect(parseStackFrame("submit@https://app.example.com/main.js:3:9")).toMatchObject({ fn: "submit", file: "/main.js", in_app: true });
  });

  test("a message line is not a frame", () => {
    expect(parseStackFrame("TypeError: x is undefined")).toBeNull();
    expect(parseStackFrame("mail me at ada@example.com")).toBeNull();
    expect(parseStackFrame("")).toBeNull();
  });
});

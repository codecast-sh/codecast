import { describe, expect, test } from "bun:test";
import { evalsSignalFingerprint } from "./signalFingerprint";

describe("evalsSignalFingerprint", () => {
  test("names the surface and the check or freeze", () => {
    expect(evalsSignalFingerprint("title", "json")).toBe("evals:title:json");
    expect(evalsSignalFingerprint(" title ", " abc123 ")).toBe("evals:title:abc123");
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

// Real samples from codecast-web's own sdk source (2026-11-05): one Convex
// function's error, reported from different requests, browsers and builds.
describe("sdkErrorFingerprint on errors a Convex function relayed to the client", () => {
  const V8_QUERY = "    at An.queryResult (https://codecast.sh/assets/convex-Btvm0TSz.js:2:11855)\n    at ss.localQueryResult (https://codecast.sh/assets/convex-Btvm0TSz.js:2:43590)";
  const V8_QUERY_OTHER_BUILD = "    at An.queryResult (https://codecast.sh/assets/convex-CuwZpkwa.js:2:11855)\n    at ss.localQueryResult (https://codecast.sh/assets/convex-CuwZpkwa.js:2:43590)";
  const V8_ACTION = "    at ss.action (https://codecast.sh/assets/convex-Btvm0TSz.js:2:45796)\n    at async Zi (https://codecast.sh/assets/page-DPyQQBZP.js:1:30964)";
  const V8_MUTATION = "    at ss.mutation (https://codecast.sh/assets/convex-CuwZpkwa.js:2:44682)\n    at async DT (https://codecast.sh/assets/index-BH0YyVvB.js:629:106745)";
  const SAFARI_MUTATION = "j@https://codecast.sh/assets/convex-CuwZpkwa.js:1:12665\nmutation@https://codecast.sh/assets/convex-CuwZpkwa.js:2:44682\n";
  // A V8 stack starts with the message; Safari's does not.
  const v8 = (message: string, frames: string, name = "Error") => ({ message, stack: `${name}: ${message}\n${frames}` });
  const fp = sdkErrorFingerprint;

  const validator = (requestId: string, value: string) =>
    `[CONVEX Q(sessionFlowRuns:forConversation)] [Request ID: ${requestId}] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .conversation_id\nValue: "${value}"\nValidator: v.id("conversations")\n\n\n  Called by client`;
  const teamChatOff = (requestId: string, line: number) =>
    `[CONVEX M(dispatch:dispatch)] [Request ID: ${requestId}] Server Error\nUncaught ConvexError: Uncaught ConvexError: {"code":"FORBIDDEN","message":"Team chat is not enabled for this team. A team admin can turn it on under Settings → Team.","retryable":false}\n    at chatFail (../../convex/chat.ts:111:4)\n    at <anonymous> (../../convex/chat.ts:351:0)\n    at require [as require] (../../../../node_modules/.bun/@platform+flags@file+platform+packages+flags+6dfca43b22664f3d/node_modules/@platform/flags/src/guard.ts:45:13)\n    at async resolveTeamMembership (../../convex/chat.ts:351:0)\n    at async requireTeamForWrite (../../convex/chat.ts:381:38)\n    at async handler [as handler] (../../convex/chat.ts:1416:6)\n\n    at async dispatchOpenDm (../convex/dispatch.ts:${line}:45)\n    at async handler [as handler] (../convex/dispatch.ts:213:23)\n\n  Called by client`;
  const limit = (fn: string, text: string) => `[CONVEX ${fn}] [Request ID: 3fa216f2434bc638] Server Error\n${text}\n\n  Called by client`;

  test("an argument the validator refused is one group whatever value was sent (eg-2235, eg-2228, eg-2155)", () => {
    const a = fp(v8(validator("840724336f5b92b8", "lmj2gfa4b78upxm786ffa"), V8_QUERY));
    expect(fp(v8(validator("39d07d0b34fc4046", "i5yz2zt0t976fvtn52xtp"), V8_QUERY))).toBe(a);
    expect(fp(v8(validator("dbe41b2eebe7520f", "o73g9z4it236dmwj90l83"), V8_QUERY_OTHER_BUILD))).toBe(a);
    expect(fp(v8(validator("43124caab399da9c", "hyipb1ub2djtlul2laddkh"), V8_QUERY))).toBe(a);
  });

  test("the same server throw is one group from Chrome and from Safari (eg-1427, eg-1809)", () => {
    const chrome = fp(v8(teamChatOff("9453b3fc4914731c", 3206), V8_MUTATION, "ConvexError"));
    const safari = fp({ message: teamChatOff("65293c3ba5e64535", 3220), stack: SAFARI_MUTATION });
    expect(safari).toBe(chrome);
  });

  test("a function out of time or memory is one group (eg-113, eg-114, eg-1536; eg-626, eg-1132, eg-1138)", () => {
    const repos = [
      "Function execution timed out (maximum duration: 3s)",
      "JavaScript execution ran out of memory (maximum memory usage: 64 MB): request stream size was 0 bytes",
      "JavaScript execution ran out of memory (maximum memory usage: 64 MB)",
    ].map((t) => fp(v8(limit("Q(repos:listRepositories)", t), V8_QUERY)));
    expect(new Set(repos).size).toBe(1);
    const org = [
      "Uncaught Error: Function execution timed out (maximum duration: 3s)",
      "Uncaught Error: JavaScript execution ran out of memory (maximum memory usage: 64 MB): request stream size was 0 bytes",
      "Uncaught Error: JavaScript execution ran out of memory (maximum memory usage: 64 MB)",
    ].map((t) => fp(v8(limit("A(orgHealth:healthReport)", t), V8_ACTION)));
    expect(new Set(org).size).toBe(1);
  });

  test("different functions stay apart, with the same server error", () => {
    const timeout = "Function execution timed out (maximum duration: 3s)";
    expect(fp(v8(limit("Q(repos:listRepositories)", timeout), V8_QUERY))).not.toBe(fp(v8(limit("Q(repos:get)", timeout), V8_QUERY)));
    expect(fp(v8(validator("840724336f5b92b8", "lmj2gfa4b78upxm786ffa").replace("sessionFlowRuns:forConversation", "sessionFlowRuns:forTask"), V8_QUERY))).not.toBe(
      fp(v8(validator("840724336f5b92b8", "lmj2gfa4b78upxm786ffa"), V8_QUERY)),
    );
  });

  test("different errors of one function stay apart (dispatch:dispatch: eg-1139, eg-1427, eg-2039, eg-2118, eg-2236)", () => {
    const dispatch = (text: string) => `[CONVEX M(dispatch:dispatch)] [Request ID: 26fe5b1951bd5a62] Server Error\n${text}\n\n  Called by client`;
    const errors = [
      'Uncaught ConvexError: {"code":"UNAUTHENTICATED","message":"Not authenticated","retryable":true}\n    at handler [as handler] (../convex/dispatch.ts:194:30)',
      'Uncaught ConvexError: Uncaught ConvexError: {"code":"INVALID","message":"Message is longer than 8000 characters","retryable":false}\n    at chatFail (../../convex/chat.ts:111:4)\n    at handler [as handler] (../../convex/chat.ts:2436:77)',
      "Uncaught Error: Only the person whose session asked can answer an Ask first decision\n    at applyPatches (../convex/dispatch.ts:389:8)",
      "Uncaught Error: Value is too large (2.25 MiB > maximum size 1 MiB)\n    at async insert [as insert] (../../convex/changeLog.ts:225:25)",
    ].map((t) => fp(v8(dispatch(t), V8_MUTATION, "ConvexError")));
    errors.push(fp(v8(teamChatOff("9453b3fc4914731c", 3206), V8_MUTATION, "ConvexError")));
    expect(new Set(errors).size).toBe(errors.length);
    // The same message thrown from another server site is another group.
    const at = (frame: string) => fp(v8(dispatch(`Uncaught Error: boom\n    at ${frame} (../convex/dispatch.ts:1:1)`), V8_MUTATION));
    expect(at("applyPatches")).not.toBe(at("sendMessage"));
  });
});

import { test, expect, describe } from "bun:test";
import {
  parseEntityUrl,
  isConvexId,
  buildEntityUrl,
  inferEntityTypeFromShortId,
  normalizeEntityType,
  entityRoute,
  entityTypeFromId,
  isEntityId,
  entityMentionRegex,
  bareEntityIdRegex,
  truncateEntityLabel,
  entityReferenceLabel,
} from "./entityLinks";

describe("isConvexId", () => {
  test("accepts a full 32-char Convex id", () => {
    expect(isConvexId("mh73xedd7ep2nmr082mqnxts2x86kzfy")).toBe(true);
    expect(isConvexId("jx75sqw53801qvexsvem39mbhh88c8wt")).toBe(true);
  });

  test("rejects a non-32-char id that the old >=20 heuristic wrongly accepted", () => {
    // 21 chars: long enough to pass the retired length>=20 test, but not a real
    // Convex id. Handing this to ctx.db.get throws "Invalid ID length 21" — the
    // crash this guards against. Must NOT look like a Convex id.
    expect("abcdefghij0123456789x".length).toBe(21);
    expect(isConvexId("abcdefghij0123456789x")).toBe(false);
  });

  test("rejects short ids and junk", () => {
    expect(isConvexId("ct-33527")).toBe(false);
    expect(isConvexId("pl-77")).toBe(false);
    expect(isConvexId("jx75sqw")).toBe(false);
    expect(isConvexId("")).toBe(false);
    expect(isConvexId("MH73XEDD7EP2NMR082MQNXTS2X86KZFY")).toBe(false); // uppercase
    expect(isConvexId("mh73xedd7ep2nmr082mqnxts2x86kzf")).toBe(false); // 31 chars
  });

  test("rejects a session UUID (optimistic-stub conversation id)", () => {
    // A freshly-created conversation renders from an optimistic stub keyed by its
    // session UUID until the server row syncs back. The collab queries validate
    // v.id("conversations"), so the CollabComposer/CollabRequestBanner guards on
    // isConvexId to skip while the id is still this UUID — otherwise the dashed
    // value crashes the whole Conversation view at arg validation.
    expect(isConvexId("3bb57a15-7619-4189-8349-b319813e224b")).toBe(false);
  });
});

describe("parseEntityUrl", () => {
  const CONVEX_ID = "mh73xedd7ep2nmr082mqnxts2x86kzfy";

  test("absolute production task URL (full Convex id) → task", () => {
    expect(parseEntityUrl(`https://codecast.sh/tasks/${CONVEX_ID}`)).toEqual({
      type: "task",
      id: CONVEX_ID,
    });
  });

  test("recognizes every entity route", () => {
    expect(parseEntityUrl(`https://codecast.sh/plans/${CONVEX_ID}`)?.type).toBe("plan");
    expect(parseEntityUrl(`https://codecast.sh/conversation/${CONVEX_ID}`)?.type).toBe("session");
    expect(parseEntityUrl(`https://codecast.sh/sessions/${CONVEX_ID}`)?.type).toBe("session");
    expect(parseEntityUrl(`https://codecast.sh/docs/${CONVEX_ID}`)?.type).toBe("doc");
    expect(parseEntityUrl(`https://codecast.sh/projects/${CONVEX_ID}`)?.type).toBe("project");
  });

  test("short ids keep their original form", () => {
    expect(parseEntityUrl("https://codecast.sh/tasks/ct-33527")).toEqual({ type: "task", id: "ct-33527" });
    expect(parseEntityUrl("https://codecast.sh/plans/pl-77")).toEqual({ type: "plan", id: "pl-77" });
  });

  test("path-only hrefs work and drop query/hash", () => {
    expect(parseEntityUrl(`/tasks/${CONVEX_ID}`)).toEqual({ type: "task", id: CONVEX_ID });
    expect(parseEntityUrl(`/tasks/${CONVEX_ID}?focus=1#msg-1`)).toEqual({ type: "task", id: CONVEX_ID });
  });

  test("dev and localhost origins are recognized", () => {
    expect(parseEntityUrl(`https://local.codecast.sh/tasks/${CONVEX_ID}`)?.type).toBe("task");
    expect(parseEntityUrl(`http://localhost:3000/tasks/${CONVEX_ID}`)?.type).toBe("task");
  });

  test("non-entity app paths are left alone", () => {
    expect(parseEntityUrl("https://codecast.sh/settings/profile")).toBeNull();
    expect(parseEntityUrl("https://codecast.sh/login")).toBeNull();
    expect(parseEntityUrl("https://codecast.sh/share/abc123")).toBeNull();
    expect(parseEntityUrl("https://codecast.sh/tasks")).toBeNull(); // list, no id
  });

  test("foreign hosts never become pills", () => {
    expect(parseEntityUrl(`https://evil.com/tasks/${CONVEX_ID}`)).toBeNull();
    expect(parseEntityUrl("https://github.com/ashot/codecast")).toBeNull();
    // host that merely contains the string but isn't ours
    expect(parseEntityUrl(`https://codecast.sh.evil.com/tasks/${CONVEX_ID}`)).toBeNull();
  });

  test("other protocols and junk return null", () => {
    expect(parseEntityUrl("mailto:ashot@example.com")).toBeNull();
    expect(parseEntityUrl("entity://ct-1")).toBeNull();
    expect(parseEntityUrl("")).toBeNull();
    expect(parseEntityUrl(undefined)).toBeNull();
    expect(parseEntityUrl("not a url")).toBeNull();
  });
});

describe("buildEntityUrl", () => {
  const CONVEX_ID = "mh73xedd7ep2nmr082mqnxts2x86kzfy";

  test("each entity type maps to its public route", () => {
    expect(buildEntityUrl("task", "ct-37187")).toBe("https://codecast.sh/tasks/ct-37187");
    expect(buildEntityUrl("plan", "pl-42")).toBe("https://codecast.sh/plans/pl-42");
    expect(buildEntityUrl("session", CONVEX_ID)).toBe(`https://codecast.sh/conversation/${CONVEX_ID}`);
    expect(buildEntityUrl("doc", CONVEX_ID)).toBe(`https://codecast.sh/docs/${CONVEX_ID}`);
    expect(buildEntityUrl("project", "proj-1")).toBe("https://codecast.sh/projects/proj-1");
  });

  test("accepts url-segment aliases and a custom base (trailing slash trimmed)", () => {
    expect(buildEntityUrl("conversation", CONVEX_ID)).toBe(`https://codecast.sh/conversation/${CONVEX_ID}`);
    expect(buildEntityUrl("tasks", "ct-1", "http://localhost:3000/")).toBe("http://localhost:3000/tasks/ct-1");
  });

  test("round-trips with parseEntityUrl", () => {
    const url = buildEntityUrl("task", CONVEX_ID)!;
    expect(parseEntityUrl(url)).toEqual({ type: "task", id: CONVEX_ID });
  });

  test("unknown type yields null", () => {
    expect(buildEntityUrl("widget", "x")).toBeNull();
  });
});

describe("inferEntityTypeFromShortId", () => {
  test("recognizes ct-/pl- prefixes, nothing else", () => {
    expect(inferEntityTypeFromShortId("ct-37187")).toBe("task");
    expect(inferEntityTypeFromShortId("pl-42")).toBe("plan");
    // 7-char session short ids and full Convex ids have no distinguishing prefix.
    expect(inferEntityTypeFromShortId("jx70ntf")).toBeNull();
    expect(inferEntityTypeFromShortId("mh73xedd7ep2nmr082mqnxts2x86kzfy")).toBeNull();
    expect(inferEntityTypeFromShortId("")).toBeNull();
  });
});

describe("normalizeEntityType", () => {
  test("canonical types and aliases normalize; junk is null", () => {
    expect(normalizeEntityType("session")).toBe("session");
    expect(normalizeEntityType("conversation")).toBe("session");
    expect(normalizeEntityType("tasks")).toBe("task");
    expect(normalizeEntityType("docs")).toBe("doc");
    expect(normalizeEntityType("widget")).toBeNull();
  });
});

const A_CONVEX_ID = "mh73xedd7ep2nmr082mqnxts2x86kzfy";

describe("triggers as first-class referenceable objects", () => {
  // Regression: a trigger id in agent prose rendered as a raw 32-char blob
  // (`Trigger \`rx72qtvpbmmrmwcjqmhzawejsx8bq9gm\` marked complete`) because the
  // trigger type was never registered here — no short-id prefix, no route, no
  // url segment. Everything below is what registering it must buy.

  test("tr- short ids resolve to the trigger type", () => {
    expect(inferEntityTypeFromShortId("tr-42")).toBe("trigger");
    expect(inferEntityTypeFromShortId("TR-42")).toBe("trigger");
    expect(entityTypeFromId("tr-42")).toBe("trigger");
  });

  test("a trigger routes to its detail page", () => {
    expect(entityRoute("trigger", "tr-42")).toBe("/triggers/tr-42");
    expect(buildEntityUrl("trigger", "tr-42")).toBe("https://codecast.sh/triggers/tr-42");
  });

  test("a trigger url round-trips back to { type, id }", () => {
    expect(parseEntityUrl("https://codecast.sh/triggers/tr-42")).toEqual({
      type: "trigger",
      id: "tr-42",
    });
    // Legacy ?task= links (pre-detail-page) still resolve, in both spellings.
    expect(parseEntityUrl("https://codecast.sh/triggers?task=tr-42")).toEqual({
      type: "trigger",
      id: "tr-42",
    });
    // The gear-verb deep link from the inbox uses the full Convex id.
    expect(parseEntityUrl(`/triggers?task=${A_CONVEX_ID}`)).toEqual({
      type: "trigger",
      id: A_CONVEX_ID,
    });
    // Pre-rename alias still resolves.
    expect(parseEntityUrl("/schedules?task=tr-7")).toEqual({ type: "trigger", id: "tr-7" });
    expect(parseEntityUrl("/schedules/tr-7")).toEqual({ type: "trigger", id: "tr-7" });
    // The bare list page addresses no single object.
    expect(parseEntityUrl("/triggers")).toBeNull();
  });

  test("query-addressed parsing does not swallow path-addressed types", () => {
    expect(parseEntityUrl("/tasks/ct-1?from=inbox")).toEqual({ type: "task", id: "ct-1" });
    expect(parseEntityUrl("/tasks")).toBeNull();
  });
});

describe("entityTypeFromId", () => {
  test("types every id shape that carries its own type", () => {
    expect(entityTypeFromId("ct-4102")).toBe("task");
    expect(entityTypeFromId("pl-88")).toBe("plan");
    expect(entityTypeFromId("tr-42")).toBe("trigger");
    expect(entityTypeFromId("jx7c6zk")).toBe("session");
    expect(entityTypeFromId(`doc:${A_CONVEX_ID}`)).toBe("doc");
  });

  test("a bare Convex id carries no type and must be resolved server-side", () => {
    // A Convex id can even start with "jx" — prefix sniffing would call it a
    // session and query the wrong table.
    expect(entityTypeFromId(A_CONVEX_ID)).toBeNull();
    expect(entityTypeFromId("jx75sqw53801qvexsvem39mbhh88c8wt")).toBeNull();
  });
});

describe("isEntityId", () => {
  test("accepts every registered handle", () => {
    for (const id of ["ct-4102", "pl-88", "tr-42", "jx7c6zk", A_CONVEX_ID]) {
      expect(isEntityId(id)).toBe(true);
    }
  });

  test("rejects ordinary words and partial ids", () => {
    expect(isEntityId("trigger")).toBe(false);
    expect(isEntityId("tr-")).toBe(false);
    expect(isEntityId("hello world")).toBe(false);
    expect(isEntityId("")).toBe(false);
  });
});

describe("entityMentionRegex", () => {
  test("captures the title and id of an @[Title id] mention", () => {
    const m = entityMentionRegex().exec("see @[Growth audit tr-42] for details");
    expect(m?.[1]).toBe("Growth audit");
    expect(m?.[2]).toBe("tr-42");
  });

  test("returns a fresh regex each call, so callers cannot poison lastIndex", () => {
    const a = entityMentionRegex();
    a.exec("@[One ct-1] @[Two ct-2]");
    expect(a.lastIndex).toBeGreaterThan(0);
    expect(entityMentionRegex().lastIndex).toBe(0);
  });

  test("requireId skips a bare @[Name] person mention", () => {
    expect(entityMentionRegex({ requireId: true }).test("hi @[Ashot]")).toBe(false);
    expect(entityMentionRegex().test("hi @[Ashot]")).toBe(true);
  });
});

describe("bareEntityIdRegex", () => {
  test("finds every object handle in a sentence", () => {
    const text = "Filed ct-4102 under pl-88, trigger tr-42 fires hourly; see jx7c6zk.";
    expect(text.match(bareEntityIdRegex())).toEqual(["ct-4102", "pl-88", "tr-42", "jx7c6zk"]);
  });

  test("does not match a word that merely starts with a prefix", () => {
    expect("the transaction triggered a plan".match(bareEntityIdRegex())).toBeNull();
  });
});

describe("truncateEntityLabel", () => {
  test("leaves an ordinary title alone", () => {
    expect(truncateEntityLabel("Retry queue for failed webhooks")).toBe(
      "Retry queue for failed webhooks",
    );
  });

  test("leaves a title alone when clipping would save a character or two", () => {
    // 42 chars — over the 40 budget, but clipping it buys nothing and costs a
    // word, so it stays whole.
    const title = "Move every customer to the new webhook API";
    expect(title.length).toBeGreaterThan(40);
    expect(truncateEntityLabel(title)).toBe(title);
  });

  test("clips a long title on a word boundary", () => {
    expect(
      truncateEntityLabel("Rewrite the delivery pipeline so queued sends survive a restart"),
    ).toBe("Rewrite the delivery pipeline so queued…");
  });

  test("clips mid-word rather than collapsing to almost nothing", () => {
    // The only space inside the budget sits at index 3. Breaking there would
    // leave "Fix…", which names nothing — so the mid-word cut stands instead.
    const title = "Fix theincrediblylongidentifierwithnobreaksatall in the parser";
    const label = truncateEntityLabel(title);
    expect(label).toBe(title.slice(0, 40) + "…");
    expect(label.startsWith("Fix theincredibly")).toBe(true);
  });
});

describe("entityReferenceLabel", () => {
  test("prefers the title", () => {
    expect(
      entityReferenceLabel({ title: "Billing migration", shortId: "pl-88", rawId: "pl-88" }),
    ).toBe("Billing migration");
  });

  test("falls back to the short id while the row is unresolved", () => {
    expect(entityReferenceLabel({ title: null, shortId: null, rawId: "ct-38940" })).toBe("ct-38940");
  });

  test("never shows a raw 32-char Convex id", () => {
    const blob = "mh73xedd7ep2nmr082mqnxts2x86kzfy";
    expect(entityReferenceLabel({ rawId: blob, typeLabel: "Task" })).toBe("Task");
  });

  test("an empty title is not a title", () => {
    expect(entityReferenceLabel({ title: "   ", shortId: "ct-7", rawId: "ct-7" })).toBe("ct-7");
  });
});

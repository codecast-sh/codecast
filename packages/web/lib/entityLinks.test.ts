import { test, expect, describe } from "bun:test";
import {
  parseEntityUrl,
  isConvexId,
  buildEntityUrl,
  inferEntityTypeFromShortId,
  normalizeEntityType,
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

import { test, expect, describe } from "bun:test";
import { parseEntityUrl } from "./entityLinks";

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

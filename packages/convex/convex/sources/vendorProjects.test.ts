import { describe, expect, test } from "bun:test";
import { takenBy } from "./vendorProjects";

describe("takenBy", () => {
  test("a Sentry source naming no projects reads them all", () => {
    expect(takenBy("sentry", { id: "1", slug: "web" }, [{ name: "sentry", projects: [], project_id: null }])).toBe("sentry");
  });
  test("a Sentry source names projects by slug or id", () => {
    const reads = [{ name: "errors", projects: ["api", "42"], project_id: null }];
    expect(takenBy("sentry", { id: "7", slug: "api" }, reads)).toBe("errors");
    expect(takenBy("sentry", { id: "42", slug: "web" }, reads)).toBe("errors");
    expect(takenBy("sentry", { id: "8", slug: "mobile" }, reads)).toBeUndefined();
  });
  test("a PostHog source without a project reads the connection's", () => {
    const reads = [{ name: "union-posthog", projects: [], project_id: null }];
    expect(takenBy("posthog", { id: "12" }, reads, "12")).toBe("union-posthog");
    expect(takenBy("posthog", { id: "13" }, reads, "12")).toBeUndefined();
  });
});

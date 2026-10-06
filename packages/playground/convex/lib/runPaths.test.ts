import { describe, expect, test } from "bun:test";
import { ENTRY_PATH } from "./files";
import { livePath, runRoute, versionPath } from "./runPaths";
import { SDK_PATH } from "./runtime";

describe("runRoute", () => {
  test("the SDK", () => {
    expect(runRoute(SDK_PATH)).toEqual({ kind: "sdk" });
  });

  test("a version folder serves its index.html", () => {
    expect(runRoute("/run/frog-choir-k3x9/v/12/")).toEqual({ kind: "file", slug: "frog-choir-k3x9", number: 12, path: ENTRY_PATH });
  });

  test("a folder without its slash redirects to it, so relative paths resolve", () => {
    expect(runRoute("/run/frog-choir-k3x9/v/12")).toEqual({ kind: "folder", location: "/run/frog-choir-k3x9/v/12/" });
  });

  test("files, nested and percent-encoded", () => {
    expect(runRoute("/run/a-b2c3/v/1/src/App.jsx")).toEqual({ kind: "file", slug: "a-b2c3", number: 1, path: "src/App.jsx" });
    expect(runRoute("/run/a-b2c3/v/1/src%2FApp.jsx")).toEqual({ kind: "file", slug: "a-b2c3", number: 1, path: "src/App.jsx" });
  });

  test("live, with or without the slash", () => {
    expect(runRoute("/run/a-b2c3/live")).toEqual({ kind: "live", slug: "a-b2c3" });
    expect(runRoute("/run/a-b2c3/live/")).toEqual({ kind: "live", slug: "a-b2c3" });
    expect(runRoute("/run/a-b2c3/live/src/App.jsx")).toBeNull();
  });

  test("refuses anything a version cannot hold or a URL should not name", () => {
    for (const bad of [
      "/run/",
      "/run/Bad_Slug/v/1/",
      "/run/a-b2c3/v/0/",
      "/run/a-b2c3/v/012/",
      "/run/a-b2c3/v/v1/",
      "/run/a-b2c3/v/1234567/",
      "/run/a-b2c3/x/1/",
      "/run/a-b2c3/v/1/../secret.js",
      "/run/a-b2c3/v/1/%2e%2e/x.js",
      "/run/a-b2c3/v/1/./src/App.jsx",
      "/run/a-b2c3/v/1/.env",
      "/run/a-b2c3/v/1/src/",
      "/run/a-b2c3/v/1/x.exe",
      "/run/a-b2c3/v/1/%E0%A4%A",
      "/elsewhere/a-b2c3/v/1/",
    ]) {
      expect(runRoute(bad)).toBeNull();
    }
  });

  test("the URL builders round-trip through the parser", () => {
    expect(runRoute(versionPath("frog-k3x9", 3, "src/styles.css"))).toEqual({ kind: "file", slug: "frog-k3x9", number: 3, path: "src/styles.css" });
    expect(runRoute(versionPath("frog-k3x9", 3))).toEqual({ kind: "file", slug: "frog-k3x9", number: 3, path: ENTRY_PATH });
    expect(runRoute(livePath("frog-k3x9"))).toEqual({ kind: "live", slug: "frog-k3x9" });
  });
});

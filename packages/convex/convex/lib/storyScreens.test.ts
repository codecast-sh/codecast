import { describe, expect, test } from "bun:test";
import { STORY_SCREENS, screensOf } from "./storyScreens";

const img = (url: string, timestamp: number, context = "") => ({ url, timestamp, context, origin: "captured during the work" as const });

describe("screensOf", () => {
  test("takes screenshots and pages from sessions the team sees in full, oldest first, each once", () => {
    const screens = screensOf([
      { mode: "full", media: { images: [img("s2", 20, "the new header"), img("s1", 10)], edits: [], artifacts: [{ kind: "page", url: "https://codecast.sh/a/report", title: "Report", timestamp: 15 }, { kind: "canvas", block: "x", title: "", timestamp: 16 }] } },
      { mode: "full", media: { images: [img("s1", 30)], edits: [] } },
      { mode: "summary", media: { images: [img("hidden", 5)], edits: [] } },
      { mode: "full" },
    ]);
    expect(screens).toEqual([
      { kind: "image", url: "s1", at: 10 },
      { kind: "page", url: "https://codecast.sh/a/report", at: 15, caption: "Report" },
      { kind: "image", url: "s2", at: 20, caption: "the new header" },
    ]);
  });

  test("keeps the newest when the sessions made more than a story holds", () => {
    const many = Array.from({ length: STORY_SCREENS + 3 }, (_, i) => img(`s${i}`, i));
    const screens = screensOf([{ mode: "full", media: { images: many, edits: [] } }]);
    expect(screens.length).toBe(STORY_SCREENS);
    expect(screens[0].url).toBe("s3");
  });
});

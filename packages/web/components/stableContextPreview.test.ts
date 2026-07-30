import { describe, expect, test } from "bun:test";
import {
  resolveStableContextPreview,
  selectStableContextPreviewItems,
  stableContextPreviewFeedParams,
} from "./stableContextPreview";

describe("stable-context preview parity", () => {
  test("an explicit mode preserves the device's global scope", () => {
    expect(resolveStableContextPreview("solo", "team", true)).toEqual({
      effectiveMode: "solo",
      globalScope: true,
    });
    expect(resolveStableContextPreview("team", "solo", false)).toEqual({
      effectiveMode: "team",
      globalScope: false,
    });
  });

  test("auto uses both device mode and scope", () => {
    expect(resolveStableContextPreview(undefined, "team", true)).toEqual({
      effectiveMode: "team",
      globalScope: true,
    });
  });

  test("over-fetches by exclusions just like the CLI builder", () => {
    const now = Date.UTC(2026, 6, 30, 18, 42);
    expect(stableContextPreviewFeedParams("team", undefined, 3, now)).toEqual({
      limit: 18,
      start_time: Date.UTC(2026, 6, 16, 18, 42),
    });
    expect(stableContextPreviewFeedParams("solo", "/repo", 50, now)).toEqual({
      limit: 30,
      start_time: Date.UTC(2026, 6, 23, 18, 42),
      project_path: "/repo",
    });
  });

  test("never previews extra included rows when exclusions are stale", () => {
    const items = Array.from({ length: 13 }, (_, index) => ({
      id: `jx${String(index).padStart(5, "0")}full`,
      title: `Session ${index}`,
    }));

    expect(
      selectStableContextPreviewItems(items, "solo", ["jxstale"],),
    ).toEqual(items.slice(0, 10));
  });

  test("shows excluded candidates while replacing them up to the injection limit", () => {
    const items = Array.from({ length: 13 }, (_, index) => ({
      id: `jx${String(index).padStart(5, "0")}full`,
      title: `Session ${index}`,
    }));
    const selected = selectStableContextPreviewItems(
      items,
      "solo",
      [items[1].id, items[4].id],
    );

    expect(selected).toEqual(items.slice(0, 12));
    expect(
      selected.filter(
        (item) => item.id !== items[1].id && item.id !== items[4].id,
      ),
    ).toHaveLength(10);
  });
});

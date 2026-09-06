import { describe, expect, test } from "bun:test";
import { RELATED_DOC_WINDOW_MS, docRelatesToTask } from "./relatedDocs";

const HOUR = 60 * 60 * 1000;
const task = { short_id: "ct-49328", created_at: 100 * HOUR };

describe("docRelatesToTask", () => {
  test("a doc written in the same sitting as the filing belongs to the task", () => {
    expect(docRelatesToTask({ created_at: task.created_at - HOUR }, task)).toBe(true);
    expect(docRelatesToTask({ created_at: task.created_at + RELATED_DOC_WINDOW_MS }, task)).toBe(true);
  });

  test("the rest of a long-lived session's journal does not", () => {
    expect(docRelatesToTask({ created_at: task.created_at - 30 * 24 * HOUR }, task)).toBe(false);
    expect(docRelatesToTask({ created_at: task.created_at - RELATED_DOC_WINDOW_MS - 1 }, task)).toBe(false);
  });

  test("an old doc the session revisited while filing counts", () => {
    expect(docRelatesToTask({ created_at: 1, updated_at: task.created_at + HOUR }, task)).toBe(true);
  });

  test("naming the task in the body relates a doc from any time", () => {
    expect(docRelatesToTask({ created_at: 1, content: "Full analysis on ct-49328." }, task)).toBe(true);
    expect(docRelatesToTask({ created_at: 1, content: "Full analysis on ct-38706." }, task)).toBe(false);
  });

  test("a task with no filing time keeps every doc of its session", () => {
    expect(docRelatesToTask({ created_at: 1 }, { short_id: "ct-1" })).toBe(true);
  });

  test("the window is tunable", () => {
    expect(docRelatesToTask({ created_at: task.created_at - 2 * HOUR }, task, HOUR)).toBe(false);
  });
});

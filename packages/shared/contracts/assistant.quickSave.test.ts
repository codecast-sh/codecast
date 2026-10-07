import { describe, expect, test } from "bun:test";
import { QUICK_SAVE_NOTE_CHARS, turnIsQuickSave } from "./assistant";

describe("turnIsQuickSave", () => {
  const todo = { name: "create_task", input: { title: "Buy stamps" } };

  test("a to-do added with a short reply is a quick save", () => {
    expect(turnIsQuickSave([todo], "Added \"Buy stamps\" to your to-dos.")).toBe(true);
  });

  test("looking around first keeps it a quick save, but looking alone is not one", () => {
    expect(turnIsQuickSave([{ name: "list_tasks", input: "{}" }, todo], "Added it.")).toBe(true);
    expect(turnIsQuickSave([{ name: "list_tasks", input: "{}" }], "You have three to-dos.")).toBe(false);
  });

  test("a reply that asks, runs long or holds a table stays new", () => {
    expect(turnIsQuickSave([todo], "Added it. Want a reminder too?")).toBe(false);
    expect(turnIsQuickSave([todo], "Added it. ".repeat(40))).toBe(false);
    expect(turnIsQuickSave([todo], "Added it.\n\n| Item | Qty |\n| --- | --- |")).toBe(false);
  });

  test("a long note is the content the person asked for", () => {
    const short = { name: "write_doc", input: JSON.stringify({ title: "Gift ideas", content: "scarf, book" }) };
    const long = { name: "write_doc", input: { title: "Packing", content: "x".repeat(QUICK_SAVE_NOTE_CHARS + 1) } };
    expect(turnIsQuickSave([short], "Saved a note with your gift ideas.")).toBe(true);
    expect(turnIsQuickSave([long], "Saved your packing list as a note.")).toBe(false);
  });

  test("any other tool, or no call at all, is an answer", () => {
    expect(turnIsQuickSave([todo, { name: "search_web", input: {} }], "Added it.")).toBe(false);
    expect(turnIsQuickSave([], "Hello.")).toBe(false);
  });
});

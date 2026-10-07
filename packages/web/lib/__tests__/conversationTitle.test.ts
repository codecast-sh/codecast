import { describe, expect, test } from "bun:test";
import { conversationTitle, ownTitle } from "../conversationTitle";
import { sessionCardTitle } from "../sessionCard";

const HOSTED = "codecast";

describe("one name for a hosted conversation", () => {
  // The rail reads the inbox row, the header reads the conversation row; a
  // row carrying both a title and a short tab label gives both the title.
  const row = { agent_type: HOSTED, title: "Vitamin reminder", short_title: "Vitamins", last_user_message: "Every weekday at 7am remind me" };

  test("rail and header agree", () => {
    expect(sessionCardTitle(row)).toBe("Vitamin reminder");
    expect(conversationTitle({ title: row.title, last_user_message: row.last_user_message })).toBe("Vitamin reminder");
  });

  test("a store home without short_title still gives the same name", () => {
    const { short_title: _drop, ...sessionRow } = row;
    expect(sessionCardTitle(sessionRow)).toBe(sessionCardTitle(row));
  });

  test("short_title stands in only when there is no title", () => {
    expect(ownTitle({ short_title: "Vitamins" })).toBe("Vitamins");
    expect(ownTitle({ title: "New session", short_title: "" })).toBe("");
  });

});

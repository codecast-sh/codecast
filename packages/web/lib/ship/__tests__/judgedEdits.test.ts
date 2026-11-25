import { describe, expect, test } from "bun:test";
import { editedPaths, judgedEdits, saysShip, typedShip } from "../judgedEdits";

const call = (name: string, input: Record<string, unknown>) => ({ tool_calls: [{ name, input: JSON.stringify(input) }] });

describe("judged edits for Ship's confirm", () => {
  const messages = [
    call("Edit", { file_path: "/repo/outreach/line/change/land.cast" }),
    call("Write", { file_path: "/repo/docs/a.md" }),
    call("Read", { file_path: "/repo/outreach/deploy.sh" }),
    call("Edit", { file_path: "/elsewhere/outreach/deploy.sh" }),
    call("Edit", { file_path: "/repo/outreach/line/change/land.cast" }),
  ];
  test("edit and write calls inside the checkout, relative, once each; reads and other checkouts are not edits", () => {
    expect(editedPaths(messages, "/repo")).toEqual(["docs/a.md", "outreach/line/change/land.cast"]);
  });
  test("only the paths the judges cover, and nothing when the repository is not opted in", () => {
    expect(judgedEdits(messages, "/repo", ["outreach/line/change/", "outreach/deploy.sh"])).toEqual(["outreach/line/change/land.cast"]);
    expect(judgedEdits(messages, "/repo", null)).toBeNull();
    expect(judgedEdits([call("Edit", { file_path: "/repo/outreach/package.json" })], "/repo", ["package.json#scripts"])).toEqual(["outreach/package.json"]);
  });
});

describe("a typed ship", () => {
  test("ship alone on the line, the newest thing a person typed", () => {
    expect(["ship", "Ship it!", "yes, ship this", "ship that."].every(saysShip)).toBe(true);
    expect(["ship it once CI is green", "don't ship", "shipping"].some(saysShip)).toBe(false);
    expect(typedShip([{ _id: "1", role: "user", content: "ship it" }, { _id: "2", role: "assistant", content: "on it" }])).toBe("1");
    expect(typedShip([{ _id: "1", role: "user", content: "ship it" }, { _id: "3", role: "user", content: "wait" }])).toBeNull();
  });
});

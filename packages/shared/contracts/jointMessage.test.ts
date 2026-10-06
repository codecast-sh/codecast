import { describe, expect, test } from "bun:test";
import { formatJointMessage, jointAuthors, jointPartsOf, parseJointMessage } from "./jointMessage";
import { formatUserMessage } from "./machineMessages";

describe("joint messages", () => {
  test("round trips two authors in order", () => {
    const wire = formatJointMessage([{ from: "Ann", body: "fix the header" }, { from: "Bob", body: "and check mobile\n\nthanks" }]);
    expect(parseJointMessage(wire)).toEqual([{ from: "Ann", body: "fix the header" }, { from: "Bob", body: "and check mobile\n\nthanks" }]);
  });

  test("one part is a plain direct send, not a joint turn", () => {
    const wire = formatJointMessage([{ from: "Ann", body: "hi" }, { from: "Bob", body: "  " }]);
    expect(wire).toBe(formatUserMessage("Ann", "hi"));
    expect(parseJointMessage(wire)).toBeNull();
  });

  test("text outside the parts is not a joint turn", () => {
    expect(parseJointMessage(`${formatUserMessage("A", "x")}\nstray\n${formatUserMessage("B", "y")}`)).toBeNull();
    expect(parseJointMessage("plain text")).toBeNull();
  });

  test("parts of any message", () => {
    expect(jointPartsOf("do it", "Owner")).toEqual([{ from: "Owner", body: "do it" }]);
    expect(jointPartsOf(formatUserMessage("Ann", "hey"), "Owner")).toEqual([{ from: "Ann", body: "hey" }]);
    const joint = formatJointMessage([{ from: "A", body: "1" }, { from: "B", body: "2" }]);
    expect(jointPartsOf(joint, "Owner")).toHaveLength(2);
  });

  test("names the authors once each", () => {
    expect(jointAuthors([{ from: "Ann", body: "" }, { from: "Bob", body: "" }])).toBe("Ann and Bob");
    expect(jointAuthors([{ from: "Ann", body: "" }, { from: "Bob", body: "" }, { from: "Ann", body: "" }, { from: "Cy", body: "" }])).toBe("Ann, Bob and Cy");
  });
});

import { expect, test } from "bun:test";
import { nameDue, nameRequest, parseName, parseRetitle, retitleDue, retitleRequest } from "./lineRetitle";

test("a title stands while a finding it was written from is still on the problem", () => {
  expect(retitleDue("Fee email to Sefi", { title: "Fee email to Sefi", from: ["sg-1", "sg-2"] }, ["sg-2", "sg-9"])).toBeNull();
});

test("a title none of whose findings is left is renamed (ct-59239: the Sefi email over eleven fee calls)", () => {
  expect(retitleDue("Fee email to Sefi", { title: "Fee email to Sefi", from: ["sg-1"] }, ["sg-2937", "sg-2882"])).toBe("retitle");
});

test("a title with no record, or one a person or a run changed since, takes the findings on it now as its source", () => {
  expect(retitleDue("Anything", undefined, ["sg-5"])).toBe("baseline");
  expect(retitleDue("Callers keep pitching after a no", { title: "Callers miss coaching", from: ["sg-1"] }, ["sg-5"])).toBe("baseline");
  // An empty problem is not renamed: there is nothing to name it from.
  expect(retitleDue("x", { title: "x", from: ["sg-1"] }, [])).toBeNull();
});

test("the rename asks for the shared miss and reads a reply only when it fits", () => {
  const req = retitleRequest("Fee email to Sefi", [{ title: "The caller named a fee of 5 to 10 percent.", quote: "it ranges from 5 to 10" }], 11);
  expect(req.prompt).toContain("Fee email to Sefi");
  expect(req.prompt).toContain("over 11 conversations");
  expect(parseRetitle('{"title": "Callers name a fee percentage of Union\'s own.", "description": "11 calls."}')).toEqual({ title: "Callers name a fee percentage of Union's own", description: "11 calls." });
  expect(parseRetitle('{"title": "' + "x".repeat(120) + '", "description": "d"}')).toBeNull();
  expect(parseRetitle("not json")).toBeNull();
});

test("every title is named once, beside the title it names", () => {
  const long = "Not met: Call grader scored Keith Conrad's Zoom (call 0b30cb37) off a transcript missing 03:38-09:00, though the caller said so";
  expect(nameDue(long, undefined)).toBe(true);
  expect(nameDue(long, { for: long })).toBe(false);
  // A new title is named again; a short title carrying evidence is named too.
  expect(nameDue(long, { for: "an older title" })).toBe(true);
  expect(nameDue("Main CI red at ac5c98b: web tests fail", undefined)).toBe(true);
  expect(nameRequest(long).prompt).not.toContain("Not met:");
  expect(parseName('{"name": "Grader scores calls from a transcript with gaps."}')).toBe("Grader scores calls from a transcript with gaps");
  expect(parseName('{"name": "' + "x".repeat(81) + '"}')).toBeNull();
});

// The ground node and the server's ground step read one definition of what a
// cause is grounded for (docs/prompting.md P8): the node prompt carries the
// shared blocks of shared/contracts/goalsBrief verbatim.
import { describe, expect, test } from "bun:test";
import { GROUND_DATA_NOTE, GROUND_FIELDS, GROUND_PURPOSE } from "@codecast/shared/contracts/goalsBrief";
import { LINE_TEMPLATE_FILES } from "./templates";

describe("line/ground.md", () => {
  const node = LINE_TEMPLATE_FILES["line/ground.md"];
  test.each([["purpose", GROUND_PURPOSE], ["data note", GROUND_DATA_NOTE], ["fields", GROUND_FIELDS]])("carries the shared %s", (_name, block) => {
    expect(node).toContain(block);
  });
});

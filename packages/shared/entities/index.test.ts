import { describe, expect, test } from "bun:test";
import { entityRoute, inferEntityTypeFromShortId } from "./index";

describe("Steering entity routes", () => {
  test("recognizes every Steering short id", () => {
    expect(inferEntityTypeFromShortId("st-12")).toBe("strategy");
    expect(inferEntityTypeFromShortId("si-34")).toBe("steering_item");
    expect(inferEntityTypeFromShortId("sp-56")).toBe("steering_proposal");
  });

  test("routes Steering entities into the shared tab", () => {
    expect(entityRoute("strategy", "st-12")).toBe("/steering/strategy?id=st-12");
    expect(entityRoute("steering_item", "si-34")).toBe("/steering/map?id=si-34");
    expect(entityRoute("steering_proposal", "sp-56")).toBe("/steering?proposal=sp-56");
  });
});

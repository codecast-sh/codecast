// Where the map opens (line-map.md LX2): a card for the viewer, then the worst trouble, then the busiest node.
import { describe, expect, test } from "bun:test";
import type { MapNode } from "../../../../lib/line/lineMap";
import { openTarget } from "../LineMapView";
import { groupingWords } from "../../settings/LineFinders";

const node = (id: string, kind: MapNode["kind"], now: number, marks: MapNode["marks"] = []) => ({ id, kind, now: Array.from({ length: now }, () => ({})), marks }) as unknown as MapNode;

describe("openTarget", () => {
  const nodes = [node("causes", "causes", 47), node("prove", "station", 1, [{ level: "warn", words: "2 of 7 failed" }]), node("verify", "station", 0, [{ level: "fail", words: "3 of 4 failed" }]), node("decide", "decide", 0)];
  test("a card waiting on you wins", () => expect(openTarget(nodes, 1)).toBe("decide"));
  test("then the worst mark, a failure over a warning", () => expect(openTarget(nodes, 0)).toBe("verify"));
  test("then the busiest", () => expect(openTarget([node("causes", "causes", 47), node("implement", "station", 2)], 0)).toBe("causes"));
  test("nothing anywhere opens nowhere", () => expect(openTarget([node("causes", "causes", 0)], 0)).toBeNull());
});

describe("groupingWords", () => {
  test("a key pattern reads in plain words", () => expect(groupingWords("union:<key>")).toBe("groups signals that share a Union key"));
  test("anything else reads as its pattern", () => expect(groupingWords("sentry-issue")).toBe("groups signals by sentry-issue"));
});

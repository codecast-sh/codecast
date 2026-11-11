import { describe, expect, test } from "bun:test";
import { parseDocRef, parseOpsInput } from "./liveArtifactCommand";

const ID = "k17abcdefghijklmnopqrstuvwxyz012";

describe("cast board|sheet|data input", () => {
  test("a doc is an id, doc:<id>, or its page URL", () => {
    expect(parseDocRef(ID)).toBe(ID);
    expect(parseDocRef(`doc:${ID}`)).toBe(ID);
    expect(parseDocRef(`https://codecast.sh/docs/${ID}?view=minimal`)).toBe(ID);
    expect(() => parseDocRef("ct-123")).toThrow(/Not an artifact id/);
  });

  test("ops come as an array or an object with a cursor", () => {
    expect(parseOpsInput('[{"k":"el_a","del":true}]').ops).toHaveLength(1);
    const withPos = parseOpsInput('{"ops":[{"k":"el_a","set":{"x":1}}],"position":{"point":{"x":1,"y":2}},"status":"moving"}');
    expect(withPos.position).toEqual({ point: { x: 1, y: 2 } });
    expect(withPos.status).toBe("moving");
  });

  test("bad ops are refused before anything is sent", () => {
    expect(() => parseOpsInput("not json")).toThrow(/JSON/);
    expect(() => parseOpsInput('{"nope":1}')).toThrow(/array of ops/);
    expect(() => parseOpsInput('[{"k":"el_a","set":{"rev":1}}]')).toThrow(/reserved/);
  });
});

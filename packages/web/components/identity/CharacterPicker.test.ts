// The bulk policy (docs/architecture/session-characters.md S2): "a different
// face each" must actually give a squad distinct animals, and each row a name
// that belongs to the face it got.
import { describe, expect, test } from "bun:test";
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";
import { CHARACTER_NAMES } from "@codecast/shared/contracts/sessionCharacter";
import { spreadCharacters } from "./CharacterPicker";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `k97${i.toString(36)}session${(i * 7919).toString(36)}`);

describe("spreadCharacters", () => {
  test("starts at the picked face and walks the set, one animal each", () => {
    const out = spreadCharacters(ids(6), "owl");
    expect(out[0].avatar).toBe("owl");
    expect(new Set(out.map((o) => o.avatar)).size).toBe(6);
    for (const o of out) expect(CHARACTER_NAMES[o.avatar]).toContain(o.name);
  });

  test("a selection larger than the set wraps rather than running out", () => {
    const out = spreadCharacters(ids(30), AVATAR_KEYS[0]);
    expect(out).toHaveLength(30);
    expect(new Set(out.map((o) => o.avatar)).size).toBe(24);
    expect(out[24].avatar).toBe(out[0].avatar);
    // …but the wrapped rows are still distinct sessions with their own names
    expect(out[24].id).not.toBe(out[0].id);
  });

  test("the same selection and face always produce the same assignment", () => {
    const rows = ids(5);
    expect(spreadCharacters(rows, "fox")).toEqual(spreadCharacters(rows, "fox"));
  });
});

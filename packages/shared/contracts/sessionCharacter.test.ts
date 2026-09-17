import { describe, expect, test } from "bun:test";
import { AVATAR_KEYS } from "./orgAvatars";
import { ALL_CHARACTER_NAMES, CHARACTER_NAMES, characterOf, cleanCharacterName, defaultCharacterFor } from "./sessionCharacter";

describe("session characters", () => {
  test("the name bank has six distinct names per face and no name shared between faces", () => {
    expect(Object.keys(CHARACTER_NAMES).sort()).toEqual([...AVATAR_KEYS].sort());
    expect(new Set(ALL_CHARACTER_NAMES).size).toBe(AVATAR_KEYS.length * 6);
    for (const n of ALL_CHARACTER_NAMES) expect(n).toMatch(/^[A-Z][a-z]+$/);
  });
  test("the default is stable per id and spreads over faces and names", () => {
    const ids = Array.from({ length: 300 }, (_, i) => `k97${i.toString(36)}abc${(i * 7919).toString(36)}`);
    const chars = ids.map(defaultCharacterFor);
    expect(chars[0]).toEqual(defaultCharacterFor(ids[0]));
    expect(new Set(chars.map((c) => c.avatar)).size).toBe(24);
    expect(new Set(chars.map((c) => c.name)).size).toBeGreaterThan(100);
    for (const c of chars) expect(CHARACTER_NAMES[c.avatar]).toContain(c.name);
    expect(chars.every((c) => !c.chosen)).toBe(true);
  });
  test("chosen parts win over the default, each on its own", () => {
    const id = "k97xcyp74gaa0q43my0mpnvnsd8ekyj4";
    const d = defaultCharacterFor(id);
    expect(characterOf({ _id: id })).toEqual(d);
    const face = characterOf({ _id: id, character_avatar: d.avatar === "owl" ? "fox" : "owl" });
    expect(face.name).toBe(d.name);
    expect(face.chosen).toBe(true);
    const named = characterOf({ _id: id, character_name: "  Ada   Lovelace " });
    expect(named).toEqual({ avatar: d.avatar, name: "Ada Lovelace", chosen: true });
    expect(characterOf({ _id: id, character_avatar: "not-a-face", character_name: "   " })).toEqual(d);
  });
  test("names are trimmed, single spaced and capped", () => {
    expect(cleanCharacterName("  a  b ")).toBe("a b");
    expect(cleanCharacterName("x".repeat(40))?.length).toBe(24);
    expect(cleanCharacterName("")).toBeNull();
    expect(cleanCharacterName(undefined)).toBeNull();
  });
});

describe("normalizeCharacterFields", () => {
  test("keeps valid parts, clears invalid or empty ones, leaves other fields alone", async () => {
    const { normalizeCharacterFields } = await import("./sessionCharacter");
    expect(normalizeCharacterFields({ character_avatar: "owl", character_name: " Ada ", title: "x" })).toEqual({ character_avatar: "owl", character_name: "Ada", title: "x" });
    const cleared = normalizeCharacterFields({ character_avatar: "nope", character_name: null });
    expect("character_avatar" in cleared && cleared.character_avatar).toBeUndefined();
    expect(cleared.character_name).toBeUndefined();
    expect(normalizeCharacterFields({ title: "t" })).toEqual({ title: "t" });
  });
});

describe("characterNameFor", () => {
  test("is the default's name on the default face, stays in the face's bank, and nudges through all six", async () => {
    const { characterNameFor } = await import("./sessionCharacter");
    const id = "k97xcyp74gaa0q43my0mpnvnsd8ekyj4";
    const d = defaultCharacterFor(id);
    expect(characterNameFor(id, d.avatar)).toBe(d.name);
    expect(CHARACTER_NAMES.owl).toContain(characterNameFor(id, "owl"));
    const walked = new Set(Array.from({ length: 6 }, (_, i) => characterNameFor(id, "owl", i)));
    expect(walked.size).toBe(6);
  });
});

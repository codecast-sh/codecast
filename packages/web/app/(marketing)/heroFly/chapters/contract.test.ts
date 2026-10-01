import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { MOTIONS } from "../motion";
import { SCENES, SURFACE_BY_ID, type SurfaceId } from "../world";
import { EAGER_CHAPTERS, LAZY_CHAPTERS, loadAllChapters } from "./index";

// The chapter contract (README.md), checked over whatever files exist, so a
// builder's new part, beat or flyer is held to it the moment it is added.

const DIR = import.meta.dir;
const files = readdirSync(DIR);
const chapterFiles = files.filter((f) => f.endsWith(".chapter.ts")).map((f) => f.replace(/\.chapter\.ts$/, ""));
const motionFiles = files.filter((f) => f.endsWith(".motion.ts")).map((f) => f.replace(/\.motion\.ts$/, ""));
const fixtureFiles = readdirSync(join(DIR, "../fixtures")).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, ""));
const ids = SCENES.map((s) => s.id);

describe("hero chapter contract", () => {
  test("every chapter has a chapter file, a motion file and a fixtures file, and nothing else is a chapter", () => {
    expect(chapterFiles.sort()).toEqual([...ids].sort());
    expect(motionFiles.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(fixtureFiles, `fixtures/${id}.ts`).toContain(id);
  });

  test("every chapter is registered, eager or lazy, and gathered by motion.ts", () => {
    const registered = [...EAGER_CHAPTERS.map((c) => c.id), ...Object.keys(LAZY_CHAPTERS)];
    expect(registered.sort()).toEqual([...ids].sort());
    expect(Object.keys(MOTIONS).sort()).toEqual([...ids].sort());
  });

  test("each module exports its own chapter, with parts in real regions and unique keys", async () => {
    const all = await loadAllChapters();
    for (const c of all) {
      const mod = await import(`./${c.id}.chapter`);
      expect(mod.chapter, `${c.id}.chapter.ts exports chapter`).toBe(c);
      const keys = c.parts.map((p) => p.key);
      expect(new Set(keys).size, `${c.id} part keys are unique`).toBe(keys.length);
      for (const p of c.parts) {
        const [sid, name] = p.region.split(".") as [SurfaceId, string];
        expect(SURFACE_BY_ID[sid]?.regions[name], `${c.id}.${p.key} region ${p.region}`).toBeDefined();
      }
    }
  });

  test("every motion id is prefixed with its chapter, and every flyer has a renderer in its own chapter", async () => {
    const all = Object.fromEntries((await loadAllChapters()).map((c) => [c.id, c]));
    for (const [id, m] of Object.entries(MOTIONS)) {
      const prefixed = (x: string) => expect(x.startsWith(`${id}.`), `${x} starts with "${id}."`).toBe(true);
      for (const beats of Object.values(m.beats ?? {})) beats?.forEach((b) => prefixed(b.id));
      for (const texts of Object.values(m.texts ?? {})) texts?.forEach((t) => prefixed(t.id));
      m.flyers?.forEach((f) => {
        prefixed(f.id);
        expect(all[id].flyers?.[f.id], `${id} renders flyer ${f.id}`).toBeDefined();
      });
      m.arcs?.forEach((a) => prefixed(a.id));
    }
  });
});

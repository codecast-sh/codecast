import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postcss from "postcss";
import { createTailwindBuilder, tailwindInWorker } from "./tailwindWorker";

// A tiny project so a real Tailwind build takes milliseconds, not minutes.
function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-worker-"));
  fs.writeFileSync(path.join(dir, "Page.tsx"), 'export const P = () => <div className="flex tracking-[0.4242em]" />;\n');
  const configPath = path.join(dir, "tailwind.config.cjs");
  fs.writeFileSync(configPath, `module.exports = { content: [${JSON.stringify(path.join(dir, "*.tsx"))}], corePlugins: { preflight: false } };\n`);
  return { dir, configPath, from: path.join(dir, "globals.css") };
}

const SOURCE = "@tailwind utilities;\n.card { @apply flex; }\n";

describe("tailwind worker", () => {
  test("builds the classes the content uses and forwards the watch messages Vite needs", async () => {
    const { dir, configPath, from } = tmpProject();
    const build = createTailwindBuilder(configPath);
    const out = await build(SOURCE, from);
    expect(out.css).toContain("0.4242em");
    expect(out.css).toMatch(/\.card\s*\{\s*display:\s*flex/);
    expect(out.messages.some((m) => m.type === "dir-dependency" && m.dir === dir)).toBe(true);

    // An edited content file shows up in the next build.
    fs.writeFileSync(path.join(dir, "Page.tsx"), 'export const P = () => <div className="tracking-[0.4343em]" />;\n');
    expect((await build(SOURCE, from)).css).toContain("0.4343em");
  }, 60_000);

  test("requests queued behind a running build share one follow-up build of the newest source", async () => {
    const { configPath, from } = tmpProject();
    const build = createTailwindBuilder(configPath);
    const first = build(SOURCE, from);
    const second = build(SOURCE + ".a { color: red; }\n", from);
    const third = build(SOURCE + ".b { color: blue; }\n", from);
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a.css).not.toContain(".b");
    expect(b).toBe(c);
    expect(c.css).toContain(".b");
  }, 60_000);

  test("a build error reaches the caller and the next build still works", async () => {
    const { configPath, from } = tmpProject();
    const build = createTailwindBuilder(configPath);
    await expect(build(".x { @apply not-a-real-class; }\n", from)).rejects.toThrow(/not-a-real-class/);
    expect((await build(SOURCE, from)).css).toContain("0.4242em");
  }, 60_000);

  test("the PostCSS plugin leaves stylesheets without Tailwind syntax untouched", async () => {
    const { configPath, from } = tmpProject();
    const plain = ".plain { color: red; }";
    const result = await postcss([tailwindInWorker(configPath)]).process(plain, { from });
    expect(result.css).toBe(plain);
    const built = await postcss([tailwindInWorker(configPath)]).process(SOURCE, { from });
    expect(built.css).toContain("0.4242em");
  }, 60_000);
});

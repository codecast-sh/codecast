import { expect, test } from "bun:test";
import { castPlayerScriptPlugin } from "./castPlayerScript";

test("the build emits /cast-player.js as a standalone script that leaves page videos alone", () => {
  const emitted: Array<{ fileName: string; source: string }> = [];
  const plugin = castPlayerScriptPlugin();
  (plugin.generateBundle as unknown as (this: unknown) => void).call({ emitFile: (f: { fileName: string; source: string }) => emitted.push(f) });
  expect(emitted.map((f) => f.fileName)).toEqual(["cast-player.js"]);
  const source = emitted[0].source;
  expect(() => new Function(source)).not.toThrow();
  expect(source).toContain('customElements.define("cast-player"');
  expect(source.trim().endsWith('({"upgradeVideos":false});')).toBe(true);
});

import { describe, expect, test } from "bun:test";
import { BOOT_CATCHER } from "./bootCatcher";
import { servedEntry } from "./entryPage";
import { seedFiles } from "./seed";
import { ESM_RESOLVED, IMPORT_MAP, sdkPathFor } from "./runtime";

const SDK = sdkPathFor("abc123");
const files = seedFiles("Frog choir");
const html = files.find((f) => f.path === "index.html")!.text;
const page = servedEntry(html, files, SDK);
const preloads = [...page.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
const servedMap = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(page)![1]) as typeof IMPORT_MAP;

describe("an entry page is served ready to fetch everything at once", () => {
  test("the boot catcher still comes first", () => {
    expect(page.indexOf(BOOT_CATCHER)).toBeLessThan(page.indexOf("importmap"));
  });

  test("the import map points at the SDK's build and esm.sh's built files", () => {
    expect(servedMap.imports.playground).toBe(SDK);
    expect(servedMap.imports.react).toBe(ESM_RESOLVED[IMPORT_MAP.imports.react].url);
    expect(servedMap.imports["react-dom/client"]).toBe(ESM_RESOLVED[IMPORT_MAP.imports["react-dom/client"]].url);
  });

  test("every module of the version, and every mapped module it imports, is preloaded after the map", () => {
    for (const f of files.filter((f) => /\.jsx?$/.test(f.path))) expect(preloads).toContain(`./${f.path}`);
    expect(preloads).toContain(SDK);
    expect(preloads).toContain(ESM_RESOLVED[IMPORT_MAP.imports["react-dom/client"]].url);
    expect(preloads).toEqual(expect.arrayContaining(ESM_RESOLVED[IMPORT_MAP.imports["react-dom/client"]].imports));
    expect(preloads).toContain(ESM_RESOLVED[IMPORT_MAP.imports["react-dom"]].url);
    expect(page.indexOf("modulepreload")).toBeGreaterThan(page.indexOf("importmap"));
    expect(page).toContain(`<link rel="preconnect" href="https://esm.sh" crossorigin>`);
  });

  test("a mapped module nobody imports is not fetched", () => {
    const quiet = servedEntry(html, files.map((f) => (f.path === "src/main.jsx" ? { ...f, text: `import "./App.jsx";` } : f)), SDK);
    expect(quiet).not.toContain(`<link rel="modulepreload" href="${ESM_RESOLVED[IMPORT_MAP.imports["react-dom/client"]].url}">`);
    expect(quiet).toContain(`<link rel="modulepreload" href="${ESM_RESOLVED[IMPORT_MAP.imports.react].url}">`);
  });

  test("a page without a usable import map still preloads its own modules and keeps its markup", () => {
    const bare = `<html><head><title>x</title></head><body><script type="module" src="main.js"></script></body></html>`;
    const out = servedEntry(bare, [{ path: "main.js", text: "" }], SDK);
    expect(out).toContain(`<head>${BOOT_CATCHER}<link rel="modulepreload" href="./main.js">`);
    const broken = `<html><head><script type="importmap">{nope</script></head></html>`;
    expect(servedEntry(broken, [], SDK)).toContain("{nope");
  });
});

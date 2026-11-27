import { describe, expect, test } from "bun:test";
import { swapScannedOnly, type GraphNode } from "./contentOnlyHmr";

const node = (url: string, over: Partial<GraphNode> = {}): GraphNode => ({
  url,
  isSelfAccepting: false,
  importers: new Set(),
  importedModules: new Set(),
  ...over,
});

describe("swapScannedOnly", () => {
  const sheet = node("/app/globals.css", { isSelfAccepting: true });
  const page = node("/app/line/trace/[ref]/page.tsx", { isSelfAccepting: true });

  test("a file only the stylesheet scans updates the stylesheet", () => {
    const scanned = node("/components/line/trace/TraceStory.tsx", { importers: new Set([sheet]) });
    expect(swapScannedOnly([scanned])).toEqual([sheet]);
  });

  test("a loaded component is left to Vite", () => {
    const loaded = node("/components/Card.tsx", { isSelfAccepting: true, importers: new Set([sheet, page]) });
    expect(swapScannedOnly([loaded])).toBeNull();
  });

  test("a loaded hook module, which accepts nothing, is left to Vite", () => {
    const hook = node("/hooks/useThing.ts", { importers: new Set([sheet, page]), importedModules: new Set(["react"]) });
    expect(swapScannedOnly([hook])).toBeNull();
  });

  test("the entry script still reloads: scanned, no script importer, but loaded", () => {
    const entry = node("/src/boot.tsx", { importers: new Set([sheet]), importedModules: new Set(["/src/App.tsx"]) });
    expect(swapScannedOnly([entry])).toBeNull();
  });

  test("a module nothing imports is left to Vite", () => {
    expect(swapScannedOnly([node("/lib/orphan.ts")])).toBeNull();
  });
});

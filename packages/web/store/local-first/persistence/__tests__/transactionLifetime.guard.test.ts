import { describe, expect, test } from "bun:test";

describe("Dexie transaction lifetime guards", () => {
  test("fault hooks cannot yield an otherwise-idle production transaction", async () => {
    const [source, launcherSource] = await Promise.all([
      Bun.file(new URL("../dexieAdapter.ts", import.meta.url)).text(),
      Bun.file(new URL("../launcher.ts", import.meta.url)).text(),
    ]);
    const transactionSources = `${source}\n${launcherSource}`;
    const executableSource = transactionSources
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    // In real Chromium/WebKit, `await undefined` can let IndexedDB auto-commit
    // before the next request even though fake-indexeddb keeps the test
    // transaction open. Keep this source-level guard beside the behavioral
    // adapter contract so the production-only failure cannot return.
    expect(executableSource).not.toMatch(/\bawait\s+(?:undefined|null)\b/);
    expect(executableSource).not.toMatch(/\bawait\s+[\w.$]+\?\.\s*\(/);
    expect(source).toContain("if (!injectFault) return null;");
    expect(source).toContain("return pending ? Dexie.waitFor(pending) : null;");
    expect(source.match(/if \(operationFault\) await operationFault;/g)).toHaveLength(2);
    expect(source.match(/if \(headFault\) await headFault;/g)).toHaveLength(2);
  });
});

import { describe, expect, test } from "bun:test";

describe("lossy raw dispatch writers", () => {
  test("store preference, draft, and undo writers use named durable actions", async () => {
    const [storeSource, undoSource] = await Promise.all([
      Bun.file(new URL("../inboxStore.ts", import.meta.url)).text(),
      Bun.file(new URL("../undoActions.ts", import.meta.url)).text(),
    ]);

    expect(storeSource).not.toContain('._dispatch("patch"');
    expect(storeSource).not.toContain('._dispatch("clearDraft"');
    expect(undoSource).not.toContain("._dispatch(");
  });
});

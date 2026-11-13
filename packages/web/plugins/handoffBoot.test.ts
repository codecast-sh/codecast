import { describe, expect, test } from "bun:test";
import type { OutputBundle, OutputChunk } from "rollup";
import { bootChunkUrls } from "./handoffBoot";

const chunk = (fileName: string, props: Partial<OutputChunk> = {}): OutputChunk => ({
  type: "chunk", fileName, imports: [], dynamicImports: [], modules: {}, ...props,
} as OutputChunk);

describe("boot preloads", () => {
  test("preloads the merged conversation chunk without pulling in its whole graph", () => {
    const entry = chunk("main.js", { isEntry: true, dynamicImports: ["boot.js", "share.js"] });
    const bundle: OutputBundle = {
      "main.js": entry,
      "boot.js": chunk("boot.js", { imports: ["vendor.js"], dynamicImports: ["conversation.js"] }),
      "share.js": chunk("share.js", { facadeModuleId: "/web/src/shareBoot.tsx" }),
      "conversation.js": chunk("conversation.js", {
        facadeModuleId: null,
        modules: { "/web/components/ConversationDiffLayout.tsx": {} as any },
        imports: ["vendor.js", "messages.js"],
        dynamicImports: ["diagram.js"],
      }),
      "vendor.js": chunk("vendor.js"),
      "messages.js": chunk("messages.js", { imports: ["vendor.js"] }),
      "diagram.js": chunk("diagram.js"),
    };
    expect(bootChunkUrls(bundle, entry, "/app/")).toEqual({
      app: ["/app/boot.js", "/app/vendor.js"],
      share: ["/app/share.js"],
      conversation: ["/app/conversation.js"],
    });
  });
});

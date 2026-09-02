import { describe, it, expect } from "bun:test";
import { defineFeatures } from "./catalog";
import { createFeatureHooks, type FeatureSource } from "./react";

const catalog = defineFeatures([{ key: "chat", name: "Team chat", desc: "" }]);

describe("createFeatureHooks", () => {
  it("selects over the injected source", () => {
    let src: FeatureSource<"chat"> | undefined;
    const hooks = createFeatureHooks(catalog, () => src);
    expect(hooks.useFeature("chat")).toBe(false);
    expect(hooks.useFeatureState("chat")).toBeUndefined();
    src = { active: null, all: [{ features: { chat: true } }] };
    expect(hooks.useFeature("chat")).toBe(false);
    expect(hooks.useAnyFeature("chat")).toBe(true);
    expect(hooks.useFeatureState("chat")).toBe(false);
    src = { active: { features: { chat: true } }, all: [] };
    expect(hooks.useFeature("chat")).toBe(true);
  });
});

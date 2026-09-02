import { describe, it, expect } from "bun:test";
import {
  defineFeatures,
  isEnabled,
  withFlag,
  attachedAvailability,
  attachedItemAvailable,
  featureOffMessage,
  featureOffCopy,
  anyHolderHasFeature,
} from "./catalog";

const catalog = defineFeatures([
  { key: "chat", name: "Team chat", desc: "Channels.", snippets: ["chat"] },
  { key: "calls", name: "Calls", desc: "Huddles.", snippets: ["calls"] },
  { key: "beta", name: "Beta", desc: "On by default.", defaultOn: true, snippets: [] },
]);

describe("defineFeatures", () => {
  it("keeps order, keys and extra fields", () => {
    expect(catalog.keys).toEqual(["chat", "calls", "beta"]);
    expect(catalog.byKey("chat")?.snippets).toEqual(["chat"]);
    expect(catalog.nameOf("calls")).toBe("Calls");
    expect(catalog.nameOf("nope" as any)).toBe("nope");
    expect(catalog.isKey("chat")).toBe(true);
    expect(catalog.isKey("x")).toBe(false);
  });
  it("rejects duplicates", () => {
    expect(() => defineFeatures([{ key: "a", name: "", desc: "" }, { key: "a", name: "", desc: "" }])).toThrow();
  });
});

describe("isEnabled", () => {
  it("absent flag reads as the default", () => {
    expect(isEnabled(catalog, {}, "chat")).toBe(false);
    expect(isEnabled(catalog, null, "chat")).toBe(false);
    expect(isEnabled(catalog, undefined, "beta")).toBe(true);
  });
  it("stored value wins over the default", () => {
    expect(isEnabled(catalog, { chat: true }, "chat")).toBe(true);
    expect(isEnabled(catalog, { beta: false }, "beta")).toBe(false);
  });
  it("unknown key is off", () => {
    expect(isEnabled(catalog, { x: true } as any, "x" as any)).toBe(false);
  });
  it("withFlag does not mutate", () => {
    const a = { chat: true };
    const b = withFlag<"chat" | "calls">(a, "calls", true);
    expect(a).toEqual({ chat: true });
    expect(b).toEqual({ chat: true, calls: true });
  });
});

describe("fan out", () => {
  const teams = [{ features: { chat: true } }, { features: {} }, null];
  it("attachedAvailability lists every attached item", () => {
    expect(attachedAvailability(catalog, teams, (f) => f.snippets)).toEqual({ chat: true, calls: false });
  });
  it("attachedItemAvailable: ungated always, gated by any team", () => {
    expect(attachedItemAvailable(catalog, "other", teams, (f) => f.snippets)).toBe(true);
    expect(attachedItemAvailable(catalog, "chat", teams, (f) => f.snippets)).toBe(true);
    expect(attachedItemAvailable(catalog, "calls", teams, (f) => f.snippets)).toBe(false);
    expect(anyHolderHasFeature(catalog, teams, "beta")).toBe(true);
  });
});

describe("wording", () => {
  it("matches codecast", () => {
    expect(featureOffMessage(catalog, "chat")).toBe(
      "Team chat is not enabled for this team. A team admin can turn it on under Settings → Team.",
    );
    expect(featureOffMessage(catalog, "chat", { noun: "workspace", settingsPath: "Settings → Workspace" })).toBe(
      "Team chat is not enabled for this workspace. A workspace admin can turn it on under Settings → Workspace.",
    );
  });
  it("featureOffCopy", () => {
    expect(featureOffCopy(catalog, "calls", false)).toEqual({
      title: "Calls is off for this team.",
      desc: "Huddles.",
      hint: "A team admin can turn it on under Settings → Team.",
      canToggle: false,
    });
    expect(featureOffCopy(catalog, "calls", true).hint).toBe("Turn it on in team settings");
  });
});

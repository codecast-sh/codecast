import { describe, it, expect } from "bun:test";
import { defineFeatures } from "./catalog";
import { featureRefusalMessage, requireFeatureOrExit } from "./cliGuard";

const catalog = defineFeatures([{ key: "chat", name: "Team chat", desc: "" }]);

describe("featureRefusalMessage", () => {
  it("scoped: server wording", () => {
    expect(featureRefusalMessage(catalog, "chat", { scoped: true })).toBe(
      "Team chat is not enabled for this team. A team admin can turn it on under Settings → Team.",
    );
  });
  it("unscoped: pick hint, codecast form", () => {
    expect(
      featureRefusalMessage(catalog, "chat", {
        scoped: false,
        pickHint: "--team <name|id> (cast chat channels --team lists yours)",
      }),
    ).toBe("Team chat is a team feature — pick a team with --team <name|id> (cast chat channels --team lists yours).");
    expect(featureRefusalMessage(catalog, "chat", { scoped: false })).toBe(
      "Team chat is a team feature — pick a team with --team <name|id>.",
    );
  });
});

describe("requireFeatureOrExit", () => {
  const make = (scoped: boolean, on: boolean) => {
    const errs: string[] = [];
    let code: number | null = null;
    const opts = {
      catalog,
      enabled: () => on,
      scoped: () => scoped,
      writeError: (l: string) => errs.push(l),
      exit: ((c: number) => {
        code = c;
        throw new Error("exit");
      }) as (c: number) => never,
    };
    return { opts, errs, code: () => code };
  };
  it("passes when on", async () => {
    const m = make(true, true);
    await requireFeatureOrExit(m.opts, "chat");
    expect(m.errs).toEqual([]);
  });
  it("exits 1 with the message when off", async () => {
    const m = make(true, false);
    await expect(requireFeatureOrExit(m.opts, "chat")).rejects.toThrow("exit");
    expect(m.code()).toBe(1);
    expect(m.errs[0]).toContain("not enabled for this team");
  });
  it("exits with the pick message when unscoped", async () => {
    const m = make(false, true);
    await expect(requireFeatureOrExit(m.opts, "chat")).rejects.toThrow("exit");
    expect(m.errs[0]).toContain("pick a team");
  });
});

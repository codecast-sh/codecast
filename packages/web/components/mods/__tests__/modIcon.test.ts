import { describe, expect, test } from "bun:test";
import * as lucide from "lucide-react";
import dynamicIconImports from "lucide-react/dynamicIconImports";
import { modIconExportName } from "../../../lib/mods/iconName";

describe("a mod's named icon", () => {
  test("every name lucide-react/dynamic accepted draws the same icon", () => {
    const icons = lucide as unknown as Record<string, { displayName?: string } | undefined>;
    const names = Object.keys(dynamicIconImports);
    expect(names.length).toBeGreaterThan(1000);
    expect(names.filter((name) => !icons[modIconExportName(name)])).toEqual([]);
    expect(modIconExportName("arrow-down-0-1")).toBe("LucideArrowDown01");
    expect(icons[modIconExportName("hard-drive")]).toBe(icons.HardDrive);
  });

  test("a name that is no icon finds nothing", () => {
    const icons = lucide as unknown as Record<string, unknown>;
    expect(icons[modIconExportName("not-an-icon")]).toBeUndefined();
    expect(icons[modIconExportName("")]).toBeUndefined();
  });
});

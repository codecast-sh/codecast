// The Modern looks for hand-built controls (components/ui/modernLook.ts) are
// added beside a call site's own classes. They are safe in Classic and Minimal
// only while every class they hold carries the `modern:` variant, and they
// keep the call site's look only while cn() never lets one of them remove an
// un-prefixed class.
import { describe, expect, test } from "bun:test";
import { cn } from "../../../lib/utils";
import {
  modernButton,
  modernChip,
  modernDialog,
  modernField,
  modernMenuItem,
  modernMenuLabel,
  modernMenuRow,
  modernMenuSeparator,
  modernMonoFact,
  modernPill,
  modernPillShape,
  modernPopover,
  modernScrim,
  modernTab,
  modernTabList,
  modernToneOf,
  type ModernButtonSize,
  type ModernButtonVariant,
  type ModernTone,
} from "../modernLook";

const VARIANTS: ModernButtonVariant[] = ["primary", "outline", "secondary", "ghost", "danger", "soft", "link"];
const SIZES: (ModernButtonSize | null)[] = ["xs", "sm", "md", "lg", "icon-xs", "icon-sm", "icon", null];
const TONES: ModernTone[] = ["neutral", "cyan", "green", "amber", "yellow", "orange", "red", "blue", "violet", "magenta"];

const every = (): [string, string][] => [
  ...VARIANTS.flatMap((variant) => SIZES.flatMap((size) => TONES.map((tone): [string, string] => [`button ${variant} ${size} ${tone}`, modernButton({ variant, size, tone })]))),
  ["button default", modernButton()],
  ...TONES.map((tone): [string, string] => [`pill ${tone}`, modernPill({ tone })]),
  ["pill default", modernPill()],
  ["pill block", modernPill({ tone: "cyan", block: true })],
  ["pill shape", modernPillShape()],
  ["chip on", modernChip({ active: true })],
  ["chip off", modernChip({ active: false })],
  ["tab on", modernTab({ active: true })],
  ["tab off", modernTab()],
  ["tab list", modernTabList],
  ["scrim", modernScrim],
  ["dialog", modernDialog()],
  ["dialog without scroll", modernDialog({ scroll: false })],
  ["popover", modernPopover],
  ["field", modernField],
  ["menu item", modernMenuItem],
  ["menu row", modernMenuRow()],
  ["menu row chosen", modernMenuRow({ selected: true })],
  ["menu label", modernMenuLabel],
  ["menu separator", modernMenuSeparator],
  ["mono fact", modernMonoFact],
];

describe("modernLook", () => {
  test("every class in every look carries the modern: variant", () => {
    for (const [name, look] of every()) {
      const classes = look.split(/\s+/).filter(Boolean);
      expect(classes.length).toBeGreaterThan(0);
      const stray = classes.filter((c) => !c.startsWith("modern:"));
      if (stray.length) throw new Error(`${name}: ${stray.join(" ")}`);
    }
  });

  test("no look sets a size under the 12px floor or names a raw palette colour", () => {
    for (const [name, look] of every()) {
      expect(`${name}: ${look}`).not.toMatch(/text-\[(\d|1[01])(\.\d+)?px\]|text-mark|(?:bg|text|border)-(?:gray|zinc|slate|neutral|amber|sky)-\d|#[0-9a-f]{3,6}/i);
    }
  });

  test("beside a call site's own classes, cn() keeps every Classic class", () => {
    const classic = "inline-flex items-center gap-1 rounded-md border border-sol-border/50 bg-sol-bg-alt px-2 py-0.5 text-[11px] text-sol-text-dim hover:bg-sol-bg-highlight focus:ring-1";
    for (const [name, look] of every()) {
      const merged = cn(classic, look).split(" ");
      for (const c of classic.split(" ")) {
        if (!merged.includes(c)) throw new Error(`${name} removed ${c}`);
      }
    }
  });

  test("a look only changes what it names: the tone, the state and the size", () => {
    expect(modernPill({ tone: "green" })).toContain("modern:bg-sol-green/10");
    expect(modernPill({ tone: "green" })).toContain("modern:text-sol-green");
    expect(modernPill()).toContain("modern:text-sol-text-muted");
    expect(modernButton({ variant: "soft", tone: "amber" })).toContain("modern:bg-sol-amber/10");
    expect(modernButton({ variant: "outline", size: "sm" })).toContain("modern:h-control-sm");
    expect(modernButton({ variant: "outline", size: "icon-xs" })).toContain("modern:size-6");
    expect(modernButton({ variant: "outline", size: null })).not.toMatch(/modern:h-|modern:size-/);
    expect(modernTab({ active: true })).toContain("modern:bg-sol-card");
    expect(modernTab({ active: false })).not.toContain("modern:bg-sol-card");
    expect(modernChip({ active: true })).toContain("modern:text-sol-cyan");
    expect(modernDialog({ scroll: false })).not.toContain("overflow");
  });

  test("a runtime colour class picks its tone", () => {
    expect(modernToneOf("text-sol-yellow")).toBe("yellow");
    expect(modernToneOf("bg-sol-green/10 text-sol-green border-sol-green/30")).toBe("green");
    expect(modernToneOf("text-sol-text-dim")).toBe("neutral");
    expect(modernToneOf("text-gray-500")).toBe("neutral");
    expect(modernToneOf(undefined)).toBe("neutral");
  });

  test("cn() keeps every class of a look: none of them conflict", () => {
    for (const [name, look] of every()) {
      if (name === "field") continue; // styles.ts's own string (its ring's bare outline)
      const merged = cn(look).split(" ");
      const lost = look.split(/\s+/).filter((c) => c && !merged.includes(c));
      if (lost.length) throw new Error(`${name}: ${lost.join(" ")}`);
    }
  });

  test("two looks merge, the later one winning", () => {
    expect(cn(modernButton({ variant: "outline", size: "sm" }), "modern:h-6").split(" ")).not.toContain("modern:h-control-sm");
    expect(cn(modernPill({ tone: "neutral" }), modernPill({ tone: "red" })).split(" ")).not.toContain("modern:bg-sol-text/[0.07]");
  });
});

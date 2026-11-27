import { describe, expect, test } from "bun:test";
import { DRAWN_TAGS, svgNodes, svgOf, type SvgNode } from "./webSvg";
import { webColor } from "./solColor";
import { TASK_STATUS } from "@codecast/web/components/TaskStatusBadge";
import { TASK_PRIORITY } from "@codecast/web/lib/taskPriority";
import { PLAN_STATUS_CONFIG } from "@codecast/web/lib/planStatus";
import { PROJECT_STATUS } from "@codecast/web/lib/projectStatus";
import { HEALTH_COLOR, INITIATIVE_STATUS_VISUAL } from "@codecast/web/lib/initiativeColors";
import { ACCENT, TYPE_ICON } from "@codecast/web/lib/entityCardAccent";
import { PR_STATE_GLYPH } from "@codecast/web/lib/prStateGlyph";
import { DEPLOY_STATE_ICON, REACH_ICON } from "@codecast/web/lib/deploys/deployLook";
import { SESSION_STATUS } from "@codecast/web/lib/sessionStatus";
import { STATUS_MARK_SHAPES } from "@codecast/web/lib/sessionStatusShapes";

// Every glyph in every vocabulary the phone draws must come out of web's
// component as SVG the native drawer knows, and every colour must resolve to a
// theme colour rather than the fallback. A web glyph that gains a hook, or a
// lucide upgrade that changes how an icon renders, fails here, not on a phone.

const drawn = new Set<string>(DRAWN_TAGS);
const tagsOf = (nodes: SvgNode[]): string[] => nodes.flatMap((n) => [n.tag, ...tagsOf(n.children)]);
const palette = new Proxy({}, { get: () => "#123456" }) as never;
const UNRESOLVED = "#badbad";

const GLYPHS: Record<string, unknown> = {
  ...Object.fromEntries(Object.entries(TASK_STATUS).map(([k, v]) => [`task:${k}`, v.icon])),
  ...Object.fromEntries(Object.entries(TASK_PRIORITY).map(([k, v]) => [`priority:${k}`, v.icon])),
  ...Object.fromEntries(Object.entries(PLAN_STATUS_CONFIG).map(([k, v]) => [`plan:${k}`, v.icon])),
  ...Object.fromEntries(Object.entries(PROJECT_STATUS).map(([k, v]) => [`project:${k}`, v.icon])),
  ...Object.fromEntries(Object.entries(INITIATIVE_STATUS_VISUAL).map(([k, v]) => [`goal:${k}`, v.icon])),
  ...Object.fromEntries(Object.entries(TYPE_ICON).map(([k, v]) => [`kind:${k}`, v])),
  ...Object.fromEntries(Object.entries(PR_STATE_GLYPH).flatMap(([k, v]) => [v.pr && [`pr:${k}`, v.pr], v.after && [`pr-after:${k}`, v.after]].filter(Boolean) as [string, unknown][])),
  ...Object.fromEntries(Object.entries(DEPLOY_STATE_ICON).map(([k, v]) => [`deploy:${k}`, v])),
  ...Object.fromEntries(Object.entries(REACH_ICON).map(([k, v]) => [`reach:${k}`, v])),
};

const COLORS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(TASK_STATUS).map(([k, v]) => [`task:${k}`, v.color])),
  ...Object.fromEntries(Object.entries(TASK_PRIORITY).map(([k, v]) => [`priority:${k}`, v.color])),
  ...Object.fromEntries(Object.entries(PLAN_STATUS_CONFIG).map(([k, v]) => [`plan:${k}`, v.color])),
  ...Object.fromEntries(Object.entries(PROJECT_STATUS).map(([k, v]) => [`project:${k}`, v.color])),
  ...Object.fromEntries(Object.entries(INITIATIVE_STATUS_VISUAL).map(([k, v]) => [`goal:${k}`, v.color])),
  ...Object.fromEntries(Object.entries(HEALTH_COLOR).map(([k, v]) => [`health:${k}`, v])),
  ...Object.fromEntries(Object.entries(ACCENT).map(([k, v]) => [`kind:${k}`, v.text])),
  ...Object.fromEntries(Object.entries(SESSION_STATUS).map(([k, v]) => [`session:${k}`, v.color])),
};

describe("web glyphs as native SVG", () => {
  for (const [name, icon] of Object.entries(GLYPHS)) {
    test(name, () => {
      const svg = svgOf(icon);
      expect(svg.tag).toBe("svg");
      expect(typeof svg.attrs.viewBox).toBe("string");
      expect(svg.children.length).toBeGreaterThan(0);
      expect(tagsOf(svg.children).filter((t) => !drawn.has(t))).toEqual([]);
    });
  }

  test("session status shapes", () => {
    for (const [mark, shape] of Object.entries(STATUS_MARK_SHAPES)) {
      const nodes = svgNodes(shape);
      expect(nodes.length, mark).toBeGreaterThan(0);
      expect(tagsOf(nodes).filter((t) => !drawn.has(t)), mark).toEqual([]);
    }
  });

  test("a lucide icon keeps its geometry and its stroke", () => {
    // lucide reaches the phone only through web's tables: High is ArrowUp.
    const svg = svgOf(TASK_PRIORITY.high.icon, { strokeWidth: 3 });
    expect(svg.attrs).toMatchObject({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round" });
    expect(svg.children.map((c) => c.attrs.d)).toEqual(["m5 12 7-7 7 7", "M12 19V5"]);
  });

  test("StatusCircle's done disc keeps its check on the background token", () => {
    const svg = svgOf(TASK_STATUS.done.icon);
    expect(svg.attrs.viewBox).toBe("0 0 20 20");
    expect(svg.children.find((c) => c.tag === "path")?.attrs.stroke).toBe("var(--sol-bg, #fff)");
  });
});

describe("web colours resolve to the theme", () => {
  for (const [name, value] of Object.entries(COLORS)) {
    test(`${name} (${value})`, () => {
      expect(webColor(value, palette, UNRESOLVED)).not.toBe(UNRESOLVED);
    });
  }

  test("color-mix and class tokens", () => {
    const t = { textDim: "#000000", blue: "#ffffff" } as never;
    expect(webColor("color-mix(in srgb, var(--sol-class-blue) 50%, var(--sol-text-dim))", t)).toBe("#808080");
    expect(webColor("text-sol-text-dim", t)).toBe("#000000");
    expect(webColor("text-[color:color-mix(in_srgb,var(--sol-class-blue)_50%,var(--sol-text-dim))]", t)).toBe("#808080");
  });
});

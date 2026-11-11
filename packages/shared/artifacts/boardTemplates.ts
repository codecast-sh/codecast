// Board templates (ct-92151): ready layouts a person picks from an empty
// board, or an agent starts from with `cast board template`. Each is plain
// elements (frames, stickies, text, connectors) with fresh keys, so anything
// in it can be moved, recolored, filled in or deleted afterwards.
import type { ArtifactOp } from "./core";
import { newElementKey } from "./spec";
import type { Pt } from "./boardGeometry";
import { timelineOps } from "./boardLayout";
import type { BoardArt } from "./boardArt";

export const BOARD_TEMPLATES = ["retro", "kanban", "roadmap", "timeline", "brainstorm"] as const;
export type BoardTemplate = (typeof BOARD_TEMPLATES)[number];

export const BOARD_TEMPLATE_LABELS: Record<BoardTemplate, string> = {
  retro: "Retro",
  kanban: "Kanban",
  roadmap: "Roadmap",
  timeline: "Timeline",
  brainstorm: "Brainstorm",
};

/** Each template's picture where a picker lists them (an illustration name, boardArt.ts). */
export const BOARD_TEMPLATE_ART: Record<BoardTemplate, BoardArt> = {
  retro: "thumbsup", kanban: "clipboard", roadmap: "compass", timeline: "road", brainstorm: "lightbulb",
};

export function isBoardTemplate(v: unknown): v is BoardTemplate {
  return typeof v === "string" && (BOARD_TEMPLATES as readonly string[]).includes(v);
}

type Col = { title: string; color: string; icon: string; starter: [string, string] };

function heading(ops: ArtifactOp[], at: Pt, title: string, subtitle: string | undefined, z: number): number {
  ops.push({ k: newElementKey("el"), put: { kind: "text", x: at.x, y: at.y, text: title, size: 36, weight: "bold", z } });
  if (subtitle) ops.push({ k: newElementKey("el"), put: { kind: "text", x: at.x, y: at.y + 54, text: subtitle, size: 16, color: "gray", z: z + 1 } });
  // Frames draw their title 28px above their top edge: leave room for it under the heading.
  return subtitle ? 140 : 104;
}

/** Side-by-side titled columns, each opening with an illustrated example sticky and a second example beside it. */
function columns(at: Pt, title: string, subtitle: string | undefined, cols: readonly Col[], colW: number, colH: number, zFrame: number, z: number): ArtifactOp[] {
  const ops: ArtifactOp[] = [];
  const top = at.y + heading(ops, at, title, subtitle, z);
  z += 2;
  const gap = 40, sw = 200, sgap = 24;
  cols.forEach((c, i) => {
    const x = at.x + i * (colW + gap);
    ops.push({ k: newElementKey("el"), put: { kind: "frame", x, y: top, w: colW, h: colH, title: c.title, color: c.color, z: zFrame } });
    const inner = Math.round(x + (colW - sw * 2 - sgap) / 2);
    ops.push({ k: newElementKey("el"), put: { kind: "sticky", x: inner, y: top + 32, w: sw, h: 200, text: c.starter[0], icon: c.icon, color: c.color, z: z++ } });
    ops.push({ k: newElementKey("el"), put: { kind: "sticky", x: inner + sw + sgap, y: top + 32, w: sw, h: 200, text: c.starter[1], color: c.color, z: z++ } });
  });
  return ops;
}

/**
 * Ops that lay template `name` out with its top-left at `at`. `zFrame` sits
 * under everything (frames), `z` above what is there.
 */
export function templateOps(name: BoardTemplate, at: Pt, zFrame: number, z: number, title?: string): { ops: ArtifactOp[]; keys: string[] } {
  let ops: ArtifactOp[];
  switch (name) {
    case "retro":
      ops = columns(at, title ?? "Retro", undefined, [
        { title: "Went well", color: "green", icon: "thumbsup", starter: ["Shipped on time", "Pairing on the hard parts"] },
        { title: "To improve", color: "orange", icon: "warning", starter: ["Too many late changes", "Flaky staging deploys"] },
        { title: "Actions", color: "blue", icon: "checklist", starter: ["Freeze scope a week out", "Release notes · Sam · Fri"] },
      ], 472, 560, zFrame, z);
      break;
    case "kanban":
      ops = columns(at, title ?? "Kanban", undefined, [
        { title: "To do", color: "gray", icon: "clipboard", starter: ["Onboarding email", "Pricing page copy"] },
        { title: "Doing", color: "blue", icon: "gear", starter: ["Billing settings", "Search filters"] },
        { title: "Done", color: "green", icon: "trophy", starter: ["Signup flow", "Team invites"] },
      ], 472, 680, zFrame, z);
      break;
    case "roadmap":
      ops = columns(at, title ?? "Roadmap", undefined, [
        { title: "Now", color: "green", icon: "rocket", starter: ["Mobile app beta", "Faster search"] },
        { title: "Next", color: "blue", icon: "compass", starter: ["Offline mode", "Shared templates"] },
        { title: "Later", color: "violet", icon: "mountain", starter: ["Public API", "Marketplace"] },
      ], 472, 560, zFrame, z);
      break;
    case "timeline":
      ops = timelineOps([
        { label: "Week 1", title: "Kickoff", body: "Goals and owners", icon: "flag" },
        { label: "Week 3", title: "Design", body: "Sketches and review", icon: "palette" },
        { label: "Week 5", title: "Build", body: "First working version", icon: "wrench" },
        { label: "Week 7", title: "Test", body: "Fix what breaks", icon: "bug" },
        { label: "Week 9", title: "Launch", body: "Out to everyone", icon: "rocket" },
      ], { at, title: title ?? "Timeline", zBase: z, zRoad: zFrame }).ops;
      break;
    case "brainstorm": {
      ops = [];
      const top = at.y + heading(ops, at, title ?? "Brainstorm", undefined, z);
      z += 2;
      const cx = at.x + 560, cy = top + 380;
      const hub = newElementKey("el");
      ops.push({ k: hub, put: { kind: "shape", shape: "ellipse", x: cx - 140, y: cy - 70, w: 280, h: 140, text: "The question", color: "violet", solid: true, z: z++ } });
      const colors = ["yellow", "pink", "cyan", "green", "orange", "blue"];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 6;
        const k = newElementKey("el");
        ops.push({ k, put: { kind: "sticky", x: Math.round(cx + Math.cos(a) * 380 - 100), y: Math.round(cy + Math.sin(a) * 280 - 80), w: 200, h: 160, text: "", color: colors[i], z: z++ } });
        ops.push({ k: newElementKey("el"), put: { kind: "connector", from: hub, to: k, curve: "curved", arrow: "none", color: "gray", z: zFrame + 1 } });
      }
      break;
    }
  }
  return { ops, keys: ops.map((o) => o.k) };
}

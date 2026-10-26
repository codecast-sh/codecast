// The stored role icon (shared/contracts/roleIcon RoleIcon) as a Convex
// validator: the schema's `org_roles.icon` and the setIcon mutation's
// argument. It checks the shape; roleIconProblems checks the geometry, and
// every write runs both.
import { v } from "convex/values";
import { ROLE_ICON_ACCENTS } from "@codecast/shared/contracts/roleIcon";

const points = v.array(v.number());

export const roleIconShapeValidator = v.union(
  v.object({ t: v.literal("path"), d: v.string() }),
  v.object({ t: v.literal("circle"), cx: v.number(), cy: v.number(), r: v.number(), fill: v.optional(v.boolean()) }),
  v.object({ t: v.literal("ellipse"), cx: v.number(), cy: v.number(), rx: v.number(), ry: v.number() }),
  v.object({ t: v.literal("rect"), x: v.number(), y: v.number(), width: v.number(), height: v.number(), rx: v.optional(v.number()) }),
  v.object({ t: v.literal("line"), x1: v.number(), y1: v.number(), x2: v.number(), y2: v.number() }),
  v.object({ t: v.literal("polyline"), points }),
  v.object({ t: v.literal("polygon"), points }),
);

export const roleIconAccentValidator = v.union(...ROLE_ICON_ACCENTS.map((a) => v.literal(a)));

export const roleIconValidator = v.object({
  v: v.literal(1),
  concept: v.string(),
  accent: roleIconAccentValidator,
  shapes: v.array(roleIconShapeValidator),
});

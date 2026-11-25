// The stored shape of a page's parsed "app" block (shared/contracts/pageApp
// parsePageApp): on artifacts for the current version, on artifact_versions
// for each superseded one, so consent can be compared between versions.

import { v } from "convex/values";
import { APP_PERMISSIONS, APP_TITLE_BARS } from "@codecast/shared/contracts/pageApp";

export const pageAppValidator = v.object({
  name: v.optional(v.string()),
  icon: v.optional(v.string()),
  window: v.optional(v.object({
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    minWidth: v.optional(v.number()),
    minHeight: v.optional(v.number()),
    resizable: v.optional(v.boolean()),
    titleBar: v.optional(v.union(...APP_TITLE_BARS.map((t) => v.literal(t)))),
  })),
  tray: v.optional(v.object({
    icon: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    tooltip: v.optional(v.string()),
  })),
  permissions: v.optional(v.array(v.union(...APP_PERMISSIONS.map((p) => v.literal(p))))),
});

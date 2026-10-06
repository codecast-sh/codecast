// Value shapes shared by the schema and function args.
import { v, type Infer } from "convex/values";
import { VERSION_KINDS } from "./lib/versions";

/** Every public function takes these and proves them (visitors.requireVisitor). */
export const visitorArgs = { visitor_id: v.string(), secret: v.string() };

/** What an app's SDK proves instead: a visitor, in one app (requireRuntimeVisitor). */
export const runtimeArgs = { visitor_id: v.string(), app_id: v.id("apps"), token: v.string() };

export const versionKind = v.union(...VERSION_KINDS.map((k) => v.literal(k)));

export const messageKind = v.union(v.literal("chat"), v.literal("request"), v.literal("build"), v.literal("system"));
export type MessageKind = Infer<typeof messageKind>;

/** What the composer asked for: Auto lets triage decide. */
export const composerMode = v.union(v.literal("auto"), v.literal("change"), v.literal("chat"));
export type ComposerMode = Infer<typeof composerMode>;

/** Point and talk: the element a message is about. */
export const elementRef = v.object({
  selector: v.string(),
  tag: v.string(),
  text: v.optional(v.string()),
  snippet: v.optional(v.string()),
});
export type ElementRef = Infer<typeof elementRef>;

/** A system note's facts; the shell writes the words from them, so a
 *  character renamed later reads right. */
export const systemNote = v.union(
  v.object({ type: v.literal("fork"), visitor_id: v.id("visitors"), version: v.number(), fork_app_id: v.id("apps") }),
  v.object({ type: v.literal("restore"), visitor_id: v.id("visitors"), from_version: v.number(), version: v.number() }),
);
export type SystemNote = Infer<typeof systemNote>;

export const buildStatus = v.union(v.literal("queued"), v.literal("building"), v.literal("live"), v.literal("failed"));
export type BuildStatus = Infer<typeof buildStatus>;

/** A file a build looked at or changed, as its card shows it. */
export const touchedFile = v.object({
  path: v.string(),
  how: v.union(v.literal("read"), v.literal("wrote"), v.literal("deleted")),
});
export type TouchedFile = Infer<typeof touchedFile>;

export const versionRef = v.object({ app_id: v.id("apps"), version: v.number() });

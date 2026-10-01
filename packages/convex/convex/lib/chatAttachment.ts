import { v, type Infer } from "convex/values";

// One image on a chat line: a stored blob plus what the tile needs to lay it
// out before it loads. Team chat, the huddle chat and the Slack mirror all
// store this shape on chat_messages, so they all validate it here.
export const chatAttachmentValidator = v.object({
  storage_id: v.id("_storage"),
  name: v.optional(v.string()),
  mime: v.optional(v.string()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
});

export type ChatAttachment = Infer<typeof chatAttachmentValidator>;

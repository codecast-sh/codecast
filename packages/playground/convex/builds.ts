// A build card's live narration (build_progress), read on its own so that
// Clay's several writes a second wake only the cards showing them.
import { v } from "convex/values";
import { query } from "./_generated/server";
import { progressRow } from "./builder/queue";
import { requireVisitor } from "./visitors";
import { visitorArgs, type NarrationLine, type TouchedFile } from "./validators";

export type BuildProgress = { narration: NarrationLine[]; files_touched: TouchedFile[] };

export const progress = query({
  args: { ...visitorArgs, build_id: v.id("builds") },
  handler: async (ctx, args): Promise<BuildProgress | null> => {
    await requireVisitor(ctx, args);
    const row = await progressRow(ctx, args.build_id);
    return row && { narration: row.narration, files_touched: row.files_touched };
  },
});

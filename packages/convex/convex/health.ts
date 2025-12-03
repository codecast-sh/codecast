import { query } from "./_generated/server";

export const check = query({
  args: {},
  handler: async () => {
    return { status: "ok", timestamp: Date.now() };
  },
});

import { describe, expect, test } from "bun:test";
import { watchPromptSettled, type PendingTool } from "./permissionPromptWatch";

const RM: PendingTool = { tool_name: "Bash", arguments_preview: "cd /tmp/x && rm -f page/*" };
const NEXT: PendingTool = { tool_name: "Bash", arguments_preview: "ls page" };

// Drives the watch through a scripted sequence of transcript reads, one per tick.
async function run(reads: (PendingTool | null)[], toolName = "Bash") {
  let i = 0;
  let settled = 0;
  const stop = watchPromptSettled({
    readPending: async () => reads[Math.min(i++, reads.length - 1)],
    toolName,
    onSettled: () => { settled++; },
    intervalMs: 1,
  });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  return { settled, reads: i };
}

describe("watchPromptSettled", () => {
  test("settles when the held call gets its result (Claude's own timeout denial)", async () => {
    expect((await run([RM, RM, null])).settled).toBe(1);
  });

  test("settles when a later call replaces the held one", async () => {
    expect((await run([RM, NEXT])).settled).toBe(1);
  });

  test("never settles while the call stays pending", async () => {
    expect((await run([RM])).settled).toBe(0);
  });

  test("does not settle before the call has been seen (transcript not flushed yet)", async () => {
    expect((await run([null, null, NEXT])).settled).toBe(0);
    expect((await run([null, RM, RM])).settled).toBe(0);
  });

  test("stops reading once settled", async () => {
    const r = await run([RM, null]);
    expect(r.settled).toBe(1);
    expect(r.reads).toBe(2);
  });
});

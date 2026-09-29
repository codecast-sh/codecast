import { describe, expect, test } from "bun:test";
import { daemonForkFields } from "./conversations";

// A cloud agent's branch (a Codex Cloud task's other attempt) is created by the
// daemon as a fork whose shared history its own transcript carries: it forks
// its origin at the prompt, counts that shared part as copied, and files where
// the origin is filed, else born stashed (the origin's card stands for the task).
describe("daemonForkFields", () => {
  const fork = { at_uuid: "task_e_1:usertrn_e_2", copied: 1, cutoff: 1_790_000_000_000 };

  const NOW = 1_790_000_100_000;

  test("a fork of the origin at the prompt, its shared part counted as copied, born stashed", () => {
    expect(daemonForkFields({ _id: "conv_task" } as any, fork, NOW)).toEqual({
      forked_from: "conv_task",
      fork_copied: 1,
      fork_cutoff_timestamp: 1_790_000_000_000,
      inbox_stashed_at: NOW,
    } as any);
  });

  test("a branch of a task already filed away files with it", () => {
    const filed = daemonForkFields({ _id: "conv_task", inbox_stashed_at: 5, inbox_stash_hidden: true, inbox_dismissed_at: null } as any, { ...fork, cutoff: undefined }, NOW);
    expect(filed).toEqual({ forked_from: "conv_task", fork_copied: 1, inbox_stashed_at: 5, inbox_stash_hidden: true } as any);
    const dismissed = daemonForkFields({ _id: "conv_task", inbox_dismissed_at: 7 } as any, { ...fork, cutoff: undefined }, NOW);
    expect(dismissed).toMatchObject({ inbox_dismissed_at: 7, inbox_stashed_at: NOW });
  });
});

import { describe, expect, test } from "bun:test";
import {
  commandTree,
  levenshtein,
  suggestCommands,
  unknownCommandNextStep,
  type CommandNode,
} from "./commandSuggestion.js";

// Nodes named after real commands: the destructive filter reads the live table
// in destructiveCommands.ts, so a fixture with invented names would not
// exercise it.
const ROOT: CommandNode[] = [
  { name: "sessions" },
  { name: "send" },
  { name: "state" },
  { name: "stash" },
  { name: "task", children: [{ name: "ls" }, { name: "show" }, { name: "drop" }] },
  { name: "trigger", children: [
    { name: "add" },
    { name: "ls" },
    { name: "run" },
    { name: "pause" },
    { name: "cancel" },
    { name: "complete" },
  ] },
  { name: "workspace", aliases: ["ws"], children: [{ name: "ls" }, { name: "destroy" }, { name: "heal" }] },
  { name: "kill" },
  { name: "stop" },
];

describe("levenshtein", () => {
  test("counts single-character edits", () => {
    expect(levenshtein("cancel", "cancel")).toBe(0);
    expect(levenshtein("cancl", "cancel")).toBe(1);
    expect(levenshtein("", "drop")).toBe(4);
  });

  test("a transposition costs two edits", () => {
    expect(levenshtein("cancle", "cancel")).toBe(2);
  });
});

describe("suggestCommands", () => {
  test("suggests a sibling within three edits", () => {
    expect(suggestCommands(ROOT, ["sesions"])).toEqual(["sessions"]);
  });

  test("stays silent past three edits", () => {
    expect(suggestCommands(ROOT, ["telemetry"])).toEqual([]);
  });

  test("returns at most three, nearest first then alphabetical", () => {
    // state is one edit away; stash, send and task follow, and the three-item
    // cap drops `task` because `send` sorts first at the same distance.
    expect(suggestCommands(ROOT, ["stat"])).toEqual(["state", "stash", "send"]);
  });

  test("compares against the children of a group the operands resolved", () => {
    expect(suggestCommands(ROOT, ["task", "lst"])).toEqual(["task ls"]);
    expect(suggestCommands(ROOT, ["workspace", "heel"])).toEqual(["workspace heal"]);
  });

  test("resolves a group through its alias", () => {
    expect(suggestCommands(ROOT, ["ws", "heel"])).toEqual(["workspace heal"]);
  });

  test("says nothing when every operand resolves", () => {
    expect(suggestCommands(ROOT, ["task", "ls"])).toEqual([]);
  });

  test("skips hidden commands", () => {
    const tree: CommandNode[] = [{ name: "sessions", hidden: true }];
    expect(suggestCommands(tree, ["sesions"])).toEqual([]);
  });
});

describe("suggestCommands: destructive commands", () => {
  test("never proposes a destructive command from an unrelated typo", () => {
    // 'canal' is two edits from `trigger cancel` — inside the suggestion
    // window, but not close enough to count as reaching for it.
    expect(suggestCommands(ROOT, ["trigger", "canal"])).toEqual([]);
  });

  test("a near-miss of the destructive verb unlocks it", () => {
    expect(suggestCommands(ROOT, ["trigger", "cancl"])).toEqual(["trigger cancel"]);
    expect(suggestCommands(ROOT, ["workspace", "destro"])).toEqual(["workspace destroy"]);
  });

  test("a benign typo at the root never recovers into kill or stop", () => {
    // 'staus' sits three edits from `stop`, inside the suggestion window, and
    // more than one edit from every destructive verb — so `stop` stays out.
    expect(suggestCommands(ROOT, ["staus"])).toEqual(["stash", "state", "task"]);
  });

  test("reaching for one destructive verb does not unlock its siblings", () => {
    // 'kilp' is one edit from `plan kill` and three from `plan drop`. The first
    // is a recovery; the second would be handing over an unrelated deletion.
    const tree: CommandNode[] = [{ name: "plan", children: [{ name: "drop" }, { name: "kill" }] }];
    expect(suggestCommands(tree, ["plan", "kilp"])).toEqual(["plan kill"]);
  });
});

describe("unknownCommandNextStep", () => {
  test("names one command in a plain line", () => {
    expect(unknownCommandNextStep(ROOT, ["sesions"])).toBe(
      "Next step: did you mean 'cast sessions'?",
    );
  });

  test("lists several in order", () => {
    expect(unknownCommandNextStep(ROOT, ["stat"])).toBe(
      "Next step: did you mean 'cast state', 'cast stash', 'cast send'?",
    );
  });

  test("names the full path for a nested command", () => {
    expect(unknownCommandNextStep(ROOT, ["task", "lst"])).toBe(
      "Next step: did you mean 'cast task ls'?",
    );
  });

  test("is null when nothing is close", () => {
    expect(unknownCommandNextStep(ROOT, ["telemetry"])).toBeNull();
  });
});

describe("commandTree", () => {
  test("reads name, aliases, hidden and children off a commander tree", () => {
    const leaf = { name: () => "destroy", aliases: () => [], commands: [] };
    const group = { name: () => "workspace", aliases: () => ["ws"], commands: [leaf] };
    const secret = { name: () => "__probe", aliases: () => [], commands: [], _hidden: true };
    expect(commandTree({ name: () => "cast", commands: [group, secret] })).toEqual([
      {
        name: "workspace",
        aliases: ["ws"],
        hidden: false,
        children: [{ name: "destroy", aliases: [], hidden: false, children: [] }],
      },
      { name: "__probe", aliases: [], hidden: true, children: [] },
    ]);
  });
});

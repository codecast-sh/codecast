import { describe, expect, test } from "bun:test";
import { levenshtein } from "@codecast/shared/contracts/levenshtein";
import {
  commandTree,
  suggestCommands,
  unknownCommandNextStep,
  verbTypoNextStep,
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

  test("returns the nearest, then the next nearest, within half the typed length", () => {
    // state is one edit away and stash two; send and task are three, past
    // what a four-letter word may stray.
    expect(suggestCommands(ROOT, ["stat"])).toEqual(["state", "stash"]);
  });

  test("a swap of two neighbouring letters is one edit", () => {
    const tree: CommandNode[] = [{ name: "status" }, { name: "state" }, { name: "stash" }];
    expect(suggestCommands(tree, ["statsu"])).toEqual(["status", "stash", "state"]);
  });

  test("the start of a command's name finds it", () => {
    expect(suggestCommands(ROOT, ["sess"])).toEqual(["sessions", "send"]);
  });

  test("a short unknown word is offered nothing far from it", () => {
    const tree: CommandNode[] = [{ name: "doc" }, { name: "flow" }, { name: "fork" }];
    expect(suggestCommands(tree, ["foo"])).toEqual([]);
  });

  test("far matches are dropped when a near one exists", () => {
    const tree: CommandNode[] = [{ name: "teams" }, { name: "blame" }, { name: "learn" }];
    expect(suggestCommands(tree, ["teamz"])).toEqual(["teams"]);
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
    // 'staus' sits three edits from `stop`, and more than one edit from every
    // destructive verb, so `stop` stays out.
    expect(suggestCommands(ROOT, ["staus"])).toEqual(["stash", "state"]);
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
      "Next step: did you mean 'cast state', 'cast stash'?",
    );
  });

  test("names the full path for a nested command", () => {
    expect(unknownCommandNextStep(ROOT, ["task", "lst"])).toBe(
      "Next step: did you mean 'cast task ls'?",
    );
  });

  test("with no near name, names the siblings whose description mentions the word", () => {
    const tree: CommandNode[] = [
      { name: "devices", description: "Your machines: settings such as hooks, versions and keys" },
      { name: "uninstall", description: "Remove codecast: the daemon, hooks and the binary" },
      { name: "status", description: "Daemon state" },
    ];
    expect(unknownCommandNextStep(tree, ["hooks"])).toBe("Next step: these commands mention 'hooks': 'cast devices'");
  });

  test("a near name and a mention are both offered", () => {
    const tree: CommandNode[] = [
      { name: "hosts", description: "Remote machines" },
      { name: "devices", description: "Your machines: settings such as hooks" },
    ];
    expect(unknownCommandNextStep(tree, ["hooks"])).toBe(
      "Next step: did you mean 'cast hosts'?\nOr: these commands mention 'hooks': 'cast devices'",
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

describe("verbTypoNextStep", () => {
  test("a positional verb typo names the whole command", () => {
    expect(verbTypoNextStep(["decide"], ["show", "ls", "edit"], "shwo")).toBe("Next step: did you mean 'cast decide show'?");
    expect(verbTypoNextStep(["stack"], ["ls", "show", "add"], "lss")).toBe("Next step: did you mean 'cast stack ls'?");
  });
  test("a word near no verb gets nothing", () => {
    expect(verbTypoNextStep(["decide"], ["show", "ls", "edit"], "deploymentplan")).toBeNull();
  });
});

describe("commands under another name", () => {
  test("whoami, daemon status, deploys and conflicts point where the thing lives", () => {
    expect(unknownCommandNextStep([{ name: "replay" }], ["whoami"])).toContain("cast auth status");
    expect(unknownCommandNextStep([{ name: "daemon", children: [{ name: "rotate-token" }] }], ["daemon", "status"])).toContain("'cast status'");
    expect(unknownCommandNextStep([{ name: "replay" }], ["deploys"])).not.toContain("replay");
    expect(unknownCommandNextStep([{ name: "similar" }], ["conflicts"])).toContain("cast similar --file");
  });

  test("reading comments points at the read form, not the write verb one edit away", () => {
    const doc = [{ name: "doc", children: [{ name: "comment" }, { name: "show" }] }];
    expect(unknownCommandNextStep(doc, ["doc", "comments"])).toStartWith("Next step: 'cast doc show <id> -c'");
    const task = [{ name: "task", children: [{ name: "comment" }, { name: "show" }] }];
    expect(unknownCommandNextStep(task, ["task", "comments"])).toContain("--only comments");
  });
});

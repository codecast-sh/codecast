import { describe, expect, test } from "bun:test";
import { buildExistingMessagePatch, lastKnownModelFromBatch, modelFromSwitchLine, effortFromSwitchLine, lastKnownEffortFromBatch } from "./messages";

// Per-message model arrives with the transcript sync (parser → daemon →
// addMessages). For rows synced before the field existed, the existing-uuid
// patch path is the backfill: re-syncing a transcript (resume, fork, new
// device) must stamp model onto already-stored assistant messages.

const assistantRow = {
  role: "assistant",
  content: "Reply text",
  thinking: undefined,
  tool_calls: undefined,
  tool_results: undefined,
  images: undefined,
  subtype: undefined,
  model: undefined,
};

describe("buildExistingMessagePatch model handling", () => {
  test("patches assistant content for app-server streaming updates", () => {
    const patch = buildExistingMessagePatch(
      { ...assistantRow, content: "partial" },
      { ...assistantRow, content: "partial answer" },
    );
    expect(patch).toEqual({ content: "partial answer" });
  });

  test("backfills model onto an existing assistant row that lacks it", () => {
    const patch = buildExistingMessagePatch(assistantRow, {
      ...assistantRow,
      model: "claude-opus-4-8",
    });
    expect(patch).toEqual({ model: "claude-opus-4-8" });
  });

  test("no patch when the stored model already matches", () => {
    const stored = { ...assistantRow, model: "claude-opus-4-8" };
    const patch = buildExistingMessagePatch(stored, { ...stored });
    expect(patch).toBeNull();
  });

  test("incoming without model leaves the stored value alone", () => {
    const stored = { ...assistantRow, model: "claude-opus-4-8" };
    const patch = buildExistingMessagePatch(stored, {
      ...assistantRow,
      model: undefined,
    });
    expect(patch).toBeNull();
  });

  test("user-role messages never patch model", () => {
    const patch = buildExistingMessagePatch(
      { ...assistantRow, role: "user" },
      { ...assistantRow, role: "user", model: "claude-opus-4-8" },
    );
    expect(patch).toBeNull();
  });
});

// addMessages rolls the batch's newest assistant model up to conversations.model
// (the last-known value surfaced by the inbox badge).
describe("lastKnownModelFromBatch", () => {
  test("picks the newest assistant model by timestamp", () => {
    expect(
      lastKnownModelFromBatch([
        { role: "assistant", model: "claude-sonnet-4-6", timestamp: 100 },
        { role: "user", timestamp: 200 },
        { role: "assistant", model: "claude-opus-4-8", timestamp: 300 },
      ]),
    ).toBe("claude-opus-4-8");
  });

  test("later entry wins on equal/missing timestamps (JSONL order)", () => {
    expect(
      lastKnownModelFromBatch([
        { role: "assistant", model: "claude-sonnet-4-6" },
        { role: "assistant", model: "claude-opus-4-8" },
      ]),
    ).toBe("claude-opus-4-8");
  });

  test("ignores synthetic banners and non-assistant roles", () => {
    expect(
      lastKnownModelFromBatch([
        { role: "assistant", model: "claude-opus-4-8", timestamp: 100 },
        { role: "assistant", model: "<synthetic>", timestamp: 200 },
        { role: "user", model: "claude-sonnet-4-6", timestamp: 300 },
      ]),
    ).toBe("claude-opus-4-8");
  });

  test("returns null when no assistant model present", () => {
    expect(
      lastKnownModelFromBatch([
        { role: "user", timestamp: 100 },
        { role: "assistant", model: "<synthetic>", timestamp: 200 },
      ]),
    ).toBeNull();
  });
});

// A /model switch arrives as a user `<local-command-stdout>Set model to <Name>`
// line with no assistant turn until the next message. It must count as a model
// signal or conversations.model — and forks, which stamp it on every line —
// lag one turn behind the switch.
describe("modelFromSwitchLine", () => {
  const ESC = "\u001b";
  const switchLine = (name: string) =>
    `<local-command-stdout>Set model to ${ESC}[1m${name}${ESC}[22m and saved as your default for new sessions</local-command-stdout>`;

  test("maps the display name to the stored id shape", () => {
    expect(modelFromSwitchLine(switchLine("Fable 5"))).toBe("claude-fable-5");
    expect(modelFromSwitchLine(switchLine("Opus 4.8"))).toBe("claude-opus-4-8");
    expect(modelFromSwitchLine(switchLine("Sonnet 4.6"))).toBe("claude-sonnet-4-6");
  });

  test("matches without ANSI escapes", () => {
    expect(modelFromSwitchLine("<local-command-stdout>Set model to Fable 5</local-command-stdout>")).toBe("claude-fable-5");
  });

  test("Default and quoted mentions are not signals", () => {
    expect(modelFromSwitchLine(switchLine("Default"))).toBeNull();
    expect(modelFromSwitchLine("the log said: Set model to Opus 4.8")).toBeNull();
    expect(modelFromSwitchLine(undefined)).toBeNull();
  });
});

describe("lastKnownModelFromBatch with /model switch lines", () => {
  const ESC = "\u001b";
  const switchContent = `<local-command-stdout>Set model to ${ESC}[1mFable 5${ESC}[22m and saved as your default for new sessions</local-command-stdout>`;

  test("a trailing switch line wins over earlier assistant turns", () => {
    expect(
      lastKnownModelFromBatch([
        { role: "assistant", model: "claude-opus-4-8", timestamp: 100 },
        { role: "user", content: switchContent, timestamp: 200 },
      ]),
    ).toBe("claude-fable-5");
  });

  test("an assistant turn after the switch wins (records what actually ran)", () => {
    expect(
      lastKnownModelFromBatch([
        { role: "user", content: switchContent, timestamp: 100 },
        { role: "assistant", model: "claude-opus-4-8", timestamp: 200 },
      ]),
    ).toBe("claude-opus-4-8");
  });
});

describe("effortFromSwitchLine", () => {
  const ESC = "\u001b";
  const effortCmd = (level: string) =>
    `<local-command-stdout>Set effort level to ${level} (saved as your default for new sessions): Some description</local-command-stdout>`;
  const pickerCommit = (name: string, level: string) =>
    `<local-command-stdout>Set model to ${ESC}[1m${name}${ESC}[22m for this session only with ${ESC}[1m${level}${ESC}[22m effort</local-command-stdout>`;

  test("reads the /effort command echo", () => {
    expect(effortFromSwitchLine(effortCmd("high"))).toBe("high");
    expect(effortFromSwitchLine(effortCmd("max"))).toBe("max");
  });

  test("reads the picker session-only commit (ANSI-wrapped)", () => {
    expect(effortFromSwitchLine(pickerCommit("Sonnet 4.6", "max"))).toBe("max");
    expect(effortFromSwitchLine(pickerCommit("Fable 5", "low"))).toBe("low");
  });

  test("model-only switches and prose are not signals", () => {
    expect(effortFromSwitchLine(`<local-command-stdout>Set model to ${ESC}[1mOpus 4.8${ESC}[22m and saved as your default for new sessions</local-command-stdout>`)).toBeNull();
    expect(effortFromSwitchLine("please work with max effort")).toBeNull();
    expect(effortFromSwitchLine(undefined)).toBeNull();
  });

  test("auto clears rather than stamps", () => {
    expect(effortFromSwitchLine(effortCmd("auto"))).toBeNull();
  });
});

describe("lastKnownEffortFromBatch", () => {
  const commit = (level: string, name = "Opus 4.8") =>
    `<local-command-stdout>Set model to ${name} for this session only with ${level} effort</local-command-stdout>`;

  test("newest effort signal wins", () => {
    expect(
      lastKnownEffortFromBatch([
        { role: "user", content: commit("low"), timestamp: 100 },
        { role: "assistant", content: "done", timestamp: 150 },
        { role: "user", content: commit("max"), timestamp: 200 },
      ]),
    ).toBe("max");
  });

  test("returns null when the batch has no effort signal", () => {
    expect(
      lastKnownEffortFromBatch([
        { role: "assistant", content: "hi", timestamp: 100 },
        { role: "user", content: "switch to max effort please", timestamp: 200 },
      ]),
    ).toBeNull();
  });
});

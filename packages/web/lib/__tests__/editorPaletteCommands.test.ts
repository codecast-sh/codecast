import { describe, expect, test } from "bun:test";
import { CODE_COMMAND_IDS } from "../code/commands";
import { EDITOR_PALETTE_COMMANDS, editorCommandsLead, editorPaletteKey } from "../editorPaletteCommands";
import { formatAcceleratorParts } from "../../shortcuts";

describe("editor palette commands", () => {
  test("every entry names a registered code command", () => {
    const ids = new Set<string>(CODE_COMMAND_IDS);
    for (const c of EDITOR_PALETTE_COMMANDS) expect(ids.has(c.id)).toBe(true);
  });

  // A vimrc can map Cmd-K away from the editor (`noremap <d-k> ...`), so the
  // inline instruction box must stay reachable from the palette.
  test("the agent's commands are offered, with the keys the editor claims", () => {
    const byId = new Map(EDITOR_PALETTE_COMMANDS.map((c) => [c.id, c]));
    for (const id of ["agent.quoteSelection", "agent.inlineInstruction", "agent.pickSession", "agent.newSession"]) {
      expect(byId.has(id as never)).toBe(true);
    }
    const quote = byId.get("agent.quoteSelection")!;
    expect(formatAcceleratorParts(quote.editorKey!).length).toBe(2);
  });

  test("the review commands are offered, each entry under its own key", () => {
    const keys = EDITOR_PALETTE_COMMANDS.map(editorPaletteKey);
    expect(new Set(keys).size).toBe(keys.length);
    const labels = EDITOR_PALETTE_COMMANDS.filter((c) => c.id.startsWith("git.")).map((c) => c.label);
    expect(labels).toEqual(["Diff vs HEAD", "Diff against…", "Diff side by side", "Next change", "Previous change", "Peek change", "Revert change"]);
  });

  // With Files focused, the words the editor shares with the app's pane
  // commands lead with the Editor group.
  test("split, close and search lead with the editor's commands; other words don't", () => {
    for (const q of ["split", "close", "search", "Quote"]) expect(editorCommandsLead(q)).toBe(true);
    for (const q of ["inbox", "spl", ""]) expect(editorCommandsLead(q)).toBe(false);
  });
});

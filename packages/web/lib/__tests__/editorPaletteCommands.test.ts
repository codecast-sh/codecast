import { describe, expect, test } from "bun:test";
import { CODE_COMMAND_IDS } from "../code/commands";
import { EDITOR_PALETTE_COMMANDS } from "../editorPaletteCommands";
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
});

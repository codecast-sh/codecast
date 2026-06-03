import { describe, expect, it } from "bun:test";
import {
  TAB_INDENT_PRIORITY,
  TabIndentExtension,
  handleShiftTab,
  handleTab,
} from "./TabIndentExtension";

// Minimal stand-in exposing only the editor surface the handlers touch, so the
// behavior can be exercised without a DOM / live ProseMirror view.
function mockEditor(opts: { from: number; empty?: boolean; charBefore?: string }) {
  const commandCalls: Array<[string, unknown]> = [];
  const editor: any = {
    commandCalls,
    commands: {
      insertContent: (c: unknown) => {
        commandCalls.push(["insertContent", c]);
        return true;
      },
      deleteRange: (r: unknown) => {
        commandCalls.push(["deleteRange", r]);
        return true;
      },
    },
    state: {
      selection: { from: opts.from, empty: opts.empty ?? true },
      doc: { textBetween: () => opts.charBefore ?? "" },
    },
  };
  return editor;
}

describe("TabIndentExtension", () => {
  it("is wired as a fallback below the default Tiptap binding priority", () => {
    // ListItem/TaskItem/CodeBlock bind Tab at Tiptap's default priority (100).
    // Tiptap tries bindings highest-priority first, so ours must sit lower or
    // it would hijack list indentation.
    const DEFAULT_TIPTAP_PRIORITY = 100;
    expect((TabIndentExtension as any).config.priority).toBe(TAB_INDENT_PRIORITY);
    expect(TAB_INDENT_PRIORITY).toBeLessThan(DEFAULT_TIPTAP_PRIORITY);
  });

  it("inserts a tab character on Tab and swallows the event", () => {
    const editor = mockEditor({ from: 1 });
    expect(handleTab(editor)).toBe(true);
    expect(editor.commandCalls).toEqual([["insertContent", "\t"]]);
  });

  it("outdents by removing a preceding tab on Shift-Tab", () => {
    const editor = mockEditor({ from: 5, charBefore: "\t" });
    expect(handleShiftTab(editor)).toBe(true);
    expect(editor.commandCalls).toEqual([["deleteRange", { from: 4, to: 5 }]]);
  });

  it("swallows Shift-Tab with no preceding tab (no focus escape, no deletion)", () => {
    const editor = mockEditor({ from: 3, charBefore: "x" });
    expect(handleShiftTab(editor)).toBe(true);
    expect(editor.commandCalls).toEqual([]);
  });

  it("does not outdent at the document start", () => {
    const editor = mockEditor({ from: 0, charBefore: "\t" });
    expect(handleShiftTab(editor)).toBe(true);
    expect(editor.commandCalls).toEqual([]);
  });
});

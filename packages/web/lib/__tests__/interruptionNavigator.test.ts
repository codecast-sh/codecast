import { describe, expect, test } from "bun:test";
import { filterUserMessages } from "../../../convex/convex/userMessagesFilter";
import { buildNavigatorRows, filterNavigatorRows, navigatorHeaderLabels } from "../messageNavigator";

const notice = "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";
const message = (content: string, index: number) => ({
  _id: `message-${index}`,
  role: "user" as const,
  content,
  timestamp: index,
});
const notices = [
  notice,
  `  ${notice}\n`,
  `<turn_aborted>\n${notice}\n</turn_aborted>`,
  "<turn_aborted>user aborted</turn_aborted>",
  `<turn_aborted>\n${notice.slice(0, 100)}`,
  notice.slice(0, 100),
  `<system-reminder>context</system-reminder>\n${notice}`,
];

describe("interruption notices in prompt navigation", () => {
  test.each(notices)("excludes a notice from server results and cached rows: %s", (content) => {
    const messages = [message(content, 0)];
    expect(filterUserMessages(messages)).toEqual([]);
    expect(buildNavigatorRows(messages)).toEqual([]);
  });

  test("repeated notices leave numbering, counts, search, and hidden rows unchanged", () => {
    const messages = ["Fix prompt navigation", ...Array(4).fill(notice), "Now add tests"].map(message);
    for (const input of [messages, filterUserMessages(messages)]) {
      const rows = buildNavigatorRows(input);
      expect(rows.map(row => [row._id, row.originalIndex])).toEqual([
        ["message-0", 0],
        ["message-5", 1],
      ]);
      expect(navigatorHeaderLabels(rows)).toMatchObject({ humanCount: 2, hiddenCount: 0 });
      expect(filterNavigatorRows(rows, { search: "interrupted", showHidden: true })).toEqual([]);
    }
  });

  test("preserves real prompts discussing interruption notices and slash commands", () => {
    const messages = [
      "I interrupted the previous turn. Check which commands completed.",
      `Why does this appear? ${notice}`,
      "Why does <turn_aborted> render as text?",
      "<command-name>/commit</command-name>",
    ].map(message);
    expect(filterUserMessages(messages).map(row => row._id)).toEqual(messages.map(row => row._id));
    expect(buildNavigatorRows(messages).map(row => row._id)).toEqual(messages.map(row => row._id));
  });
});

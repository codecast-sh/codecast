import { expect, test } from "bun:test";
import { formatTyped, readTyped, type TypedPage } from "./typedCommand";

test("readTyped follows the cursor to the end and reports unix seconds", async () => {
  const pages: TypedPage[] = [
    { messages: [{ at: 1_795_389_100_123, session: "jx7a", chars: 10, kind: "message" }], next: 1_795_389_100_123 },
    { messages: [{ at: 1_795_389_200_999, session: "jx7b", chars: 0, kind: "decision_picked" }], next: null },
  ];
  const bodies: Record<string, unknown>[] = [];
  const report = await readTyped(async (body) => { bodies.push(body); return pages.shift()!; }, 1_795_379_200_000, 1_795_390_000_500);
  expect(bodies).toEqual([{ since: 1_795_379_200_000 }, { since: 1_795_379_200_000, after: 1_795_389_100_123 }]);
  expect(report).toEqual({
    now: 1_795_390_000,
    since: 1_795_379_200,
    messages: [
      { at: 1_795_389_100, session: "jx7a", chars: 10, kind: "message" },
      { at: 1_795_389_200, session: "jx7b", chars: 0, kind: "decision_picked" },
    ],
  });
});

test("readTyped refuses an answer without a message list, so the reader fails closed", async () => {
  await expect(readTyped(async () => ({ error: "x" }) as any, 0, 1000)).rejects.toThrow(/without a list/);
});

test("formatTyped says when nothing was typed", () => {
  expect(formatTyped({ now: 1, since: 0, messages: [] })).toBe("Nothing typed in this window.");
});

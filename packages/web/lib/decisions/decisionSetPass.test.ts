import { expect, test } from "bun:test";
import { decisionNav } from "./decisionSet";

// ct-101575: a pass through decisions holds one list from page to page, so the
// counter's total stays put and its position rises by one with each ›.

const queue = ["sd-1", "sd-2", "sd-3", "sd-4"];

test("a pass started from the Decisions list stays on that list when › lands on a decision also in the queue", () => {
  const list = ["sd-8", "sd-2", "sd-9"];
  const first = decisionNav({ named: [], list, queue }, ["sd-8"], null);
  expect(first).toMatchObject({ src: "list", at: 0, next: "sd-2" });
  const second = decisionNav({ named: [], list, queue }, [first.next!], first.slot);
  expect({ src: second.src, at: second.at, total: second.set.length }).toEqual({ src: "list", at: 1, total: 3 });
  expect(second).toMatchObject({ prev: "sd-8", next: "sd-9" });
});

test("a pass started in the queue stays there", () => {
  const list = ["sd-3", "sd-7"];
  const first = decisionNav({ named: [], list, queue }, ["sd-2"], null);
  const second = decisionNav({ named: [], list, queue }, [first.next!], first.slot);
  expect({ src: second.src, at: second.at, total: second.set.length }).toEqual({ src: "queue", at: 2, total: 4 });
});

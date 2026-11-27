import { expect, test } from "bun:test";
import { scrollEdges } from "../scrollEdges";

test("a fade on each edge only while content lies past it", () => {
  expect(scrollEdges(0, 300, 300)).toEqual({ left: false, right: false });
  expect(scrollEdges(0, 300, 500)).toEqual({ left: false, right: true });
  expect(scrollEdges(100, 300, 500)).toEqual({ left: true, right: true });
  expect(scrollEdges(200, 300, 500)).toEqual({ left: true, right: false });
});

import { beforeEach, expect, test } from "bun:test";
import { _navHistory, _resetNavHistory, forgetPath, noteJump, noteLocation, peekHistory, renameInHistory, stepHistory } from "./navHistory";

const at = (path: string, line: number) => ({ vaultId: "v", path, line, col: 1 });

beforeEach(_resetNavHistory);

test("small moves update the stop, jumps and other files add one", () => {
  noteLocation(at("a", 1));
  noteLocation(at("a", 5));
  noteLocation(at("a", 40));
  noteLocation(at("b", 3));
  expect(_navHistory().stack.map((l) => `${l.path}:${l.line}`)).toEqual(["a:5", "a:40", "b:3"]);
});

test("back and forward walk the stops; a new stop drops the forward ones", () => {
  noteLocation(at("a", 1), 0);
  noteLocation(at("b", 1), 0);
  noteLocation(at("c", 1), 0);
  expect(stepHistory(-1, 0)?.path).toBe("b");
  // Opening b lands the cursor there: no new stop.
  noteLocation(at("b", 1), 10);
  expect(stepHistory(-1, 20)?.path).toBe("a");
  noteLocation(at("a", 1), 30);
  expect(stepHistory(1, 40)?.path).toBe("b");
  noteLocation(at("b", 1), 50);
  noteLocation(at("d", 1), 5000);
  expect(_navHistory().stack.map((l) => l.path)).toEqual(["a", "b", "d"]);
  expect(stepHistory(1)).toBeNull();
});

test("peek never moves; a rename follows, a delete removes the stops", () => {
  noteLocation(at("a", 1));
  noteLocation(at("b", 1));
  noteLocation(at("c", 1));
  expect(peekHistory(-1)?.path).toBe("b");
  expect(_navHistory().index).toBe(2);
  renameInHistory("v", "b", "bb");
  expect(stepHistory(-1)?.path).toBe("bb");
  forgetPath("v", "bb");
  expect(_navHistory().stack.map((l) => l.path)).toEqual(["a", "c"]);
  expect(peekHistory(-1)?.path).toBe("a");
});

test("under vim, jumps make the stops: a near jump adds one, a far plain move does not", () => {
  const vim = { byDistance: false };
  noteLocation(at("a", 1), 0, vim);
  noteLocation(at("a", 40), 0, vim);
  noteJump();
  noteLocation(at("a", 43), 0, vim);
  noteLocation(at("a", 44), 0, vim);
  expect(_navHistory().stack.map((l) => `${l.path}:${l.line}`)).toEqual(["a:40", "a:44"]);
});

test("an explicit jump is a stop however near, with or without vim", () => {
  for (const opts of [{}, { byDistance: false }]) {
    _resetNavHistory();
    noteLocation(at("a", 100), 0, opts);
    noteJump();
    noteLocation(at("a", 95), 0, opts);
    expect(stepHistory(-1, 0)?.line).toBe(100);
  }
});

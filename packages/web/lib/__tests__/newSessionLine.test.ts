import { expect, test } from "bun:test";
import { contextNote, effortNote, shortMachineName } from "../newSessionLine";

test("a Mac's default hostname drops its owner on the line; other names stay as they are", () => {
  expect(shortMachineName("Alexanders-Mac-Studio")).toBe("Mac Studio");
  expect(shortMachineName("Rileys-MacBook-Air")).toBe("MacBook Air");
  expect(shortMachineName("Riley's MacBook Pro")).toBe("MacBook Pro");
  expect(shortMachineName("Chriss-iMac")).toBe("iMac");
  expect(shortMachineName("MacBook-Pro-4")).toBe("MacBook-Pro-4");
  expect(shortMachineName("Cloud Linux")).toBe("Cloud Linux");
  expect(shortMachineName("dev-box")).toBe("dev-box");
});

test("only a setting away from its default gets a note", () => {
  expect(effortNote(null)).toBeNull();
  expect(effortNote(undefined)).toBeNull();
  expect(effortNote("high")).toBe("high effort");
  expect(contextNote(null)).toBeNull();
  expect(contextNote("auto")).toBeNull();
  expect(contextNote("off")).toBe("no context");
  expect(contextNote("team")).toBe("team context");
  expect(contextNote("solo")).toBe("solo context");
});

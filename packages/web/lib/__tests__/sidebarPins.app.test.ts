import { describe, expect, it } from "bun:test";
import { pinApp } from "../sidebarPins";

describe("pinApp", () => {
  it("files channels and the threads inbox under chat, everything else under work", () => {
    expect(pinApp({ kind: "channel", id: "ch1" })).toBe("chat");
    expect(pinApp({ kind: "view", id: "threads" })).toBe("chat");
    expect(pinApp({ kind: "channel", id: "threads" })).toBe("chat");
    expect(pinApp({ kind: "project", id: "p1" })).toBe("work");
    expect(pinApp({ kind: "view", id: "v1" })).toBe("work");
  });
});

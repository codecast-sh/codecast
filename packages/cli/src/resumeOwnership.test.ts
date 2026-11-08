import { describe, expect, it } from "bun:test";
import { adoptConversationForResume, describeResumeOwnership } from "./resumeOwnership.js";

const HERE = "c5900012aaaaaaaa";
const LAPTOP = "4e2cfe0d258fb56c";

function deps(owner: string | null | Error, moveError?: Error) {
  const moves: string[] = [];
  return {
    moves,
    deps: {
      thisDeviceId: HERE,
      getOwnerDeviceId: async () => {
        if (owner instanceof Error) throw owner;
        return owner;
      },
      moveHere: async (path: string) => {
        if (moveError) throw moveError;
        moves.push(path);
      },
    },
  };
}

describe("adoptConversationForResume", () => {
  it("moves a session another machine owns onto this one, at the launch path", async () => {
    const d = deps(LAPTOP);
    const result = await adoptConversationForResume(d.deps, "/Users/a/.claude");
    expect(result).toEqual({ kind: "adopted", from: LAPTOP });
    expect(d.moves).toEqual(["/Users/a/.claude"]);
    expect(describeResumeOwnership(result, "jx7a66w")).toContain("messages sent from codecast now come here");
  });

  it("leaves a session this machine already owns alone", async () => {
    const d = deps(HERE);
    const result = await adoptConversationForResume(d.deps, "/p");
    expect(result).toEqual({ kind: "already_here" });
    expect(d.moves).toEqual([]);
    expect(describeResumeOwnership(result, "jx7a66w")).toBeNull();
  });

  it("claims an unowned session without announcing a move", async () => {
    const d = deps(null);
    const result = await adoptConversationForResume(d.deps, "/p");
    expect(result).toEqual({ kind: "adopted", from: null });
    expect(d.moves).toEqual(["/p"]);
    expect(describeResumeOwnership(result, "jx7a66w")).toBeNull();
  });

  it("reports a refused move with the server's reason and the way to move it by hand", async () => {
    const d = deps(LAPTOP, new Error("[Request ID: abc] Server Error\nUncaught Error: not your conversation\n    at handler (devices.ts:1:1)"));
    const result = await adoptConversationForResume(d.deps, "/p");
    expect(result).toEqual({ kind: "failed", error: "not your conversation" });
    const line = describeResumeOwnership(result, "jx7a66w")!;
    expect(line).toContain("not your conversation");
    expect(line).toContain("cast pull jx7a66w");
  });

  it("does not move when the owner lookup fails", async () => {
    const d = deps(new Error("fetch failed"));
    const result = await adoptConversationForResume(d.deps, "/p");
    expect(result).toEqual({ kind: "failed", error: "fetch failed" });
    expect(d.moves).toEqual([]);
  });
});

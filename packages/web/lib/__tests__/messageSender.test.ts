import { describe, expect, test } from "bun:test";
import { resolveMessageSender, type SenderContext } from "../messageSender";

const people: Record<string, { name: string; image?: string }> = {
  u_owner: { name: "Jason Benn", image: "https://x/j.png" },
  u_cam: { name: "Cam" },
};
const ctx: SenderContext = { ownerId: "u_owner", ownerName: "Jason Benn", ownerImage: "https://x/owner.png", viewerId: "u_cam", lookup: (id) => people[id] };

describe("resolveMessageSender", () => {
  test("the sending account wins when the roster names it", () => {
    expect(resolveMessageSender({ fromUserId: "u_cam", wireFrom: "Aivery" }, ctx)).toEqual({ key: "u_cam", name: "Cam", image: null });
  });

  test("a row the viewer just sent is theirs before the server stamps an account on it", () => {
    expect(resolveMessageSender({ pending: true }, ctx).key).toBe("u_cam");
  });

  test("a wrapper's name stands in when the account is unknown or absent", () => {
    expect(resolveMessageSender({ fromUserId: "u_stranger", wireFrom: "Aivery" }, ctx)).toEqual({ key: "name:aivery", name: "Aivery", image: null });
    expect(resolveMessageSender({ wireFrom: "Aivery" }, ctx).name).toBe("Aivery");
  });

  test("an account nobody can name is Someone, never the owner", () => {
    expect(resolveMessageSender({ fromUserId: "u_stranger" }, ctx)).toEqual({ key: "u_stranger", name: "Someone", image: null });
  });

  test("rows with no sender are the owner's, with the owner's face", () => {
    expect(resolveMessageSender({}, ctx)).toEqual({ key: "u_owner", name: "Jason Benn", image: "https://x/owner.png" });
  });
});

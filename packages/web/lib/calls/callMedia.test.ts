import { describe, expect, test } from "bun:test";
import { stageTiles, type ParticipantTile } from "./callMedia";

const tile = (identity: string, kind: "camera" | "screen", isLocal: boolean) =>
  ({ key: `${identity}:${kind}`, identity, name: identity, isLocal, kind, track: {} as any }) as ParticipantTile;

describe("stageTiles", () => {
  test("keeps your own screen share, after everyone else's, and every camera", () => {
    const { screens, cameras } = stageTiles([
      tile("me", "camera", true),
      tile("me", "screen", true),
      tile("cam", "camera", false),
      tile("cam", "screen", false),
    ]);
    expect(screens.map((t) => t.key)).toEqual(["cam:screen", "me:screen"]);
    expect(cameras.map((t) => t.key)).toEqual(["me:camera", "cam:camera"]);
  });
});

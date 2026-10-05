import { describe, expect, it } from "bun:test";
import { agentFaceIdentity, guestIdentity } from "@codecast/shared/contracts";
import { speakerShortName } from "../speakers";

// A speaker's name in plain text carries the same mark the phone and the
// badge use: a guest and an agent's face never read as a teammate.
describe("speakerShortName", () => {
  it("marks guests by identity or the room's mark, agents by identity, teammates never", () => {
    expect(speakerShortName("Ada Lovelace (guest)")).toBe("Ada (guest)");
    expect(speakerShortName("Ada Lovelace", guestIdentity("g1"))).toBe("Ada (guest)");
    expect(speakerShortName("Fig", agentFaceIdentity("conv1"))).toBe("Fig (agent)");
    expect(speakerShortName("Ann Lee", "u2")).toBe("Ann");
    expect(speakerShortName(undefined)).toBe("teammate");
  });
});

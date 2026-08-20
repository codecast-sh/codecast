import { describe, expect, it } from "bun:test";
import { supersededChannelId } from "../useChatSync";

// A channel created optimistically lives under a stub id until the server row
// supersedes it; the server row keeps the stub as client_id. Anything that
// stored the stub id (a URL, a sidebar pin) forwards through it. The sidebar's
// pinned rail leans on this to dedupe a pinned channel out of the Chat sublist
// and to hang the live badge on the pin.
describe("supersededChannelId", () => {
  const channels = {
    real1: { _id: "real1", client_id: "chatstub-abc" },
    real2: { _id: "real2" },
  } as any;

  it("forwards a dead stub id to the server row that superseded it", () => {
    expect(supersededChannelId(channels, "chatstub-abc")).toBe("real1");
  });

  it("stays put while the id still resolves or looks like a real id", () => {
    // A live key needs no forwarding — the reader is already on its channel.
    expect(supersededChannelId(channels, "real1")).toBeUndefined();
    // A Convex id absent from the cache is a pruned/foreign channel, not a
    // stub — forwarding by client_id would be a false match.
    expect(supersededChannelId(channels, "hx7pxdhcb6qp6tpygjwk7vtmy98ch7p5")).toBeUndefined();
    expect(supersededChannelId(channels, undefined)).toBeUndefined();
    expect(supersededChannelId(channels, "chatstub-unknown")).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { LINK_DEFAULTS } from "@codecast/convex/convex/lib/slackMirror";
import { slackComposerDelivery } from "../slackDelivery";
import type { ChatSlackLinkRow } from "../../store/chatSlice";

const link = {
  kind: "dm", direction: "both", options: LINK_DEFAULTS,
  viewer_user_id: "alice", viewer_slack_auth: "ready",
  slack_channel_name: "testing", slack_channel_id: "C123",
} as ChatSlackLinkRow;

describe("Slack composer delivery", () => {
  test("cached permission for another sender never enables a DM send", () => {
    expect(slackComposerDelivery(link, "alice")).toEqual({ destination: "Slack", auth: "ready" });
    expect(slackComposerDelivery(link, "bob")?.auth).toBe("checking");
    expect(slackComposerDelivery(link, undefined)?.auth).toBe("checking");
    expect(slackComposerDelivery({ ...link, viewer_slack_auth: undefined }, "alice")?.auth).toBe("checking");
  });
  test("missing and older authorizations need an inline connection", () => {
    expect(slackComposerDelivery({ ...link, viewer_slack_auth: "connect" }, "alice")?.auth).toBe("connect");
    expect(slackComposerDelivery({ ...link, viewer_slack_auth: "reconnect" }, "alice", true)?.auth).toBe("reconnect");
  });
  test("channel messages can use the app while disabled mirrors offer no send", () => {
    expect(slackComposerDelivery({ ...link, kind: "channel" }, "bob")).toEqual({ destination: "Slack #testing", auth: "ready" });
    expect(slackComposerDelivery({ ...link, paused: true }, "alice")).toBeNull();
    expect(slackComposerDelivery({ ...link, direction: "slack_to_codecast" }, "alice")).toBeNull();
    expect(slackComposerDelivery({ ...link, options: { ...LINK_DEFAULTS, threads: false } }, "alice", true)).toBeNull();
    expect(slackComposerDelivery(null, "alice")).toBeNull();
  });
});

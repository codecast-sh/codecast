import { describe, expect, test } from "bun:test";
import { buildThreadHandoff } from "@codecast/convex/convex/chatWakePrompts";
import { parseChatWakePrompt, chatWakeAction } from "../components/sessionMessage";
import { handAgentLabel, handAgentType, handLedger } from "./handToAgent";

const facts = { place: "#general", preview: "the deploy test flakes on CI", lines: 3, agentType: "claude_code", folder: "/Users/a/src/app", machine: "MacBook-Pro" };

describe("handLedger", () => {
  test("names the act, the brief size and where the answer lands", () => {
    const l = handLedger(facts);
    expect(l.name).toBe("Hand to agent");
    expect(l.subject).toBe("#general");
    expect(l.figures.map((f) => f.value)).toEqual(["1", "3"]);
    expect(l.pick).toEqual({ k: "Agent", options: ["Claude Code", "Codex"], value: "Claude Code" });
    expect(l.rows.map((r) => r.k)).toEqual(["Thread", "Answers", "Replies"]);
    expect(l.confirm).toBe("Start agent");
    expect(l.blocked).toBeUndefined();
  });

  test("blocks without a folder or a machine, and warns when it takes the thread from another session", () => {
    expect(handLedger({ ...facts, folder: "" }).blocked).toBe("Pick a folder");
    expect(handLedger({ ...facts, folder: "", machine: null }).blocked).toBe("No machine to run it on");
    expect(handLedger({ ...facts, held: true }).blocked).toBe("Handed to someone else's session");
    expect(handLedger({ ...facts, machine: "Mac", machineOffline: true }).rows.find((r) => r.k === "Starts")?.v).toBe("When Mac is back online");
    expect(handLedger({ ...facts, machine: null }).blocked).toBe("No machine to run it on");
    expect(handLedger({ ...facts, rebind: "Session jx7abcd" }).rows.at(-1)).toEqual({ k: "Takes over", v: "Session jx7abcd", tone: "warn" });
  });

  test("clips a long root to one glance", () => {
    const v = handLedger({ ...facts, preview: "x ".repeat(400) }).rows[0].v;
    expect(v.length).toBeLessThanOrEqual(120);
    expect(v.endsWith("…")).toBe(true);
  });

  test("agent labels round-trip", () => {
    expect(handAgentType(handAgentLabel("codex"))).toBe("codex");
    expect(handAgentLabel("gemini")).toBe("Claude Code");
  });
});

describe("the handoff brief in a transcript", () => {
  test("reads as a chat wake a person handed over, with the thread quoted", () => {
    const wire = buildThreadHandoff({
      channelName: "general", channelKind: undefined, channelTopic: undefined, channelId: "hx7chan" as any, teamName: "Acme",
      threadRootId: "j17root" as any, askerName: "Alice", handed: { name: "Bob", content: "only on the cache step" }, nonce: "abcdef012345", channelEntries: [],
      entries: [{ name: "Alice", content: "the deploy test flakes" }, { name: "Bob", content: "only on the cache step" }],
    });
    const r = parseChatWakePrompt(wire)!;
    expect(r.askerName).toBe("Alice");
    expect(r.handed).toBe(true);
    expect(chatWakeAction(r)).toBe("handed you a thread");
    expect(r.threadRootId).toBe("j17root");
    expect(r.entries.map((e) => e.name)).toEqual(["Alice", "Bob"]);
    expect(wire).toContain("(written by Bob), together with Alice's own lines in the thread:\n  > only on the cache step");
  });
});

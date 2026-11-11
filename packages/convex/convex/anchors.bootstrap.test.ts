import { describe, expect, test } from "bun:test";
import { bootstrapMessage } from "./anchors";
import { SAY_GUIDANCE } from "./lib/anchorBootstrap";
import { isBootstrapPrompt } from "@codecast/shared/contracts";

// A role's opening message (org-roles-standing.md T1): who it is and whom it
// reports to, what it looks after, how it wakes, that its sessions stay out of the
// person's inbox, that the person reads only what it says with `cast say`,
// and that its brief is its memory, in under 300 plain words.
const opening = (startsOnItsOwn: boolean, cleanChat = true) => bootstrapMessage({
  name: "Calling", scopeType: "team", scopeLabel: "the Union workspace", teamName: "Union", cleanChat,
  role: { handle: "calling", scopeNames: ["project Callers & Call Management"], parentName: "Head of People (@head-of-people)", parentHandle: "head-of-people", startsOnItsOwn },
});

describe("a role's opening message", () => {
  test("says who it is, whom it reports to, what it looks after, how it wakes, how it passes a request up and where it remembers", () => {
    const m = opening(true);
    expect(m.startsWith("You are the **Calling** (@calling) in Union. You report to Head of People (@head-of-people).")).toBe(true);
    expect(m).toContain("You look after project Callers & Call Management");
    expect(m).toContain('cast role wake @head-of-people "<what they will decide and why>"');
    expect(m).toContain("Start every turn with `cast brief`");
    expect(m).toContain("stay out of the person's inbox");
    expect(m).not.toContain("cast escalate");
    expect(m).toContain("What you cannot answer goes up");
    expect(m).toContain("Your brief is your memory between turns");
    expect(m).toContain("`## Where it stands`");
    // It works at its level and hands the hands-on work to sessions (roleLevel.ts), by its switch.
    expect(m).toContain("Work at the level of your seat");
    expect(m).toContain("`cast spawn --subagent`");
    expect(opening(false)).toContain("You do not start work on your own");
    expect(opening(false)).not.toContain("`cast spawn --subagent`");
    expect(m).toContain(SAY_GUIDANCE);
    // The decision it presents is answered from the record (decisionDiscussion.ts).
    expect(m).toContain("A person may ask you about a decision you present");
    expect(m.split(/\s+/).length).toBeLessThan(450);
    expect(isBootstrapPrompt(m)).toBe(true);
  });

  // Clean chat is the seat's switch (anchors.clean_chat): off, its thread
  // shows the whole transcript and the person reads each turn's last message.
  test("with clean chat off it answers in its last message, not with cast say", () => {
    const m = opening(true, false);
    expect(m).not.toContain("cast say");
    expect(m).toContain("The person sees only your last message of each turn");
    expect(m).toContain("post a one-line hello");
  });

  // Scope is opt in (org-staffing.md S26).
  test("a role with no scope is told it looks after no area, never that the workspace is its own", () => {
    const m = bootstrapMessage({ name: "Release", scopeType: "team", scopeLabel: "the Union workspace", teamName: "Union", role: { handle: "release", scopeNames: [], parentName: "Ashot", startsOnItsOwn: true } });
    expect(m).toContain("You look after no area of your own: you run your routine and answer what you are asked.");
    expect(m).not.toMatch(/whole workspace|You own/);
    expect(m).toContain("raise it in this thread");
    expect(isBootstrapPrompt(m)).toBe(true);
  });

  test("the head of people's keeps the structure, and the inbox still knows it as the seat's", () => {
    const m = bootstrapMessage({ name: "Head of People", scopeType: "team", scopeLabel: "the Union workspace", teamName: "Union", role: { handle: "head-of-people", scopeNames: [], parentName: "Ashot", startsOnItsOwn: false } });
    expect(m.startsWith("You are the Head of People for Union. You report to Ashot.")).toBe(true);
    expect(m).toContain("keep the company's structure true");
    // The review is one of its jobs, run by its routine, not its opening.
    expect(m).not.toContain("## Talk it through");
    expect(m.endsWith("Read `cast brief` now.")).toBe(true);
    // How a standing role works comes from the one shared text, said once.
    expect(m).toContain("Start every turn with `cast brief`");
    expect(m).toContain("raise it in this thread");
    expect(m).toContain("Your brief is your memory between turns");
    expect(m.split("Start every turn").length).toBe(2);
    expect(m.split(/\s+/).length).toBeLessThan(540);
    expect(isBootstrapPrompt(m)).toBe(true);
  });

  test("an assistant's is the right hand's, built from its reach (org-staffing.md S30)", () => {
    const m = bootstrapMessage({ name: "Executive Assistant", scopeType: "user", scopeLabel: "personal", ownerName: "Ashot", cleanChat: true, role: { handle: "executive-assistant", scopeNames: [], parentName: "Ashot", startsOnItsOwn: true, assistantOpening: "You are Ada, Ashot's Executive Assistant for everything Ashot works on." } });
    expect(m.startsWith("You are Ada, Ashot's Executive Assistant")).toBe(true);
    expect(m).toContain("Read `cast brief` now, say a one-line hello, then stand by.");
    expect(m).toContain("Start every turn with `cast brief`");
    expect(isBootstrapPrompt(m)).toBe(true);
  });
});

// A workspace agent's opening says who can read its own conversation, from
// the conversation's real visibility: a personal agent in a directory shared
// with a team is not told its conversation is private.
describe("a workspace agent's opening", () => {
  const facts = { name: "Fern", scopeLabel: "the Fernhill workspace", ownerName: "Theo", teamName: "Fernhill" };
  test("talks with cast say only when its clean chat is on", () => {
    expect(bootstrapMessage({ ...facts, scopeType: "team", cleanChat: true })).toContain(SAY_GUIDANCE);
    expect(bootstrapMessage({ ...facts, scopeType: "team" })).not.toContain("cast say");
  });
  test("a team agent is told the whole team reads this conversation", () => {
    const m = bootstrapMessage({ ...facts, scopeType: "team" });
    expect(m).toContain("standing agent for Fernhill: every member of that team can reach you and read this conversation");
    expect(m).not.toContain(" — every member");
  });
  test("a personal agent is told it is private only when its conversation is", () => {
    const own = bootstrapMessage({ ...facts, scopeType: "user" });
    expect(own).toContain("standing agent for Theo: private to them");
    const shared = bootstrapMessage({ ...facts, scopeType: "user", sharedWithTeam: "Fernhill" });
    expect(shared).not.toContain("private to them");
    expect(shared).toContain("this conversation is shared with Fernhill, and every member of that team can read it");
    expect(isBootstrapPrompt(shared)).toBe(true);
  });
});

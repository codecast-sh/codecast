import { describe, expect, test } from "bun:test";
import { parseRouterReply, ROUTER_CONFIDENT, ROUTER_MARGIN, routerDecision, routerRequest, rosterText, type RouterRoster } from "./orgRouter";

// The semantic router (org-staffing.md S35): the prompt carries the roster
// in its own words, the reply is read strictly, and filing needs confidence
// clear of the runner-up.

const roster: RouterRoster = {
  workspace: "Union",
  roles: [
    { handle: "head-of-people", name: "Head of People", areas: [], standing: [], holding: [], whole_workspace: true },
    { handle: "cold-email", name: "Cold Email lead", charter: "Keeps the sender pool warm and the reply rate up.", areas: [{ kind: "plan", title: "Warm the sender pool", goal: "60 warmed domains" }], standing: ["Warm the sender pool: 12 of 60 warmed (2026-09-30)"], holding: ["task: Rotate the bounced domains"] },
    { handle: "calling", name: "Calling lead", charter: "Keeps Cameron's calling work moving.", areas: [{ kind: "project", title: "Callers & Call Management" }], standing: [], holding: [] },
    { handle: "release", name: "Release lead", charter: "Walks the merge train.", areas: [], standing: [], holding: [] },
  ],
  unled: [{ kind: "project", title: "Matching Engine & Funnel", goal: "more introductions" }],
};

describe("routerRequest", () => {
  test("the prompt carries every role's charter, areas, standing and holding, then the request", () => {
    const req = routerRequest(roster, "The bounce rate on the new domains doubled overnight");
    expect(req.system).toContain("Answer with JSON only");
    expect(req.prompt).toContain("## @cold-email: Cold Email lead");
    expect(req.prompt).toContain('plan "Warm the sender pool" (goal: 60 warmed domains)');
    expect(req.prompt).toContain("Where it stands: Warm the sender pool: 12 of 60 warmed (2026-09-30)");
    expect(req.prompt).toContain("Holding: task: Rotate the bounced domains");
    expect(req.prompt).toContain("looks after the whole workspace");
    expect(req.prompt.endsWith("The request:\n\nThe bounce rate on the new domains doubled overnight")).toBe(true);
    expect(rosterText(roster)).toContain("Areas: none (a standing role");
    // The areas no role names are the Head of People's by the rule, and the router is told so.
    expect(req.prompt).toContain('## Areas no role names (the whole workspace role\'s, @head-of-people)\nproject "Matching Engine & Funnel" (goal: more introductions)');
    expect(req.system).toContain("a charter that merely sounds close to the request is not ownership");
    expect(rosterText({ ...roster, unled: [] })).toContain("none: every area has a role");
  });
});

describe("parseRouterReply", () => {
  test("reads the JSON, drops handles the roster lacks, clamps confidence, sorts alternatives", () => {
    const r = parseRouterReply('Here it is:\n```json\n{"handle":"@Cold-Email","confidence":1.4,"reason":"its charter keeps the sender pool warm","alternatives":[{"handle":"nobody","confidence":0.5,"reason":"x"},{"handle":"calling","confidence":0.2,"reason":"calls"},{"handle":"head-of-people","confidence":0.3,"reason":"rest"}]}\n```', roster);
    expect(r).toEqual({ handle: "cold-email", confidence: 1, reason: "its charter keeps the sender pool warm", alternatives: [{ handle: "head-of-people", confidence: 0.3, reason: "rest" }, { handle: "calling", confidence: 0.2, reason: "calls" }] });
  });
  test("an unknown handle is no handle, and unreadable text is null", () => {
    expect(parseRouterReply('{"handle":"growth","confidence":0.9,"reason":"r"}', roster)).toMatchObject({ handle: null, confidence: 0 });
    expect(parseRouterReply("I am not sure.", roster)).toBeNull();
  });
});

describe("routerDecision", () => {
  const reply = (confidence: number, alt?: number) => ({ handle: "cold-email", confidence, reason: "r", alternatives: alt === undefined ? [] : [{ handle: "calling", confidence: alt, reason: "a" }] });
  test("files when confident and clear of the runner-up", () => {
    expect(routerDecision(reply(ROUTER_CONFIDENT))).toMatchObject({ kind: "file", handle: "cold-email" });
    expect(routerDecision(reply(0.9, 0.9 - ROUTER_MARGIN))).toMatchObject({ kind: "file" });
  });
  test("asks with the choices, best first, when not", () => {
    expect(routerDecision(reply(ROUTER_CONFIDENT - 0.01))).toMatchObject({ kind: "ask", choices: [{ handle: "cold-email" }] });
    const close = routerDecision(reply(0.9, 0.7));
    expect(close.kind).toBe("ask");
    expect(close.kind === "ask" && close.choices.map((c) => c.handle)).toEqual(["cold-email", "calling"]);
    expect(routerDecision(null)).toMatchObject({ kind: "ask", choices: [] });
    expect(routerDecision({ handle: null, confidence: 0, reason: "", alternatives: [{ handle: "calling", confidence: 0.4, reason: "a" }] })).toMatchObject({ kind: "ask", choices: [{ handle: "calling" }] });
  });
});

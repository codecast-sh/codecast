import { describe, expect, test } from "bun:test";
import { changeLine, describeOrgChange, orgChangeError, orgProposalWorkErrors, parseOrgProposalSpec, type OrgChange } from "./orgProposal";
import { changeWords } from "./orgChangeWords";
import { orgLogRowChange } from "./orgChange";
import { ownProfilesOnly } from "./orgPersonProfile";

const evidence = { window_days: 30, sessions: 41, commits: 120, tasks_closed: 9, decisions_answered: 6, calls_led: 2, projects: ["Eval Suite", "AgentWatch"] };
const profile = (over: Record<string, unknown> = {}) => ({ kind: "person_profile", person: "@jason", title: "Head of Agentic Quality", focus: "evals, agent quality", evidence, ...over });
const spec = (changes: unknown[]) => ({ title: "Profiles", summary_md: "Two profiles.", mode: "review", changes: changes.map((change) => ({ change, rationale: "read from the month" })) });

describe("person_profile, the change", () => {
  test("parses with its evidence", () => {
    expect(orgChangeError(profile())).toBeNull();
    expect(parseOrgProposalSpec(spec([profile()])).errors).toEqual([]);
  });

  test("refuses a change that proposes nothing, lacks evidence or breaks the profile's limits", () => {
    expect(orgChangeError({ kind: "person_profile", person: "@jason", evidence })).toMatch(/at least one of/);
    expect(orgChangeError(profile({ evidence: undefined }))).toMatch(/needs evidence/);
    expect(orgChangeError(profile({ evidence: { ...evidence, commits: -1 } }))).toMatch(/commits is a whole number/);
    expect(orgChangeError(profile({ title: "x".repeat(61) }))).toMatch(/at most 60 characters/);
    expect(orgChangeError(profile({ person: "" }))).toMatch(/needs person/);
  });

  test("is its own kind of work: profiles never share a proposal with structure", () => {
    const mixed = [{ change: profile() }, { change: { kind: "retire", handle: "growth" } }];
    expect(orgProposalWorkErrors(mixed)[0]).toMatch(/2 profile|1 profile change/);
    expect(orgProposalWorkErrors([{ change: profile() }, { change: profile({ person: "@ada" }) }])).toEqual([]);
  });

  test("reads as a first profile or as the fields that drifted", () => {
    const first = profile({ name: "Jason Benn" }) as OrgChange;
    expect(changeLine(first)).toMatch(/Jason Benn's profile/);
    const drift = profile({ name: "Jason Benn", title: undefined, focus: "evals", before: { title: "Agent Quality", focus: "agent quality" } }) as OrgChange;
    expect(changeLine(drift)).toMatch(/change Jason Benn's focus/i);
    expect(describeOrgChange(first)).toBe('profile Jason Benn: title "Head of Agentic Quality", focus "evals, agent quality"');
  });

  test("its card draws each field before and after, then the evidence", () => {
    const c = profile({ name: "Jason Benn", labels: ["evals"], before: { title: "Agent Quality", labels: ["quality"] } }) as OrgChange;
    const fields = changeWords(c).fields;
    const by = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(by.title.op).toBe("change");
    expect(by.title.before?.text).toBe("Agent Quality");
    expect(by.title.after?.text).toBe("Head of Agentic Quality");
    expect(by.focus.before?.none).toBe(true);
    expect(by.labels.after?.items).toEqual(["evals"]);
    expect(by.evidence.after?.text).toBe("41 sessions · 120 commits · 9 tasks closed · 6 decisions · 2 calls led, over 30 days");
    expect(by.worked_on.after?.items).toEqual(["Eval Suite", "AgentWatch"]);
  });

  test("a log row reads back as the profile it wrote", () => {
    const row = { kind: "person_profile", subject: { type: "person", id: "m1", label: "Jason Benn" }, before: { profile: { title: "Agent Quality" } }, after: { profile: { title: "Head of Agentic Quality" } }, effects: {}, labels: {} } as any;
    const c = orgLogRowChange(row) as any;
    expect(c.kind).toBe("person_profile");
    expect(c.title).toBe("Head of Agentic Quality");
    expect(changeLine(c)).toMatch(/change Jason Benn's title/i);
  });
});

describe("who decides a profile change without being an admin", () => {
  const row = (user_id: string, status = "proposed") => ({ status, change: { kind: "person_profile", user_id } });
  test("the person, when every change is theirs", () => {
    expect(ownProfilesOnly("u1", [row("u1")])).toBe(true);
    expect(ownProfilesOnly("u1", [row("u1"), row("u2", "removed")])).toBe(true);
  });
  test("nobody else, and never through another kind or an empty set", () => {
    expect(ownProfilesOnly("u1", [row("u1"), row("u2")])).toBe(false);
    expect(ownProfilesOnly("u1", [{ status: "proposed", change: { kind: "retire" } }])).toBe(false);
    expect(ownProfilesOnly("u1", [])).toBe(false);
    expect(ownProfilesOnly(undefined, [row("u1")])).toBe(false);
  });
});

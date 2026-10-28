import { describe, expect, test } from "bun:test";
import { changeLine, deriveAsks, orgChangeError, orgProposalWork, orgProposalWorkErrors } from "./orgProposal";
import { changeWords } from "./orgChangeWords";
import { sessionDestination } from "./orgSessionFiling";

// The person's sessions filed where they belong (org-staffing.md S43): what a
// filing may name, and how the card reads one and a batch of them.

const row = (seq: number, session: string, to: string, title?: string) => ({ seq, change: { kind: "file_session" as const, session, to, ...(title ? { title } : {}) }, status: "proposed" as const, rationale: "" });

describe("a filing", () => {
  test("goes under a role, onto a task, or out as done, and nowhere else", () => {
    expect(sessionDestination("@Growth")).toEqual({ kind: "role", handle: "growth" });
    expect(sessionDestination("ct-12")).toEqual({ kind: "task", task: "ct-12" });
    expect(sessionDestination("done")).toEqual({ kind: "done" });
    expect(sessionDestination("growth")).toBeNull();
    expect(orgChangeError({ kind: "file_session", session: "jx7abcd", to: "pr-3" })).toContain('to is "@handle"');
    expect(orgChangeError({ kind: "file_session", session: "jx7abcd", to: "@growth" })).toBeNull();
  });

  test("reads as where the session goes, by its title", () => {
    expect(changeLine(row(1, "jx7abcd", "@growth", "Launch thread").change, { brief: true, names: { role: (h) => (h === "growth" ? "Growth lead" : undefined) } })).toBe("Put the session Launch thread under Growth lead");
    expect(changeLine(row(1, "jx7abcd", "done", "Bump Node").change, { brief: true })).toBe("Close the session Bump Node as done");
    expect(changeWords(row(1, "jx7abcd", "ct-7", "Refunds").change).fields.map((f) => [f.label, f.after?.text])).toEqual([["Session", "Refunds"], ["Joins", "ct-7"]]);
  });

  test("a batch is its own kind of work and one ask that says where they go", () => {
    const rows = [row(1, "a", "@growth"), row(2, "b", "@growth"), row(3, "c", "ct-7"), row(4, "d", "done")];
    expect(orgProposalWork(rows)).toBe("sessions");
    const asks = deriveAsks(rows);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ title: "File 4 sessions where they belong", effect: "2 under @growth, 1 onto tasks and 1 closed as done. They leave your inbox; nothing stops running.", seqs: [1, 2, 3, 4] });
  });

  test("under a role the same proposal creates, rides in that role's ask as one structure proposal", () => {
    const role = { seq: 1, change: { kind: "role" as const, handle: "mobile", name: "Head of Mobile", reports_to: "@cam" } as any, status: "proposed" as const, rationale: "" };
    const rows = [role, row(2, "jx7ios1", "@mobile", "iOS app launch"), row(3, "jx7and1", "@mobile", "Android app store release")];
    expect(orgProposalWork(rows)).toBe("structure");
    expect(orgProposalWorkErrors(rows)).toEqual([]);
    const asks = deriveAsks(rows);
    expect(asks).toHaveLength(1);
    expect(asks[0].seqs).toEqual([1, 2, 3]);
    expect(asks[0].effect).toContain('The session "iOS app launch" moves under it.');
    // A filing under a role that already exists is still its own kind of work.
    expect(orgProposalWorkErrors([role, row(4, "jx7old1", "@growth")])[0]).toContain("mixes");
  });
});

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Command } from "commander";
import { orgLogEntryLine, type OrgLogEntry } from "@codecast/shared/contracts/orgChange";
import { orgLogFixture } from "../../web/components/org/history/orgLogFixture";
import { registerOrgInitCommands, type OrgInitDeps } from "./orgInit";
import { refuseOrgUndo, showOrgLog } from "./orgHistoryRun";

const deps: OrgInitDeps = {
  cliPost: async () => { throw new Error("unexpected HTTP call"); },
  readWorkspace: async (team) => team === "personal" ? { kind: "personal" } : { kind: "team", id: "team-a" },
  workspaceArgs: (ws) => ws.kind === "team" ? { team_id: ws.id } : {},
  workspaceLabel: (ws) => ws.kind === "team" ? "Acme" : "personal",
  webUrl: () => "https://codecast.sh/",
  callingSession: () => "session-a",
  realCwd: () => "/tmp",
};

afterEach(() => mock.restore());

function output() {
  const lines: string[] = [];
  spyOn(console, "log").mockImplementation((line) => { lines.push(String(line)); });
  spyOn(console, "error").mockImplementation((line) => { lines.push(String(line)); });
  return lines;
}

function trapExit() {
  spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit ${code}`); });
}

describe("org history commands", () => {
  test("registers the filters and browser-only undo on the existing org group", () => {
    const program = new Command();
    const org = program.command("org");
    registerOrgInitCommands(program, deps);
    const log = org.commands.find((c) => c.name() === "log")!;
    expect(log.options.map((o) => o.long)).toEqual(["--role", "--since", "--team", "--json"]);
    expect(org.commands.find((c) => c.name() === "undo")?.description()).toContain("person");
  });

  test("sends the actual query's workspace, role and numeric since arguments", async () => {
    output();
    const now = 1_790_000_000_000;
    spyOn(Date, "now").mockReturnValue(now);
    const query = mock(async () => ({ entries: [], has_more: false }));
    await showOrgLog(deps, { team: "Acme", role: "@growth", since: "7d" }, query);
    expect(query.mock.calls).toEqual([[{ team_id: "team-a", role: "@growth", since: now - 7 * 86_400_000, limit: 100 }]]);
  });

  test("personal has no team and no implicit time filter", async () => {
    const lines = output();
    const query = mock(async () => ({ entries: [], has_more: false }));
    await showOrgLog(deps, { team: "personal" }, query);
    expect(query.mock.calls).toEqual([[{ limit: 100 }]]);
    expect(lines.join("\n")).toContain("No org changes match");
  });

  test("prints shared sentences, actor and door, newest first, with undo attribution", async () => {
    const lines = output();
    const entries = orgLogFixture(Date.now()).entries;
    await showOrgLog(deps, {}, async () => ({ entries: [...entries].reverse(), has_more: true }));
    const text = lines.join("\n");
    expect(text).toContain("Today\n");
    expect(text.indexOf(orgLogEntryLine(entries[0]))).toBeLessThan(text.indexOf(orgLogEntryLine(entries[1])));
    expect(text).toContain("100 records");
    expect(text).toContain("Ashot Petrosian");
    expect(text).toContain("proposal op-7");
    expect(text).toContain("Taken back by Ashot Petrosian");
    expect(text).toContain("Narrow with --role or --since");
  });

  test("JSON preserves entries and truncation status without human prose", async () => {
    const lines = output();
    const result = { entries: orgLogFixture(Date.now()).entries, has_more: false };
    await showOrgLog(deps, { json: true }, async () => result);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(result);
  });

  test.each(["0d", "-1h", "yesterday", "1.5d", "9".repeat(400) + "d"])("refuses invalid --since %s before querying", async (since) => {
    const lines = output();
    trapExit();
    const query = mock(async () => ({ entries: [] as OrgLogEntry[], has_more: false }));
    await expect(showOrgLog(deps, { since }, query)).rejects.toThrow("exit 1");
    expect(query).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("--since needs a positive duration");
  });

  test("refused access never prints an empty history", async () => {
    const lines = output();
    trapExit();
    await expect(showOrgLog(deps, {}, async () => null)).rejects.toThrow("exit 1");
    expect(lines).toEqual(["You are not a member of Acme."]);
  });

  test("undo refuses locally and names History on the page", () => {
    const lines = output();
    trapExit();
    expect(() => refuseOrgUndo(deps)).toThrow("exit 1");
    expect(lines.join("\n")).toContain("Sessions cannot undo org changes");
    expect(lines.join("\n")).toContain("Open History");
    expect(lines.join("\n")).toContain("https://codecast.sh/org");
    expect(lines.join("\n")).not.toContain("sh//org");
  });
});

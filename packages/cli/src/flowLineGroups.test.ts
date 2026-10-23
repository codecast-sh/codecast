// `cast flow` carries every working subcommand `cast line` has (flows.md FL0): one registration under both names, so
// scripts and station files that call `cast line …` keep running while people and prompts read `cast flow …`.
import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { commandGroup } from "./commandGroups";

const names = (cmd: Command | undefined) => (cmd?.commands ?? []).map((c) => c.name());

describe("cast flow and cast line", () => {
  test("cast flow holds every cast line subcommand, beside the library's and the live flows' own", async () => {
    const program = new Command();
    const deps = { flow: {} } as never;
    (await commandGroup("flow").load())(program, deps);
    (await commandGroup("line").load())(program, deps);
    const flow = program.commands.find((c) => c.name() === "flow");
    const line = program.commands.find((c) => c.name() === "line");
    expect(names(line).length).toBeGreaterThan(10);
    for (const n of names(line)) expect(names(flow)).toContain(n);
    for (const n of ["ls", "show", "run", "on", "off"]) expect(names(flow)).toContain(n);
    expect(commandGroup("line").hidden).toBe(true);
    expect((line as unknown as { _hidden?: boolean })._hidden).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { FleetInventory, splitBatchOutput } from "./tmuxFleetInventory.js";

const A = ["list-sessions", "-F", "#{session_name}"];
const B = ["list-panes", "-a", "-F", "#{pane_pid}"];

/** A fake server: answers each tagged command in a chain with its own rows, records every client. */
function fakeServer(rows: Record<string, string[]>, opts: { fail?: (argv: string[]) => unknown } = {}) {
  const calls: string[][] = [];
  const exec = async (argv: string[]) => {
    calls.push(argv);
    const failure = opts.fail?.(argv);
    if (failure) throw failure;
    const cmds: string[][] = [[]];
    for (const word of argv) word === ";" ? cmds.push([]) : cmds[cmds.length - 1].push(word);
    return cmds.map((cmd) => {
      const f = cmd.indexOf("-F");
      const format = cmd[f + 1];
      const prefix = format.match(/^@@ccinv\d+@@/)?.[0] ?? "";
      const base = format.slice(prefix.length);
      return (rows[base] ?? []).map((r) => `${prefix}${r}\n`).join("");
    }).join("");
  };
  return { calls, exec };
}

function clock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("FleetInventory", () => {
  test("listings with different formats share one client per server inside the window", async () => {
    const c = clock();
    const inv = new FleetInventory(c.now, 2_000);
    const s = fakeServer({ "#{session_name}": ["cc-a"], "#{pane_pid}": ["11", "12"] });
    expect(await inv.read("srv", A, s.exec)).toBe("cc-a\n");
    expect(await inv.read("srv", B, s.exec)).toBe("11\n12\n");
    expect(s.calls.length).toBe(2); // B was new, so its first read asked again, carrying A along
    c.advance(1_500);
    expect(await inv.read("srv", A, s.exec)).toBe("cc-a\n");
    expect(await inv.read("srv", B, s.exec)).toBe("11\n12\n");
    expect(s.calls.length).toBe(2);
    c.advance(1_000);
    expect(await inv.read("srv", B, s.exec)).toBe("11\n12\n");
    expect(await inv.read("srv", A, s.exec)).toBe("cc-a\n");
    expect(s.calls.length).toBe(3); // one client for both, once the window passed
    expect(s.calls[2].filter((w) => w === ";").length).toBe(1);
  });

  test("concurrent reads of one server wait on the same client", async () => {
    const inv = new FleetInventory(clock().now);
    const s = fakeServer({ "#{session_name}": ["cc-a"] });
    const answers = await Promise.all([inv.read("srv", A, s.exec), inv.read("srv", A, s.exec), inv.read("srv", A, s.exec)]);
    expect(answers).toEqual(["cc-a\n", "cc-a\n", "cc-a\n"]);
    expect(s.calls.length).toBe(1);
  });

  test("a write drops the answers, and a read after it never joins a pass started before it", async () => {
    const c = clock();
    const inv = new FleetInventory(c.now);
    const rows = { "#{session_name}": ["cc-a"] };
    const s = fakeServer(rows);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = async (argv: string[]) => { await gate; return s.exec(argv); };
    const before = inv.read("srv", A, slow);
    inv.invalidate("srv");
    rows["#{session_name}"] = ["cc-a", "cc-b"];
    const after = inv.read("srv", A, s.exec);
    release();
    await before;
    expect(await after).toBe("cc-a\ncc-b\n");
    expect(s.calls.length).toBe(2);
  });

  test("a pass started before a write is not cached", async () => {
    const c = clock();
    const inv = new FleetInventory(c.now);
    let rows = ["old"];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const exec = async (argv: string[]) => { const out = rows; await gate; return out.map((r) => `${r}\n`).join(""); };
    const stale = inv.read("srv", A, exec);
    inv.invalidate("srv");
    rows = ["new"];
    release();
    expect(await stale).toBe("old\n");
    expect(await inv.read("srv", A, async () => "new\n")).toBe("new\n");
  });

  test("errors reach the callers of that pass and are never cached", async () => {
    const inv = new FleetInventory(clock().now);
    let fail = true;
    const s = fakeServer({ "#{session_name}": ["cc-a"] }, { fail: () => (fail ? Object.assign(new Error("busy"), { stderr: "no server running on /tmp/x" }) : null) });
    await expect(inv.read("srv", A, s.exec)).rejects.toThrow("busy");
    fail = false;
    expect(await inv.read("srv", A, s.exec)).toBe("cc-a\n");
  });

  test("a chain that fails on one command asks each command alone; a server that does not answer fails them all in one client", async () => {
    const c = clock();
    const inv = new FleetInventory(c.now);
    const warm = fakeServer({ "#{session_name}": ["cc-a"], "#{pane_pid}": ["11"] });
    await inv.read("srv", A, warm.exec);
    await inv.read("srv", B, warm.exec);
    c.advance(5_000);
    const chainFails = fakeServer({ "#{session_name}": ["cc-a"], "#{pane_pid}": ["11"] }, {
      fail: (argv) => (argv.includes(";") ? Object.assign(new Error("bad"), { stderr: "unknown format" }) : null),
    });
    expect(await inv.read("srv", A, chainFails.exec)).toBe("cc-a\n");
    expect(chainFails.calls.length).toBe(3);
    c.advance(5_000);
    const down = fakeServer({}, { fail: () => Object.assign(new Error("down"), { stderr: "error connecting to /tmp/x (Connection refused)" }) });
    await expect(inv.read("srv", B, down.exec)).rejects.toThrow("down");
    expect(down.calls.length).toBe(1);
  });

  test("a command that cannot be tagged or would split the chain runs alone", async () => {
    const inv = new FleetInventory(clock().now);
    const s = fakeServer({ "#{session_name}": ["cc-a"], "x;": ["y"] });
    await inv.read("srv", A, s.exec);
    await inv.read("srv", ["list-sessions", "-F", "x;"], s.exec);
    expect(s.calls.every((argv) => !argv.includes(";"))).toBe(true);
  });
});

describe("splitBatchOutput", () => {
  test("splits rows by command and keeps empty answers empty", () => {
    expect(splitBatchOutput("@@ccinv0@@a\n@@ccinv2@@c\n@@ccinv0@@b\n", 3)).toEqual(["a\nb\n", "", "c\n"]);
  });
  test("a value with a newline stays in its row", () => {
    expect(splitBatchOutput("@@ccinv0@@a\nmore\n@@ccinv1@@b\n", 2)).toEqual(["a\nmore\n", "b\n"]);
  });
});

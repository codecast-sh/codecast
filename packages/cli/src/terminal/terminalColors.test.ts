import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { colorReportCommands, terminalColorReports, TmuxControlClient } from "./controlClient.js";
import { hasTmux, tmuxRunAsync } from "../tmux.js";

describe("terminal color reports", () => {
  it("encodes RGB colors for tmux without accepting command syntax", () => {
    expect(terminalColorReports({ foreground: "#073642", background: "#fdf6e3" })).toEqual([
      "\\033]10;rgb:0707/3636/4242\\007",
      "\\033]11;rgb:fdfd/f6f6/e3e3\\007",
    ]);
    for (const colors of [undefined, null, "#ffffff", { background: '#ffffff"; kill-server' }, { foreground: 123 }]) {
      expect(terminalColorReports(colors)).toEqual([]);
    }
  });

  it("builds the refresh-client reports tmux answers OSC 10/11 with", () => {
    expect(colorReportCommands("%286", { foreground: "#073642", background: "#fdf6e3" })).toEqual([
      'refresh-client -r "%286:\\033]10;rgb:0707/3636/4242\\007"',
      'refresh-client -r "%286:\\033]11;rgb:fdfd/f6f6/e3e3\\007"',
    ]);
  });

  it("refuses a pane id that is not tmux's own", () => {
    for (const pane of ["", "cast-term-x", '%1" ; kill-server ; "', "%1a", "1"]) {
      expect(colorReportCommands(pane, { background: "#ffffff" })).toEqual([]);
    }
    expect(colorReportCommands("%0", { background: "#ffffff" })).toHaveLength(1);
  });

  it.each(["capability", "report", "style-probe", "@codecast-terminal-fg", "@codecast-terminal-bg", "window-style", "window-active-style"])("surfaces a failed %s command", async (failure) => {
    const client = new TmuxControlClient(
      { kind: "create", sessionName: "cast-term-error", fresh: true },
      { onOutput() {}, onExit() {} },
    );
    const transport = client as unknown as {
      paneId: string;
      command: (command: string) => Promise<{ ok: boolean; lines: string[] }>;
    };
    transport.paneId = "%0";
    const command = spyOn(transport, "command").mockImplementation(async (cmd) => {
      if (cmd === "list-commands refresh-client") {
        if (failure === "capability") return { ok: false, lines: ["test command refused"] };
        return { ok: true, lines: [failure === "report" ? "refresh-client [-r pane:report]" : "refresh-client [-C XxY]"] };
      }
      if (cmd.startsWith("refresh-client -r") || (failure === "style-probe" && cmd.startsWith("show-options")) || cmd.includes(` ${failure} `)) {
        return { ok: false, lines: ["test command refused"] };
      }
      return { ok: true, lines: [] };
    });
    try {
      await expect(client.setColors({ foreground: "#073642", background: "#fdf6e3" })).rejects.toThrow("test command refused");
    } finally {
      command.mockRestore();
      client.close();
    }
  });

  it.skipIf(!hasTmux())("answers an application's colour query with the viewer's colours, before and after a theme change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminal-colors-"));
    const script = join(dir, "probe.js");
    const output = join(dir, "colors.json");
    const name = `cast-term-colors-${process.pid}`;
    // Ask the terminal for its default foreground and background, collect
    // whatever comes back on stdin, and write it where the test can read it.
    writeFileSync(script, `
      process.stdin.setRawMode(true);
      let data = '';
      process.stdin.on('data', chunk => { data += chunk.toString(); });
      process.stdout.write('\\x1b]10;?\\x07\\x1b]11;?\\x07');
      setTimeout(() => {
        require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(data));
        process.exit(0);
      }, 500);
    `);

    const client = new TmuxControlClient(
      { kind: "create", sessionName: name, cwd: dir, fresh: true },
      { onOutput() {}, onExit() {} },
    );
    const askTerminal = async () => {
      rmSync(output, { force: true });
      client.sendInput(Buffer.from(`${process.execPath} ${script}\r`));
      for (let i = 0; i < 200; i++) {
        if (existsSync(output)) return JSON.parse(readFileSync(output, "utf8"));
        await Bun.sleep(50);
      }
      throw new Error("the colour probe never wrote its answer");
    };

    try {
      await client.start(100, 24, { foreground: "#073642", background: "#fdf6e3" });
      // Exactly one answer per query, carrying the colours the browser sent.
      // Before the fix tmux answered black first and xterm answered again a
      // moment later, and Codex believed the first reply.
      expect(await askTerminal()).toBe("\x1b]10;rgb:0707/3636/4242\x07\x1b]11;rgb:fdfd/f6f6/e3e3\x07");

      const run = async (...args: string[]) => {
        const result = await tmuxRunAsync(args);
        expect(result.status).toBe(0);
        return result.stdout;
      };
      const globalStyles = await run("show-options", "-gw");
      const neighbor = (await run("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", client.pane!, "sleep 30")).trim();
      const neighborStyles = await run("show-options", "-p", "-t", neighbor);
      await run("set-option", "-p", "-t", client.pane!, "window-style", "bold");
      await run("set-option", "-p", "-t", client.pane!, "window-active-style", "underscore");
      await client.setColors({ foreground: "#ececec", background: "#212121" });
      expect(await run("show-options", "-gw")).toBe(globalStyles);
      expect(await run("show-options", "-p", "-t", neighbor)).toBe(neighborStyles);
      expect(await run("show-options", "-pv", "-t", client.pane!, "window-style")).toContain("bold");
      expect(await run("show-options", "-pv", "-t", client.pane!, "window-active-style")).toContain("underscore");
      expect(await askTerminal()).toBe("\x1b]10;rgb:ecec/ecec/ecec\x07\x1b]11;rgb:2121/2121/2121\x07");
      await client.setColors({ foreground: "#073642" });
      await client.setColors({ background: "#ffffff'; kill-server", foreground: 123 });
      expect(await askTerminal()).toBe("\x1b]10;rgb:0707/3636/4242\x07\x1b]11;rgb:2121/2121/2121\x07");

      const supportsReports = (await run("list-commands", "refresh-client")).includes("[-r pane:report]");
      const paneStyles = await run("show-options", "-p", "-t", client.pane!);
      for (let i = 0; i < 5; i++) {
        await client.setColors({ foreground: "#ececec", background: "#fdf6e3" });
        await client.setColors({ foreground: "#073642", background: "#212121" });
      }
      expect(await run("show-options", "-p", "-t", client.pane!)).toBe(paneStyles);
      expect(await askTerminal()).toBe("\x1b]10;rgb:0707/3636/4242\x07\x1b]11;rgb:2121/2121/2121\x07");
      for (const readOnly of [true, false]) {
        const viewer = new TmuxControlClient(
          { kind: "attach", target: name, readOnly },
          { onOutput() {}, onExit() {} },
        );
        try {
          const start = viewer.start(100, 24, { foreground: "#ffffff", background: "#000000" });
          if (supportsReports) await start;
          else await expect(start).rejects.toThrow("requires tmux 3.5 or newer");
          expect(await run("show-options", "-p", "-t", client.pane!)).toBe(paneStyles);
        } finally {
          viewer.close();
        }
      }
    } finally {
      await client.killSession();
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});

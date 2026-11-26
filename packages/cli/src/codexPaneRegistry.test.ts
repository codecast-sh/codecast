import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  codexPaneListFormat,
  codexPanes,
  flushCodexPaneRegistry,
  markCodexPaneEnded,
  markCodexPaneLive,
  parseCodexPaneRows,
  reconcileCodexPanes,
  resetCodexPaneRegistry,
  seedCodexPanes,
  staleCodexPanes,
} from "./codexPaneRegistry";

const SEP = "|";

describe("codexPaneRegistry", () => {
  let tmp: string;
  let origDir: string | undefined;

  const registryFile = () => path.join(tmp, "codecast", "codex-panes.json");

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-panes-test-"));
    origDir = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = path.join(tmp, "codecast");
    await resetCodexPaneRegistry();
  });

  afterEach(async () => {
    await resetCodexPaneRegistry();
    if (origDir === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = origDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("marks and persistence", () => {
    it("records the account and conversation a pane launched under", async () => {
      markCodexPaneLive("cc-alpha", { account: "dev", conversationId: "conv-1" });
      expect(codexPanes()).toEqual([{ id: "cc-alpha", account: "dev", conversationId: "conv-1" }]);
      await flushCodexPaneRegistry();
      expect(JSON.parse(fs.readFileSync(registryFile(), "utf-8"))).toEqual({
        panes: [{ id: "cc-alpha", account: "dev", conversationId: "conv-1" }],
      });
    });

    it("survives a daemon restart: the file is what the next process starts from", async () => {
      markCodexPaneLive("cc-alpha", { account: "dev", conversationId: "conv-1" });
      markCodexPaneLive("cc-beta", { account: "footage" });
      await flushCodexPaneRegistry();

      // A new daemon: memory empty, file intact.
      const memoryOnly = codexPanes();
      await resetCodexPaneRegistry();
      expect(codexPanes()).toEqual([]);
      fs.writeFileSync(registryFile(), JSON.stringify({ panes: memoryOnly }));

      const restored = await seedCodexPanes();
      expect(restored.map((p) => p.id).sort()).toEqual(["cc-alpha", "cc-beta"]);
      expect(staleCodexPanes("dev").map((p) => p.id)).toEqual(["cc-beta"]);
    });

    it("keeps every mark when two panes start at once", async () => {
      markCodexPaneLive("cc-alpha", { account: "dev" });
      markCodexPaneLive("cc-beta", { account: "dev" });
      markCodexPaneLive("cc-gamma", { account: "dev" });
      await flushCodexPaneRegistry();
      const onDisk = JSON.parse(fs.readFileSync(registryFile(), "utf-8"));
      expect(onDisk.panes.map((p: any) => p.id).sort()).toEqual(["cc-alpha", "cc-beta", "cc-gamma"]);
    });

    it("drops a pane when it is killed", async () => {
      markCodexPaneLive("cc-alpha", { account: "dev" });
      markCodexPaneEnded("cc-alpha");
      markCodexPaneEnded("cc-never-existed"); // no-op, no write
      await flushCodexPaneRegistry();
      expect(JSON.parse(fs.readFileSync(registryFile(), "utf-8"))).toEqual({ panes: [] });
    });

    it("ignores a corrupt or absent registry file", async () => {
      expect(await seedCodexPanes()).toEqual([]);
      fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
      fs.writeFileSync(registryFile(), "{ not json");
      expect(await seedCodexPanes()).toEqual([]);
      fs.writeFileSync(registryFile(), JSON.stringify({ panes: [{ account: "dev" }, null, { id: "" }] }));
      expect(await seedCodexPanes()).toEqual([]);
    });
  });

  describe("reconcile against the live tmux list", () => {
    it("adopts panes it never knew and drops ones tmux no longer lists", () => {
      markCodexPaneLive("cc-dead", { account: "dev" });
      reconcileCodexPanes([
        { id: "cc-alpha", account: "dev" },
        { id: "cc-foreign", account: "footage" },
      ]);
      expect(codexPanes().map((p) => p.id).sort()).toEqual(["cc-alpha", "cc-foreign"]);
    });

    it("keeps the conversation link a resumed pane no longer stamps", () => {
      // The resume path stamps the session id, not the conversation id, so a
      // reconcile that took the listing literally would lose the link.
      markCodexPaneLive("cc-alpha", { account: "dev", conversationId: "conv-1" });
      reconcileCodexPanes([{ id: "cc-alpha", account: "dev" }]);
      expect(codexPanes()).toEqual([{ id: "cc-alpha", account: "dev", conversationId: "conv-1" }]);
    });

    it("re-attributes a pane from its own stamp", () => {
      markCodexPaneLive("cc-alpha", { account: "stale-memory" });
      reconcileCodexPanes([{ id: "cc-alpha", account: "dev" }]);
      expect(codexPanes()[0].account).toBe("dev");
      expect(staleCodexPanes("dev")).toEqual([]);

      // And an account the pane no longer carries is forgotten, not restored:
      // an attribution we cannot see must not order a restart.
      reconcileCodexPanes([{ id: "cc-alpha" }]);
      expect(codexPanes()[0].account).toBeUndefined();
    });

    it("clears a seeded pane whose process died while the daemon was down", async () => {
      markCodexPaneLive("cc-gone", { account: "dev" });
      await flushCodexPaneRegistry();
      await resetCodexPaneRegistry();
      fs.writeFileSync(registryFile(), JSON.stringify({ panes: [{ id: "cc-gone", account: "dev" }] }));
      await seedCodexPanes();
      reconcileCodexPanes([]); // tmux answered: no such session
      expect(codexPanes()).toEqual([]);
    });
  });

  describe("staleCodexPanes", () => {
    beforeEach(() => {
      markCodexPaneLive("cc-current", { account: "dev", conversationId: "conv-1" });
      markCodexPaneLive("cc-old", { account: "footage", conversationId: "conv-2" });
      markCodexPaneLive("cc-unattributed", { conversationId: "conv-3" });
    });

    it("names exactly the panes running another account", () => {
      expect(staleCodexPanes("dev")).toEqual([
        { id: "cc-old", account: "footage", conversationId: "conv-2" },
      ]);
    });

    it("names nothing when the current account cannot be resolved", () => {
      // A machine with no enrolled login: every pane would look stale, and a
      // restart we cannot justify is worse than a meter that waits.
      expect(staleCodexPanes(undefined)).toEqual([]);
    });

    it("leaves an unattributed pane alone even after a switch", () => {
      expect(staleCodexPanes("someone-else").map((p) => p.id).sort()).toEqual(["cc-current", "cc-old"]);
    });
  });

  describe("parseCodexPaneRows", () => {
    const row = (...fields: string[]) => fields.join(SEP);

    it("reads the codex panes out of a tmux listing", () => {
      const stdout = [
        row("cc-alpha", "codex", "dev", "conv-1"),
        row("cc-claude", "claude", "dev", "conv-2"),
        row("cc-beta", "codex", "footage", ""),
        "",
      ].join("\n");
      expect(parseCodexPaneRows(stdout, SEP)).toEqual([
        { id: "cc-alpha", account: "dev", conversationId: "conv-1" },
        { id: "cc-beta", account: "footage" },
      ]);
    });

    it("keeps a session name that contains the separator", () => {
      const stdout = row("cc|weird|name", "codex", "dev", "conv-1");
      expect(parseCodexPaneRows(stdout, SEP)[0].id).toBe("cc|weird|name");
    });

    it("treats an unexpanded placeholder as 'not stamped', never as an account", () => {
      // A tmux too old to expand #{@opt} hands the placeholder back verbatim.
      const stdout = row("cc-alpha", "codex", "#{@codecast_codex_account}", "conv-1");
      expect(parseCodexPaneRows(stdout, SEP)).toEqual([{ id: "cc-alpha", conversationId: "conv-1" }]);
    });

    it("skips rows that carry no agent type or too few fields", () => {
      expect(parseCodexPaneRows(row("cc-alpha", "codex", "dev"), SEP)).toEqual([]);
      expect(parseCodexPaneRows(row("cc-alpha", "", "dev", "conv-1"), SEP)).toEqual([]);
      expect(parseCodexPaneRows("", SEP)).toEqual([]);
    });

    it("asks tmux for the fields it parses, in order", () => {
      expect(codexPaneListFormat(SEP)).toBe(
        "#{session_name}|#{@codecast_agent_type}|#{@codecast_codex_account}|#{@codecast_conversation_id}",
      );
    });
  });
});

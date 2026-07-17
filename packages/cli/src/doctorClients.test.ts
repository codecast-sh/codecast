// Tests for `cast doctor`'s multi-client self-test. The point of the doctor
// section is to catch a drift between a client's registry descriptor and the code
// that consumes it; these tests pin every leg it checks so the section can't go
// green on a fixture that no longer matches production.
//
// None of these need a client binary installed — they drive the parser, the two
// real file watchers, and the registry directly, exactly as the doctor does.

import { describe, expect, test } from "bun:test";
import { AGENT_CLIENTS, type AgentClientId } from "@codecast/shared/contracts";
import { parseTranscriptFor } from "./parser.js";
import { clientFixture, watcherFires, probeClient, probeAllClients } from "./doctorClients.js";

const ALL_CLIENTS = Object.keys(AGENT_CLIENTS) as AgentClientId[];
const JSONL_CLIENTS: AgentClientId[] = ["claude", "codex", "gemini", "pi"];
const SQLITE_CLIENTS: AgentClientId[] = ["opencode", "cursor"];

describe("clientFixture — the synthetic transcript round-trips the PRODUCTION parser", () => {
  for (const id of ALL_CLIENTS) {
    test(`${id}: parseTranscriptFor returns a user + assistant turn`, () => {
      const roles = parseTranscriptFor(id, clientFixture(id).transcript).map((m) => (m as { role: string }).role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
    });
  }
});

describe("clientFixture — readySample matches the descriptor's promptReadyPattern", () => {
  for (const id of ALL_CLIENTS) {
    test(`${id}: promptReadyPattern matches its representative ready line`, () => {
      const { promptReadyPattern } = AGENT_CLIENTS[id];
      expect(promptReadyPattern).toBeInstanceOf(RegExp);
      expect(promptReadyPattern.test(clientFixture(id).readySample)).toBe(true);
    });
  }
});

describe("resumeCmd constructs a command referencing the client binary", () => {
  for (const id of ALL_CLIENTS) {
    test(`${id}: resumeCmd is non-empty and names the binary`, () => {
      const cmd = AGENT_CLIENTS[id].resumeCmd("sid-123");
      expect(cmd.trim().length).toBeGreaterThan(0);
      expect(cmd).toContain(AGENT_CLIENTS[id].binary);
    });
  }
});

describe("watcherFires — the REAL jsonl watcher emits on a synthetic transcript write", () => {
  for (const id of JSONL_CLIENTS) {
    test(`${id}: a fresh transcript file triggers a session event`, async () => {
      const fired = await watcherFires(id, clientFixture(id), 6000);
      expect(fired).toBe(true);
    }, 12_000);
  }

  for (const id of SQLITE_CLIENTS) {
    test(`${id}: no file-event watcher (sqlite poll) → null, not a false pass`, async () => {
      const fired = await watcherFires(id, clientFixture(id), 1000);
      expect(fired).toBeNull();
    });
  }

  test("a write the watchFilter rejects produces NO event (proves the probe can fail)", async () => {
    // codex only watches .jsonl; a .txt write must not emit a session event. This
    // keeps watcherFires honest — a green watcher leg means the watcher really fired,
    // not that the probe always resolves true.
    const fx = clientFixture("codex");
    const fired = await watcherFires("codex", { ...fx, watchRelPath: "2026/01/01/not-a-transcript.txt" }, 1500);
    expect(fired).toBe(false);
  }, 6000);
});

describe("probeClient / probeAllClients", () => {
  test("probeAllClients returns one well-formed result per registered client", async () => {
    const results = await probeAllClients();
    expect(results.map((r) => r.id).sort()).toEqual([...ALL_CLIENTS].sort());
    for (const r of results) {
      expect(typeof r.installed).toBe("boolean");
      expect(typeof r.ok).toBe("boolean");
      // Installed clients run the full 5-leg matrix and (on a sane checkout) pass it;
      // uninstalled clients skip with no sub-checks and are not a failure.
      if (r.installed) {
        expect(r.subChecks.map((c) => c.label)).toEqual(["descriptor", "readiness", "resume", "parser", "watcher"]);
        expect(r.ok).toBe(true);
      } else {
        expect(r.subChecks.length).toBe(0);
        expect(r.ok).toBe(true);
      }
    }
  }, 30_000);

  test("an uninstalled binary probes as installed:false, ok:true, no sub-checks", async () => {
    // Whatever this machine lacks, that client must skip cleanly. If every client is
    // installed the assertion is vacuously satisfied by the loop above; this pins the
    // skip shape when at least one is absent.
    const results = await probeAllClients();
    for (const r of results.filter((x) => !x.installed)) {
      expect(r.subChecks.length).toBe(0);
      expect(r.ok).toBe(true);
    }
  }, 30_000);
});

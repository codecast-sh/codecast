import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { processLookupAllowsCwdFallback, readCodexSessionMetaHeadAsync, sessionMetaHeadCut, sessionProcessOwnership } from "./daemon.js";
import { planSessionTeardown, shortId } from "./sessionProcessMatcher.js";

// ct-41071, anchored to the incident that produced it: ~/.codex/sessions/2026/08/02.
//
// findSessionProcess Strategy A2 discovers a Codex session's process by asking
// lsof "who holds this rollout open?" — and for a subagent THREAD the answer is
// its parent TUI, because such a subagent has no process of its own. Observed live
// that day: 15+ distinct session ids all resolved to pid 55521, each reporting the
// byte-identical cpu=0.1% mem=265.0MB procs=10, summed into the fleet total once
// per session.
//
// The borrowed pid is CORRECT for reaching the agent (parent and subagent share a
// terminal, and the subagent's permission prompt renders in the parent's pane) and
// catastrophic for owning it: destroying that process on a subagent's behalf
// SIGKILLs the parent TUI and every sibling thread.
//
// Fixtures carry the REAL session_meta shapes, copied here so the tests don't
// depend on those rollouts still existing on disk. Both parent-carrying shapes are
// modelled, because they have OPPOSITE process semantics and a census of 214 local
// rollouts found them in nearly equal numbers (28 exec-review vs 31 thread-spawn).

const realHome = process.env.HOME;
let tmpHome: string;
let rolloutDir: string;

// The parent TUI. originator "codex-tui" / thread_source "user" — note a root is
// identified by the ABSENCE of a parent, never by its originator.
const PARENT = "019fc25f-ea9d-7f22-b8ae-8d232737fc7b";

// In-process subagent THREADS of PARENT — the borrowers. Three collide on the
// 8-char prefix "019fc262" and two more on "019fc275": real evidence that UUIDv7
// sibling ids are indistinguishable at the old log width.
const THREAD_SUBAGENTS = [
  "019fc262-3cff-7ec0-8a92-9c7097998f9d", // /root/cli_review
  "019fc262-55d4-7140-8332-e0750c22e6a9", // /root/routing_review
  "019fc262-7655-7042-82ae-d526436c2ee3", // /root/provenance_audit
  "019fc270-af22-78b0-a8fa-2eef525bddcf", // /root/dismissal_verify
  "019fc275-16d1-79a0-bf22-22137ca92a61", // /root/dismissal_verify_fast
  "019fc275-fcb2-73d1-9db6-771b61a86a93", // /root/clusters_verify
  "019fc27e-93d7-7923-8354-71f63f9dc7b4", // /root/dismissal_verify_final
  "019fc288-b7c4-79a3-804a-9e0a4ffbcce4", // /root/dismissal_verify_final3
];

// `codex exec` review children. These ALSO carry parent_thread_id, which is why
// parent_thread_id alone is the wrong discriminator — they are spawned as separate
// OS processes and own their pids. 28 of 59 parent-carrying rollouts in the census
// have this shape; treating them as borrowers would leave a review process running
// after the user killed its card.
const EXEC_SUBAGENTS = [
  "019f82c1-5826-7fa2-a022-0cf5faf6c8d2",
  "019f8836-88cc-70f3-8dd7-db0b87cb9d59",
];

// The ct-41115 control: a genuinely DISTINCT root that the daemon log still matched
// to another root's pid. Root-to-root collisions are a separate defect; this guard
// must leave that case completely alone rather than papering over it.
const ROOT_SIBLING = "019fc268-e3a0-77a2-bf01-18174ce04a9b";

const CLAUDE_SESSION = "5b1c47b3-16c0-42d5-a6d2-82459a01f640";

function metaLine(sessionId: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    type: "session_meta",
    payload: { id: sessionId, cwd: "/Users/jasonbenn/code/codecast", ...payload },
  });
}

function writeRollout(sessionId: string, payload: Record<string, unknown>, stamp = "14-08-13"): string {
  const p = path.join(rolloutDir, `rollout-2026-08-02T${stamp}-${sessionId}.jsonl`);
  // readCodexSessionMetaHead reads complete lines until the first non-meta one.
  fs.writeFileSync(p, metaLine(sessionId, payload) + "\n" +
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n");
  return p;
}

/** An in-process thread: source.subagent is an OBJECT carrying thread_spawn. */
function writeThreadSubagent(sessionId: string, agentPath: string): string {
  return writeRollout(sessionId, {
    parent_thread_id: PARENT,
    originator: "codex-tui",
    thread_source: "subagent",
    source: {
      subagent: {
        thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: agentPath, agent_role: null },
      },
    },
  });
}

/** A `codex exec` child: source.subagent is the bare STRING "review". */
function writeExecSubagent(sessionId: string): string {
  return writeRollout(sessionId, {
    parent_thread_id: PARENT,
    originator: "codex_exec",
    thread_source: "subagent",
    source: { subagent: "review" },
  });
}

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shared-process-"));
  process.env.HOME = tmpHome;
  rolloutDir = path.join(tmpHome, ".codex", "sessions", "2026", "08", "02");
  fs.mkdirSync(rolloutDir, { recursive: true });

  writeRollout(PARENT, { originator: "codex-tui", source: "cli", thread_source: "user" });
  THREAD_SUBAGENTS.forEach((sid, i) => writeThreadSubagent(sid, `/root/verify_${i}`));
  EXEC_SUBAGENTS.forEach(writeExecSubagent);
  writeRollout(ROOT_SIBLING, { originator: "codex_cli_rs", source: "cli" }, "14-18-01");

  const claudeDir = path.join(tmpHome, ".claude", "projects", "-Users-jasonbenn-code-codecast");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, `${CLAUDE_SESSION}.jsonl`),
    JSON.stringify({ type: "user", cwd: "/Users/jasonbenn/code/codecast" }) + "\n",
  );
});

afterAll(() => {
  process.env.HOME = realHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe("sessionProcessOwnership — the incident's own sessions", () => {
  test("Codex never guesses a process from working directory and start time", () => {
    expect(processLookupAllowsCwdFallback("codex")).toBe(false);
    expect(processLookupAllowsCwdFallback("claude")).toBe(true);
  });

  test("every in-process subagent THREAD of 019fc25f borrows the parent's process", () => {
    for (const sid of THREAD_SUBAGENTS) {
      expect(sessionProcessOwnership(sid)).toBe("borrowed");
    }
  });

  test("a `codex exec` review child OWNS its process despite having a parent", () => {
    // The over-fire that parent_thread_id alone would cause. These are separate
    // OS processes; calling them borrowers means killing a review card silently
    // leaves the review running.
    for (const sid of EXEC_SUBAGENTS) {
      expect(sessionProcessOwnership(sid)).toBe("owned");
    }
  });

  test("the parent TUI owns its process", () => {
    expect(sessionProcessOwnership(PARENT)).toBe("owned");
  });

  test("a distinct root session owns its process (ct-41115 stays out of scope)", () => {
    expect(sessionProcessOwnership(ROOT_SIBLING)).toBe("owned");
  });

  test("a Claude session always owns its process", () => {
    expect(sessionProcessOwnership(CLAUDE_SESSION)).toBe("owned");
  });

  test("an id with no file on disk is UNKNOWN, not owned", () => {
    // "unknown" is what makes the destructive paths fail closed.
    expect(sessionProcessOwnership("00000000-0000-0000-0000-000000000000")).toBe("unknown");
  });

  test("a materialized Claude JSONL must not override the Codex rollout", () => {
    // NEW-1, the regression that silently restored the whole defect.
    // materializeSession writes a CLAUDE-shaped transcript under a CODEX session
    // id (clientOwnsSessionStore excludes codex, so its skip never fires), and
    // findSessionFile searches ~/.claude/projects BEFORE ~/.codex/sessions. A
    // real subagent therefore resolved as agentType "claude" -> "owned" -> and
    // was MEMOIZED, so every later kill/dismiss/move reaped the parent, sticky
    // until daemon restart. Reachable whenever the session id misses the local
    // conversation cache — a second machine, a move_to_device target (the very
    // gesture guard #2 exists for), a reset cache, or the startup race.
    const MAT = "019fc292-0000-7000-8000-00000000000b";
    writeThreadSubagent(MAT, "/root/materialized");
    const matDir = path.join(tmpHome, ".claude", "projects", "-Users-jasonbenn-code-codecast");
    fs.mkdirSync(matDir, { recursive: true });
    fs.writeFileSync(
      path.join(matDir, `${MAT}.jsonl`),
      JSON.stringify({ type: "user", cwd: "/Users/jasonbenn/code/codecast" }) + "\n",
    );

    expect(sessionProcessOwnership(MAT)).toBe("borrowed");
    expect(planSessionTeardown(sessionProcessOwnership(MAT))).toEqual({
      reapPidTree: false,
      killCachedResumeTmux: false,
    });
  });

  test("a rollout whose session_meta is still being written is UNKNOWN, not owned", () => {
    // The race that matters: session_meta is ~37KB because base_instructions
    // embeds the system prompt, while Strategy A2 matches on the PATH, which
    // exists the instant the file is created. A half-written first line parses
    // to no metadata — collapsing that to "owned" would authorize a SIGKILL
    // during the exact window the guard exists for.
    const PARTIAL = "019fc291-0000-7000-8000-00000000000a";
    const full = metaLine(PARTIAL, {
      parent_thread_id: PARENT,
      originator: "codex-tui",
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } },
    });
    const p = path.join(rolloutDir, `rollout-2026-08-02T14-08-13-${PARTIAL}.jsonl`);
    fs.writeFileSync(p, full.slice(0, Math.floor(full.length / 2))); // truncated mid-line
    expect(sessionProcessOwnership(PARTIAL)).toBe("unknown");

    // …and once the writer finishes, the real answer must still be reachable —
    // i.e. the undecided pass must NOT have been memoized.
    fs.writeFileSync(p, full + "\n" + JSON.stringify({ type: "event_msg", payload: {} }) + "\n");
    expect(sessionProcessOwnership(PARTIAL)).toBe("borrowed");
  });
});

describe("planSessionTeardown — what a kill may destroy", () => {
  // This is the seam. Both destructive sites (killConversationBackends,
  // stopLocalSessionBackends) do TWO process-destroying things, and both must be
  // gated. An earlier revision guarded only reapPidTree and left the cached-resume
  // tmux kill wide open — resumeSessionCache is keyed by session id but its VALUE
  // can be the PARENT's tmux, because resolveLiveTmuxTarget fills it via the
  // borrowed pid. These assertions are what catch that class of miss.

  test("a borrower may destroy NOTHING", () => {
    const plan = planSessionTeardown("borrowed");
    expect(plan.reapPidTree).toBe(false);
    expect(plan.killCachedResumeTmux).toBe(false);
  });

  test("an UNKNOWN session may destroy nothing either (fails closed)", () => {
    const plan = planSessionTeardown("unknown");
    expect(plan.reapPidTree).toBe(false);
    expect(plan.killCachedResumeTmux).toBe(false);
  });

  test("an owner may destroy both its pid tree and its cached resume tmux", () => {
    const plan = planSessionTeardown("owned");
    expect(plan.reapPidTree).toBe(true);
    expect(plan.killCachedResumeTmux).toBe(true);
  });

  test("resuming then killing a subagent card cannot kill the parent's tmux", () => {
    // The S1 bypass, end to end at the decision level: Resume caches the PARENT's
    // tmux name under the SUBAGENT's id, then a later kill/dismiss reads it back.
    for (const sid of THREAD_SUBAGENTS) {
      expect(planSessionTeardown(sessionProcessOwnership(sid)).killCachedResumeTmux).toBe(false);
    }
  });

  test("killing the PARENT still tears everything down", () => {
    // The over-fire case: cascadeHideToNestedChildren enqueues a per-child
    // kill_session when a parent is killed, and those children no-op — but the
    // parent's own kill must still reap the shared process exactly once.
    const plan = planSessionTeardown(sessionProcessOwnership(PARENT));
    expect(plan.reapPidTree).toBe(true);
    expect(plan.killCachedResumeTmux).toBe(true);
  });

  test("killing a `codex exec` review card still reaps it", () => {
    for (const sid of EXEC_SUBAGENTS) {
      expect(planSessionTeardown(sessionProcessOwnership(sid)).reapPidTree).toBe(true);
    }
  });
});

describe("the guards are actually wired into the kill sites", () => {
  // Structural, on purpose. The previous revision of this file asserted only the
  // predicate, so a reviewer could DELETE both guards — reintroducing the whole
  // defect — and every test still passed. killConversationBackends and
  // stopLocalSessionBackends take no deps object, and dependency-injecting a kill
  // path purely for test convenience is the riskiest change available here, so
  // this checks the wiring at the source level instead.
  //
  // It is deliberately shallow: it proves each destructive site consults the plan
  // and reads BOTH of its fields. It cannot prove the branches are correct — the
  // planSessionTeardown tests above cover the policy, and these cover that the
  // policy is actually consulted. Together they close the gap that let S1 through,
  // where the reap was gated and the cached-resume-tmux kill was not.
  const daemonSrc = fs.readFileSync(path.join(import.meta.dir, "daemon.ts"), "utf-8");

  /** Source with comments stripped. A comment mentioning the flag must never be
   *  able to satisfy these assertions — "a comment standing in for behavior" is
   *  the exact failure mode that let the original bypass survive two readings. */
  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
  }

  function bodyOf(signature: string): string {
    const start = daemonSrc.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    // Up to the next top-level `\nasync function ` / `\nfunction ` declaration.
    const rest = daemonSrc.slice(start + signature.length);
    const end = rest.search(/\n(?:async )?function /);
    return codeOnly(end === -1 ? rest : rest.slice(0, end));
  }

  for (const sig of [
    "async function killConversationBackends(",
    "async function stopLocalSessionBackends(",
  ]) {
    const name = sig.replace("async function ", "").replace("(", "");

    test(`${name} gates BOTH destructive actions on the plan`, () => {
      const body = bodyOf(sig);
      // Sanity: this really is a destructive site, so the assertions below matter.
      expect(body).toContain("reapPidTree(");
      expect(body).toContain("resumeSessionCache.get(");

      expect(body).toContain("planSessionTeardown(");
      expect(body).toContain("teardownPlan.reapPidTree");
      // The S1 bypass: the cached resume tmux can be the PARENT's pane name.
      expect(body).toContain("teardownPlan.killCachedResumeTmux");
    });

    test(`${name} never kills the cached resume tmux outside a plan-gated branch`, () => {
      // Token presence alone let a mutation pass that deleted the guard and left
      // the flag's name in a comment. Tie the flag to the ACTION instead: the
      // tmux read out of resumeSessionCache must only be killed inside a branch
      // testing killCachedResumeTmux.
      //
      // The variable name is READ FROM THE SOURCE rather than hardcoded. Matching
      // a literal `cachedTmux` made this vacuous under a plain rename: the loop
      // found nothing, iterated zero times, and passed while S1 was fully
      // reintroduced. Binding to whatever `resumeSessionCache.get()` is assigned
      // to survives renames, and the count assertion below turns "found nothing"
      // into a failure instead of a pass — an aliased kill drops the count to 0.
      const body = bodyOf(sig);
      const binding = body.match(/const (\w+) = resumeSessionCache\.get\(/);
      expect(binding).not.toBeNull();
      const cacheVar = binding![1];

      const lines = body.split("\n");
      const killPattern = new RegExp(`killTmuxSessionAndTree\\(\\s*${cacheVar}\\s*\\)`);
      let checked = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!killPattern.test(lines[i])) continue;
        checked++;
        const preceding = lines.slice(Math.max(0, i - 6), i).join("\n");
        expect(preceding).toContain("killCachedResumeTmux");
      }
      // A zero-iteration loop must FAIL, not pass vacuously. Each site kills the
      // cached tmux exactly once; if that call is gone or reached via an alias,
      // this is the assertion that catches it.
      expect(checked).toBe(1);
    });

    test(`${name} gates on the plan with the correct polarity`, () => {
      // Catches a wholesale inversion — every borrower destroyed, every owner
      // spared — which token matching cannot see. The reap must be skipped when
      // the plan says NOT to reap, and performed when it says to.
      const body = bodyOf(sig);
      const skipsWhenDenied = /!teardownPlan\.reapPidTree/.test(body);
      const actsWhenAllowed = /if \(teardownPlan\.reapPidTree\)/.test(body);
      expect(skipsWhenDenied || actsWhenAllowed).toBe(true);
      // …and never both-negated, which would be the inverted form.
      expect(/if \(!teardownPlan\.reapPidTree\) \{\s*\n\s*const proc = await findSessionProcess/.test(body)).toBe(false);
    });
  }
});

describe("memoization", () => {
  test("a session whose rollout appears later is re-decided, not cached as owned", () => {
    const LATE = "019fc290-0000-7000-8000-000000000001";
    expect(sessionProcessOwnership(LATE)).toBe("unknown");
    writeThreadSubagent(LATE, "/root/late");
    expect(sessionProcessOwnership(LATE)).toBe("borrowed");
  });

  test("a decided answer is memoized (session_meta is immutable once written)", () => {
    const STABLE = "019fc290-0000-7000-8000-000000000002";
    const p = writeThreadSubagent(STABLE, "/root/stable");
    expect(sessionProcessOwnership(STABLE)).toBe("borrowed");
    fs.rmSync(p);
    expect(sessionProcessOwnership(STABLE)).toBe("borrowed");
  });
});

describe("shortId on the incident's ids", () => {
  test("disambiguates the three subagents that collide at 8 chars", () => {
    const colliding = THREAD_SUBAGENTS.filter((s) => s.startsWith("019fc262"));
    expect(colliding.length).toBe(3);
    expect(new Set(colliding.map((s) => s.slice(0, 8))).size).toBe(1); // old width: one id
    expect(new Set(colliding.map(shortId)).size).toBe(3);              // new width: three
  });

  test("distinguishes the parent from every one of its subagents", () => {
    for (const sid of THREAD_SUBAGENTS) {
      expect(shortId(sid)).not.toBe(shortId(PARENT));
    }
  });
});

// The metrics tick reads the same leading block off the loop. Both readers
// must cut at the same place: after the last session_meta line, before the
// first line that is anything else.
describe("readCodexSessionMetaHeadAsync", () => {
  test("returns the leading session_meta block of a 3 deep chain", async () => {
    const p = path.join(rolloutDir, "rollout-2026-08-02T15-00-00-chain.jsonl");
    const metas = [metaLine("a", {}), metaLine("b", { parent_thread_id: "a" }), metaLine("c", { parent_thread_id: "b" })];
    const head = metas.join("\n") + "\n";
    fs.writeFileSync(p, head + JSON.stringify({ type: "event_msg", payload: {} }) + "\n" + "x".repeat(1000) + "\n");
    expect(await readCodexSessionMetaHeadAsync(p)).toBe(head);
    expect(sessionMetaHeadCut(head + '{"type":"other"}\n')).toBe(head.length);
  });

  test("an empty block when the first line is not session_meta", async () => {
    const p = path.join(rolloutDir, "rollout-2026-08-02T15-00-01-nometa.jsonl");
    fs.writeFileSync(p, JSON.stringify({ type: "event_msg", payload: {} }) + "\n" + metaLine("late", {}) + "\n");
    expect(await readCodexSessionMetaHeadAsync(p)).toBe("");
  });

  test("stops at the byte cap on a file with no non meta line", async () => {
    const p = path.join(rolloutDir, "rollout-2026-08-02T15-00-02-allmeta.jsonl");
    // Each meta line is ~37KB in real rollouts; 17MB of them exceeds the 16MB cap.
    const line = metaLine("big", { base_instructions: "i".repeat(36 * 1024) }) + "\n";
    const fd = fs.openSync(p, "w");
    let written = 0;
    while (written < 17 * 1024 * 1024) { fs.writeSync(fd, line); written += line.length; }
    fs.closeSync(fd);
    const head = await readCodexSessionMetaHeadAsync(p);
    expect(head.length).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(head.length).toBeGreaterThan(15 * 1024 * 1024);
    expect(head.endsWith("\n")).toBe(true);
  }, 30_000);
});

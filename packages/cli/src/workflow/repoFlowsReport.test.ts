// A checkout's own flows as the web's Ship picker reads them (repoFlowsReport.ts): each `.codecast/flows` graph with its
// `extends` expanded, under the repository its origin names, sent again only when it changed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RESEND_MS, repoFlowsReport, reportRepoFlows } from "./repoFlowsReport";

const BASE = `digraph change {
  graph [kind="line", label="Change", description="PR, CI and review side by side", takes="task,branch"]
  start [shape=Mdiamond]
  pr [label="PR", shape=parallelogram, script="echo pr"]
  checks [label="CI and review", shape=component]
  ci [label="CI", shape=parallelogram, script="echo ci"]
  review [label="Review", prompt="Read the diff."]
  read [label="Read", shape=tripleoctagon]
  fix [label="Fix findings", backend=subject, max_visits=3, prompt="Fix it."]
  exit [shape=Msquare, label="Live"]
  start -> pr -> checks
  checks -> ci
  checks -> review
  ci -> read
  review -> read
  read -> exit [condition="outcome = success"]
  read -> fix
  fix -> pr
}`;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-flows-"));
  fs.mkdirSync(path.join(root, ".codecast", "flows"), { recursive: true });
  fs.mkdirSync(path.join(root, "line"), { recursive: true });
  fs.writeFileSync(path.join(root, "line", "change.cast"), BASE);
  fs.writeFileSync(path.join(root, ".codecast", "flows", "change.cast"), `digraph change {\n  graph [extends="../../line/change.cast"]\n}\n`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const REMOTE = "git@github.com:Union-AI/union-mobile.git";

describe("a checkout's own flows", () => {
  test("a repo flow that extends another reports the whole graph under its repository", () => {
    const r = repoFlowsReport(root, REMOTE)!;
    expect(r.repository.toLowerCase()).toBe("union-ai/union-mobile");
    expect(r.flows.map((f) => [f.slug, f.kind, f.label, f.takes.join(",")])).toEqual([["change", "line", "Change", "task,branch"]]);
    const nodes = new Map(r.flows[0].nodes.map((n) => [n.id, n]));
    expect(nodes.get("checks")?.type).toBe("parallel_fanout");
    expect(nodes.get("fix")).toMatchObject({ backend: "subject", max_visits: 3 });
    expect(r.flows[0].edges).toContainEqual({ from: "checks", to: "review" });
  });

  test("a draft and a checkout with no origin report nothing", () => {
    fs.writeFileSync(path.join(root, ".codecast", "flows", "mine.cast"), `digraph mine {\n  graph [kind="line", draft="jx7abcd"]\n  start [shape=Mdiamond]\n  exit [shape=Msquare]\n  start -> exit\n}\n`);
    expect(repoFlowsReport(root, REMOTE)!.flows.map((f) => f.slug)).toEqual(["change"]);
    expect(repoFlowsReport(root, null)).toBeNull();
  });

  test("a report goes up again when the flows changed or a day passed", async () => {
    const cache = path.join(root, "cache");
    const sent: string[] = [];
    gitInit(root);
    const post = async (r: { hash: string }) => { sent.push(r.hash); return true; };
    expect(await reportRepoFlows(root, post, cache)).toBe("sent");
    expect(await reportRepoFlows(root, post, cache)).toBe("unchanged");
    // An unchanged checkout still reports once a day, so the server keeps its row.
    expect(await reportRepoFlows(root, post, cache, Date.now() + RESEND_MS + 1)).toBe("sent");
    sent.pop();
    fs.writeFileSync(path.join(root, "line", "change.cast"), BASE.replace('label="PR"', 'label="Pull request"'));
    expect(await reportRepoFlows(root, post, cache)).toBe("sent");
    expect(sent.length).toBe(2);
    expect(sent[0]).not.toBe(sent[1]);
    // A refused post is tried again next time.
    fs.writeFileSync(path.join(root, "line", "change.cast"), BASE);
    expect(await reportRepoFlows(root, async () => false, cache)).toBe("skipped");
    expect(await reportRepoFlows(root, post, cache)).toBe("sent");
  });

  test("two checkouts of one repository report apart, each under its own root", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "repo-flows-other-"));
    try {
      gitInit(root);
      gitInit(other);
      const cache = path.join(root, "cache");
      const sent: Array<{ root: string; flows: unknown[] }> = [];
      const post = async (r: { root: string; flows: unknown[] }) => { sent.push(r); return true; };
      expect(await reportRepoFlows(root, post, cache)).toBe("sent");
      // A worktree with no flows of its own is its own report, not a repeat of the first checkout's.
      expect(await reportRepoFlows(other, post, cache)).toBe("sent");
      expect(sent.map((r) => [path.basename(r.root), r.flows.length])).toEqual([[path.basename(root), 1], [path.basename(other), 0]]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

/** A git checkout with Union's origin. Git's own env from a calling hook (GIT_DIR, say) is dropped, or `git init`
 *  reinitialises that repository instead of this directory. */
function gitInit(dir: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))) as Record<string, string>;
  Bun.spawnSync(["git", "init", "-q", dir], { env });
  Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", REMOTE], { env });
}

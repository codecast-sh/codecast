// A checkout's own flows as the web's Ship picker reads them (repoFlowsReport.ts): each `.codecast/flows` graph with its
// `extends` expanded, under the repository its origin names, sent again only when it changed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { repoFlowsReport, reportRepoFlows } from "./repoFlowsReport";

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

  test("a report goes up again only when the flows changed", async () => {
    const cache = path.join(root, "cache");
    const sent: string[] = [];
    // The checkout's origin is read from git, so give it one.
    Bun.spawnSync(["git", "init", "-q", root]);
    Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", REMOTE]);
    const post = async (r: { hash: string }) => { sent.push(r.hash); return true; };
    expect(await reportRepoFlows(root, post, cache)).toBe("sent");
    expect(await reportRepoFlows(root, post, cache)).toBe("unchanged");
    fs.writeFileSync(path.join(root, "line", "change.cast"), BASE.replace('label="PR"', 'label="Pull request"'));
    expect(await reportRepoFlows(root, post, cache)).toBe("sent");
    expect(sent.length).toBe(2);
    expect(sent[0]).not.toBe(sent[1]);
    // A refused post is tried again next time.
    fs.writeFileSync(path.join(root, "line", "change.cast"), BASE);
    expect(await reportRepoFlows(root, async () => false, cache)).toBe("skipped");
    expect(await reportRepoFlows(root, post, cache)).toBe("sent");
  });
});

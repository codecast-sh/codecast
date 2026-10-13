import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  captureDecision, capturePin, checkpointRefs, fixKind, nodesAfter, presenterPrompt, problemCheckpoints, readWrites,
  renderDecisionMarkdown, renderPreview, replayContext, stdinSections, type WriteRecord,
} from "./lib/linePresent.ts";

const GUARD = path.join(import.meta.dir, "line-present-replay-bin", "cast");
const tmp = (name: string) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `lpr-${name}-`));

/** One call through the recording guard, with no real `cast` on PATH: a read finds nothing to run, a write is recorded and refused. */
function guard(runDir: string, args: string[], opts: { stdin?: string; cwd?: string } = {}) {
  const r = Bun.spawnSync(["bash", GUARD, ...args], {
    cwd: opts.cwd ?? runDir, env: { PATH: "/usr/bin:/bin", RUN_DIR: runDir },
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("the recording guard", () => {
  test("a decision is kept whole: argv, the heredoc on stdin, and the report file as it was at the call", () => {
    const run = tmp("guard");
    const scratch = tmp("scratch");
    fs.writeFileSync(path.join(scratch, "page.html"), "<h1>Every case</h1>");
    const context = "I would ship this.\n\n> Just tried you by phone\n";
    const r = guard(run, ["decide", "Ship the fix that leads with the open intro?", "-o", "Ship :: recorded as approved", "-o", "Drop :: this fix only", "--context", "-", "--report", path.join(scratch, "page.html")], { stdin: context });
    expect(r.code).toBe(0);
    expect(r.out).toContain("recorded");
    // The page is gone before anyone reads the run, as a temp dir is.
    fs.rmSync(scratch, { recursive: true });

    const writes = readWrites(run);
    expect(writes).toHaveLength(1);
    expect(writes[0].argv[1]).toBe("Ship the fix that leads with the open intro?");
    expect(writes[0].stdin).toBe(context);
    const decision = captureDecision(writes)!;
    expect(decision.question).toBe("Ship the fix that leads with the open intro?");
    expect(decision.options).toEqual([{ label: "Ship", description: "recorded as approved" }, { label: "Drop", description: "this fix only" }]);
    expect(decision.context).toBe("I would ship this.\n\n> Just tried you by phone");
    expect(decision.report).toEqual({ path: path.join(scratch, "page.html"), kind: "html", content: "<h1>Every case</h1>" });
    expect(decision.missing).toEqual([]);
    // The dry run's own guard still logged the call as one that never ran.
    expect(fs.readFileSync(path.join(run, "calls.log"), "utf8")).toContain("REFUSED decide ");
  });

  test("a relative report path is copied from the directory the station called from", () => {
    const run = tmp("guard");
    const cwd = tmp("cwd");
    fs.writeFileSync(path.join(cwd, "report.md"), "# Full proposal");
    guard(run, ["decide", "Q?", "-o", "A", "-o", "B", "--context", "c", "--report", "report.md"], { cwd });
    expect(captureDecision(readWrites(run))!.report).toEqual({ path: "report.md", kind: "md", content: "# Full proposal" });
  });

  test("other writes are recorded and refused; a read and a help call are not recorded", () => {
    const run = tmp("guard");
    const moved = guard(run, ["signal", "move", "--fingerprint", "k", "--from", "ct-1", "--to", "ct-2"]);
    expect(moved.code).toBe(1);
    expect(moved.err).toContain("refused");
    guard(run, ["signal", "ls", "--task", "ct-1"]);
    guard(run, ["decide", "--help"]);
    guard(run, ["decide", "ls"]);
    expect(readWrites(run).map((w) => w.argv.slice(0, 2))).toEqual([["signal", "move"]]);
  });

  test("the pin is answered as recorded, with its report and fields readable", () => {
    const run = tmp("guard");
    const pin = 'The fix reaches 19 of 21 conversations.\n\n```json\n{"recommend":"ship","reach":{"covers":["sg-1"]}}\n```\n';
    expect(guard(run, ["state", "--status", "done", "-"], { stdin: pin }).code).toBe(0);
    const got = capturePin(readWrites(run))!;
    expect(got.status).toBe("done");
    expect(got.fields).toEqual({ recommend: "ship", reach: { covers: ["sg-1"] } });
    expect(got.text).toStartWith("The fix reaches 19 of 21");
  });
});

describe("captureDecision", () => {
  const rec = (n: number, argv: string[], stdin: string | null = null, files: Record<string, string> = {}): WriteRecord => ({ n, argv, stdin, files });

  test("no decide call is no decision", () => {
    expect(captureDecision([rec(1, ["state", "--status", "done", "x"]), rec(2, ["task", "comment", "ct-1", "x"])])).toBeNull();
  });

  test("an edit rewrites the open decision in place, and the last post wins", () => {
    const d = captureDecision([
      rec(1, ["decide", "First?", "-o", "A :: a", "-o", "B", "--context", "one"]),
      rec(2, ["decide", "Second?", "-o", "Ship :: s", "-o", "Revise :: r", "-o", "Drop :: d", "--context", "two"]),
      rec(3, ["decide", "edit", "--context", "-"], "three\n"),
      rec(4, ["decide", "edit", "--question", "Third?", "-o", "Keep", "-o", "Change"]),
    ])!;
    expect(d.question).toBe("Third?");
    expect(d.context).toBe("three");
    expect(d.options).toEqual([{ label: "Keep" }, { label: "Change" }]);
    expect([d.posts, d.edits, d.from]).toEqual([2, 2, [2, 3, 4]]);
  });

  test("what the call named and the record lacks is listed, never invented", () => {
    const d = captureDecision([rec(1, ["decide", "Q?", "-o", "A", "-o", "B", "--context", "-", "--report", "/gone/page.html"])])!;
    expect(d.context).toBe("");
    expect(d.report).toEqual({ path: "/gone/page.html", kind: "html", content: null });
    expect(d.missing).toEqual(["stdin for --context -", "--report /gone/page.html: the file was not there to copy"]);
  });

  test("a spec file's question, context and options are read as the CLI reads them", () => {
    const dir = tmp("spec");
    const spec = path.join(dir, "spec.json");
    fs.writeFileSync(spec, JSON.stringify({ question: "From spec?", context_md: "ctx", options: [{ label: "One", description: "first" }, { label: "Two" }] }));
    const d = captureDecision([rec(1, ["decide", "--spec", "spec.json"], null, { "spec.json": spec })])!;
    expect(d.question).toBe("From spec?");
    expect(d.context).toBe("ctx");
    expect(d.options).toEqual([{ label: "One", description: "first" }, { label: "Two" }]);
  });

  test("a cancel is shown as one", () => {
    expect(captureDecision([rec(1, ["decide", "Q?", "-o", "A", "-o", "B", "--context", "c"]), rec(2, ["decide", "cancel"])])!.cancelled).toBe(true);
  });

  test("several - values split one stdin on --- lines; one takes it whole", () => {
    expect(stdinSections("a\n---\nb\n", 1)).toEqual(["a\n---\nb"]);
    expect(stdinSections("a\n---\nb\n", 2)).toEqual(["a", "b"]);
  });
});

describe("the replayed prompt", () => {
  /** A repo with one graph and two checkpoints of one problem. */
  function fixture() {
    const repo = tmp("repo");
    const graph = path.join(repo, "line", "trial.cast");
    fs.mkdirSync(path.dirname(graph), { recursive: true });
    fs.writeFileSync(graph, `digraph trial {
  graph [goal="$task_title"]
  start [shape=Mdiamond, label="Start"]
  exit [shape=Msquare, label="Exit"]
  build [label="Build", shape=tab, backend=session, prompt="build it"]
  present [label="Present", shape=tab, backend=session, prompt="old words for $task_id"]
  card [label="Card", shape=parallelogram, script="echo $present.json"]
  decide [label="Decide", shape=hexagon]
  start -> build -> present -> card -> decide
  card -> present [condition="outcome = failure"]
  decide -> build [label="Revise"]
  decide -> exit [label="Ship"]
}`);
    const runs = path.join(repo, ".git", "cast-line", "trial-ct-7", "runs");
    fs.mkdirSync(runs, { recursive: true });
    const context = {
      task_id: "ct-7", goal: "Contacts hear nothing", worktree: "trial-ct-7",
      "build.json": JSON.stringify({ outcome: "built", summary: "one rule rewritten" }),
      "present.json": JSON.stringify({ recommend: "ship" }), "present.output": "old", "present.session_id": "jx1",
      "card.output": "the finished card", "card.json": "{}", "decide.outcome": "ship",
      "human.gate.label": "Ship", "human.message": "send it",
    };
    fs.writeFileSync(path.join(runs, "old.json"), JSON.stringify({ run_id: "old", node_id: "build", at: 100, context: { task_id: "ct-7" } }));
    fs.writeFileSync(path.join(runs, "new.json"), JSON.stringify({ run_id: "new", node_id: "decide", at: 200, context }));
    fs.writeFileSync(path.join(runs, "torn.json"), "{");
    fs.mkdirSync(path.join(repo, ".git", "cast-line", "trial-ct-7-before-20261012-0609"), { recursive: true });
    return { repo, graph };
  }

  test("the newest checkpoint is the one replayed, and a backup directory is not a problem", () => {
    const { repo } = fixture();
    expect(checkpointRefs(repo, "trial")).toEqual(["ct-7"]);
    const [first, second] = problemCheckpoints(repo, "trial", "ct-7");
    expect([first.run_id, second.run_id]).toEqual(["new", "old"]);
  });

  test("a replay is a first visit: the station's own output, the card built from it and the answer are gone; earlier stations stay", () => {
    const { repo, graph } = fixture();
    const cp = problemCheckpoints(repo, "trial", "ct-7")[0];
    expect(nodesAfter(graph, "present").sort()).toEqual(["card", "decide"]);
    const context = replayContext(cp.context, "present", nodesAfter(graph, "present"), { "shared.json": "{}" });
    expect(Object.keys(context).sort()).toEqual(["build.json", "goal", "human.message", "shared.json", "task_id", "worktree"]);
    expect(context["human.message"]).toBe("");
  });

  test("the prompt file replaces the node's prompt and expands through the runner", () => {
    const { repo, graph } = fixture();
    const cp = problemCheckpoints(repo, "trial", "ct-7")[0];
    const context = replayContext(cp.context, "present", nodesAfter(graph, "present"));
    const brief = presenterPrompt(graph, "present", "Present $task_id: $build.json.summary. Refused: [$card.output]", context);
    expect(brief).toContain("# Goal\nContacts hear nothing");
    expect(brief).toContain("# Task: Present\nPresent ct-7: one rule rewritten. Refused: []");
    expect(brief).toContain('the "Present" step of workflow trial');
    expect(brief).not.toContain("old words");
  });
});

describe("fixKind", () => {
  test("tests, recorded cases and repro scripts are not the fix", () => {
    const prompt = fixKind(["backend/src/prompts/templates/partials/task.njk", "backend/tests/fixtures/x/email.txt", "backend/tests/unit/repro.test.ts", "backend/scripts/repro/ct-1.ts"]);
    expect([prompt.kind, prompt.prompt.length, prompt.support.length]).toEqual(["prompt", 1, 3]);
    expect(fixKind(["backend/src/lib/slotOffers.ts", "backend/tests/unit/slotOffers.test.ts"]).kind).toBe("code");
    expect(fixKind(["backend/src/lib/a.ts", "backend/src/prompts/b.njk"]).kind).toBe("prompt+code");
    expect(fixKind(["backend/tests/unit/a.test.ts"]).kind).toBe("none");
  });
});

describe("the preview", () => {
  const decision = captureDecision([{
    n: 1, stdin: null, files: {},
    argv: ["decide", "Ship the <fix>?", "-o", "Ship :: recorded as approved", "-o", "Send it back: lead with the intro :: goes to the builder", "--context",
      "I would **ship**. See union:conversation/3f2a9c1e-aaaa-bbbb-cccc-1234567890ab@2026-10-09T14:03:00Z for the case.\n\n> Just tried you by phone\n\n```cast-canvas\n<div data-canvas-title=\"Before and after\"><b style=\"color:var(--sol-red)\">before</b></div>\n```\n\nAfter the canvas."],
  }])!;

  test("the question, the rendered context, each answer and the free answer are on the page", () => {
    const html = renderPreview({ ...decision, report: { path: "r.html", kind: "html", content: "<html><body><h1>Every case</h1><script>1</script></body></html>" } }, { ref: "ct-7", prompt: "/x/card.md", model: "claude-opus-5-5", cost: 2.128, took: "391s", turns: 31 });
    expect(html).toContain('<h1 class="q">Ship the &lt;fix&gt;?</h1>');
    expect(html).toContain("<strong>ship</strong>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain('<div class="l">Send it back: lead with the intro</div><div class="d">goes to the builder</div>');
    expect(html).toContain("Or answer in your own words");
    expect(html).toContain("$2.13");
    // The canvas is framed without scripts and titled; the report is framed whole below, with the page theme it gets when published.
    expect(html).toContain('<figcaption>Before and after</figcaption><iframe class="fit" sandbox="allow-same-origin"');
    expect(html).toContain('<iframe class="page" sandbox="allow-scripts allow-popups" srcdoc="');
    expect(html).toContain("Every case");
    expect(html.indexOf("After the canvas")).toBeGreaterThan(html.indexOf("figcaption"));
    expect(html).not.toContain("language-cast-canvas");
  });

  test("a product view reference in a sentence becomes a pill; a url stays a url", () => {
    const html = renderDecisionMarkdown("Read union:conversation/3f2a9c1e-aaaa-bbbb-cccc-1234567890ab@2026-10-09T14:03:00Z and https://codecast.sh/a/slug-12345678.");
    expect(html).toContain('<span class="pv" title="union:conversation/3f2a9c1e-aaaa-bbbb-cccc-1234567890ab@2026-10-09T14:03:00Z">union conversation as of 2026-10-09 14:03Z</span>');
    expect(html).toContain("https://codecast.sh/a/slug-12345678");
  });

  test("a markdown report renders in place; a missing one and a missing decision say so", () => {
    expect(renderPreview({ ...decision, report: { path: "r.md", kind: "md", content: "## Cases\n\n| a | b |\n|---|---|\n| 1 | 2 |" } }, { ref: "ct-7", prompt: "p.md", model: "m" })).toContain("<h2>Cases</h2>");
    expect(renderPreview(decision, { ref: "ct-7", prompt: "p.md", model: "m" })).toContain('<span class="gap">no report</span>');
    const none = renderPreview(null, { ref: "ct-7", prompt: "p.md", model: "m", said: "I could not post <it>." });
    expect(none).toContain("The station posted no decision");
    expect(none).toContain("I could not post &lt;it&gt;.");
  });
});

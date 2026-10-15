import { describe, expect, test } from "bun:test";
import { askAsQuestion, askLine, askParts, buildLineInbox, trialAsk, trialCardWaits, trialCardAnswerable, groupFailures, inboxCount, inboxProcessOf, lineProjectCounts, type InboxRow } from "../lineInbox";
import { failCause } from "../runReport";
import { isPractice, lineNeeds } from "../lineNeeds";
import type { LineIssue } from "../lineModel";
import type { LineAdmission, RollupRow } from "../../lineFlow";

const now = Date.UTC(2026, 9, 11, 12);
const H = 3_600_000;
const cause = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id, short_id: `ct-${id}`, title: `Problem ${id}`, status: "open", created_at: now - 48 * H, updated_at: now - 2 * H, project_id: "p1",
  cause: { signal_count: 1, first_seen: now - 48 * H, last_seen: now - 2 * H, fingerprints: [] }, ...over,
});
const rollup = (over: Partial<RollupRow> = {}): RollupRow => ({ key: "p1", title: "P1", signalsDay: 0, causes: 0, build: 0, awaiting: 0, watching: 0, closed: 0, finders: 0, silent: 0, undeclared: [], hold: null, stalled: 0, failing: false, graphs: [], neverRun: 0, unapproved: 0, notReady: [], ready: 0, notReadyIds: [], startingOff: false, ...over });
const off: LineAdmission = { role: { id: "r", handle: "lead", paused: false }, on: false, slots: 1, busy: null, hands: null, handsCap: null };

describe("the line's inbox", () => {
  test("a fix decision a run asked about a problem in view is a decide row, first, naming the problem and asking its question", () => {
    const rows = buildLineInbox({
      signals: [], runs: [], projects: [], rollups: [], admissions: new Map(), now,
      tasks: [cause("1"), cause("2", { status: "in_review" })] as never,
      decisions: [
        { _id: "d1", short_id: "sd-7", status: "pending", task_id: "1", workflow_run_id: "r1", question: "Ship the shorter close? It drops the doctrine line.", created_at: now - H },
        { _id: "d2", short_id: "sd-8", status: "pending", task_id: "9", workflow_run_id: "r9", question: "Not in view?", created_at: now - H },
        { _id: "d3", short_id: "sd-9", status: "answered", task_id: "2", workflow_run_id: "r2", question: "Done?", created_at: now - H },
      ] as never,
    });
    expect(rows[0].kind).toBe("decide");
    expect(rows[0].rows).toHaveLength(1);
    expect(rows[0].rows[0]).toMatchObject({ title: "Problem 1", ref: "ct-1", cardRef: "sd-7", ask: "Ship the shorter close?" });
  });

  test("each thing waiting on the viewer is a row in its group, with the concrete detail", () => {
    const groups = buildLineInbox({
      signals: [],
      tasks: [
        cause("1"),
        cause("2", { readiness: "needs_context", readiness_note: "Which tenant\n saw it?" }),
        cause("3", { status: "in_review" }),
        cause("4", { workflow_run_id: "r4" }),
      ] as never,
      runs: [{ _id: "r4", task_id: "4", status: "failed", fail_reason: "prove timed out", created_at: now - 3 * H, updated_at: now - 2 * H }] as never,
      decisions: [{ _id: "d1", short_id: "sd-1", status: "pending", blocking: true, task_id: "1", workflow_run_id: "r1", created_at: now - H }],
      projects: [{ _id: "p1", title: "Codecast" }],
      rollups: [rollup({ causes: 3, hold: "@lead's line is off, so nothing starts on its own", startingOff: true })],
      admissions: new Map([["p1", off]]),
      now,
    });
    // A problem in review asks the viewer nothing: it is not listed.
    expect(groups.map((g) => g.kind)).toEqual(["decide", "confirm", "failed", "stuck"]);
    const by = Object.fromEntries(groups.map((g) => [g.kind, g.rows]));
    expect(by.decide[0]).toMatchObject({ title: "Problem 1", ref: "ct-1", cardRef: "sd-1", runId: "r1" });
    expect(by.confirm[0]).toMatchObject({ ref: "ct-2", detail: null, ask: "Which tenant saw it?" });
    expect(by.failed[0]).toMatchObject({ ref: "ct-4", runId: "r4", detail: "prove timed out" });
    expect(by.stuck[0]).toMatchObject({ title: "Codecast", detail: "Line off", waiting: 3, switchOff: true });
    // For you counts the decision a session presents; a new problem to confirm, a failed run and the project that cannot start are listed, never counted.
    expect(inboxCount(groups)).toBe(1);
  });

  test("a row asks the question grounding wrote, said as what to do", () => {
    expect(askLine("One report: the ledger shows it completed. A person needs to confirm which state is true. If cancelled, fix it.")).toBe("Confirm which state is true.");
    // An ask that only points back ("Say which, because ...") carries the sentence it points at, so it reads as a whole question.
    expect(askLine("It is unclear whether the caller misspoke or the line dropped. Say which, because that decides the fix.")).toBe("It is unclear whether the caller misspoke or the line dropped: say which, because that decides the fix.");
    expect(askLine("Only 1 signal, and it is unclear this is a defect. A person must say which sender is Union's.")).toBe("Say which sender is Union's.");
    expect(askLine(null)).toBe("Is this a real problem?");
    // The card says the question once; only what the note says besides it sits under it.
    expect(askParts("The ledger shows it completed. It can't be worked yet because nobody knows the state. A person needs to confirm which state is true.")).toEqual({ question: "Confirm which state is true.", context: "The ledger shows it completed." });
    expect(askParts("A person must say which sender is ours.").context).toBeNull();
    expect(askParts("Akash took the call. It can't be worked yet because nothing says whether Quinn left.")).toEqual({ question: "Nothing says whether Quinn left.", context: "Akash took the call." });
    expect(askLine("One report. Nothing shows whether João was told. A person needs to supply that before anyone closes it.")).toBe("Nothing shows whether João was told: supply that before anyone closes it.");
  });

  test("an ask said as a statement reads as the question it is, its alternatives as one-press answers (ct-58311)", () => {
    const quinn = askParts("Akash dealt with Quinn but the follow-ups were signed Riley. It can't be worked yet because the report says the persona rule is under review, and nothing says whether Quinn has actually left (so Riley is correct) or is still active (so the switch is the bug).").question;
    expect(askAsQuestion(quinn)).toEqual({
      question: "Has Quinn actually left, or is Quinn still active?",
      choices: [{ says: "Quinn has actually left", so: "so Riley is correct" }, { says: "Quinn is still active", so: "so the switch is the bug" }],
    });
    // A question stays as asked; alternatives with no auxiliary to turn round still ask which.
    expect(askAsQuestion("Has Quinn left, or is Riley wrong?")).toEqual({ question: "Has Quinn left, or is Riley wrong?", choices: [] });
    expect(askAsQuestion("Confirm whether the names came from truncated data or from the grader.").question).toBe("Which is it: the names came from truncated data, or from the grader?");
    // ct-58683's note, cut at its cap inside the ask's second alternative: the ask is kept, marked cut, and its whole
    // first alternative is asked as a yes or no, with that alternative as the one-press answer.
    const cut = "The call grader's feedback is wrong for Eric S on call 94373d15: it said one name was on his card when four were sent, and it faulted him for not naming people the contact already had in writing and had deferred to email. This threatens the trustworthy call process in pj-mtd94t23. The fix is probably in the grader prompt or in how card context is built, but the signal doesn't say which. A person needs to confirm whether the card's name set came from truncated data (a data or code bug) or from th";
    expect(cut.length).toBe(500);
    const ask = askParts(cut).question;
    expect(ask).toBe("Confirm whether the card's name set came from truncated data (a data or code bug) or from th…");
    expect(askAsQuestion(ask)).toEqual({ question: "Is it true that the card's name set came from truncated data (a data or code bug)?", choices: [{ says: "The card's name set came from truncated data", so: "a data or code bug" }] });
    // A clause after the alternatives says why the answer matters; it is not part of the last one (ct-57537, ct-58279).
    const transcript = askParts("The title (rep skipped discovery questions) doesn't match the evidence (transcript holds only the rep's side). A person must confirm whether the contact's speech is lost in call capture/transcription or the call_eval judge is only being given a partial transcript, since the fix lives in a different place for each. The finder's hint 'trust_breaking_issues_per_day' is not in the brief, so this is tied to the Agent Quality project.").question;
    expect(askAsQuestion(transcript).choices.map((c) => c.says)).toEqual(["The contact's speech is lost in call capture/transcription", "The call_eval judge is only being given a partial transcript"]);
    const rep = askParts("This is one of 15 findings in an open AgentWatch cluster, so it counts against the cluster inbox-zero goal. What's missing is whether the substitute rep and the 888 number come from scheduling/routing logic or from the confirmation prompt promising a named rep and a 312 number the system can't guarantee. A person has to say which, because that decides if the fix is code, prompt or telephony. Category is a provisional guess.").question;
    expect(askAsQuestion(rep).choices.map((c) => c.says)).toEqual(["The substitute rep and the 888 number come from scheduling/routing logic", "From the confirmation prompt promising a named rep and a 312 number the system can't guarantee"]);
    // Cut inside the first alternative, nothing is whole: read as written.
    expect(askAsQuestion("Confirm whether the card's name set came from trunc…")).toEqual({ question: "Confirm whether the card's name set came from trunc…", choices: [] });
  });

  test("a failed run on a closed problem, or an earlier failure before a newer run, waits on no one", () => {
    const groups = buildLineInbox({
      signals: [],
      tasks: [cause("5", { status: "done" }), cause("6")] as never,
      runs: [
        { _id: "a", task_id: "5", status: "failed", created_at: now - 3 * H, updated_at: now - 3 * H },
        { _id: "b", task_id: "6", status: "failed", created_at: now - 5 * H, updated_at: now - 5 * H },
        { _id: "c", task_id: "6", status: "completed", created_at: now - 4 * H, updated_at: now - 4 * H },
      ] as never,
      decisions: [],
      projects: [],
      rollups: [],
      admissions: new Map(),
      now,
    });
    expect(groups.find((g) => g.kind === "failed")).toBeUndefined();
  });

  test("failed runs read as the station and what happened there, and runs that stopped the same way are one line", () => {
    expect(failCause({ fail_reason: "max_visits=3 exceeded on implement" })).toMatchObject({ step: "implement", label: "Implement went round 3 times and stopped" });
    // A loop a red check drove names the check, and a base that was already red reads as pre-existing.
    const verify = '{"ok":false,"steps":[{"name":"typecheck","ok":false,"detail":"exit 1"},{"name":"tripwires","ok":true}]}\ncheck: typecheck\n../backend/src/lib/apollo.ts(54,13): error TS7006: x\n../backend/src/lib/fonts.ts(1,1): error TS1: y';
    const build = { node_id: "build", status: "failed", session: { _id: "s", result: '{"outcome":"built","files":["outreach/backend/src/routes/calls.ts"]}' } };
    const red = failCause({ fail_reason: "max_visits=3 exceeded on build", node_statuses: [build, { node_id: "verify", status: "failed", outcome: "failure", result_preview: verify }] });
    expect(red.label).toBe("killed: typecheck (not in diff) red ×3");
    expect(red.check).toMatchObject({ step: "verify", failed: ["typecheck"], files: ["apollo.ts", "fonts.ts"], preExisting: true });
    // A red test outside the change is named by its suite (ct-59231: a fix killed three times by opsApi's env guard).
    const tests = '{"ok":false,"steps":[{"name":"touched tests (968)","ok":false,"detail":"exit 1"}]}\n      at <anonymous> (/w/outreach/backend/tests/unit/opsCallCards.test.ts:97:68)\n(fail) opsApi > refuses under the test runner without the opt-in [0.51ms]\n(pass) opsApi > sends the service key [0.09ms]';
    const env = failCause({ fail_reason: "max_visits=3 exceeded on build", node_statuses: [build, { node_id: "verify", status: "failed", outcome: "failure", result_preview: tests }] });
    expect(env.label).toBe("killed: opsApi (not in diff) red ×3");
    expect(env.check?.tests).toEqual(["opsApi > refuses under the test runner without the opt-in"]);
    const own = failCause({ fail_reason: "max_visits=3 exceeded on build", node_statuses: [{ ...build, session: { _id: "s", result: '{"outcome":"built","files":["tests/unit/opsCallCards.test.ts"]}' } }, { node_id: "verify", status: "failed", outcome: "failure", result_preview: tests }] });
    expect(own.label).toBe("opsApi red 3 times, Build stopped retrying");
    const silent = failCause({ fail_reason: "max_visits=3 exceeded on build", node_statuses: [build, { node_id: "verify", status: "failed", outcome: "failure", result_preview: "" }] });
    expect(silent.label).toBe("Verify failed 3 times, Build stopped retrying");
    expect(failCause({ fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)" })).toMatchObject({ key: "deadend-silent:prove", step: "prove", label: "Prove ended without a report" });
    // A session whose result is only its routing JSON still reported: its pinned words are the report.
    expect(failCause({ fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)", node_statuses: [{ node_id: "prove", status: "failed", session: { _id: "s", result: '{"reproduced": true}', state: "Showed the grader still faulting Anna.\n```json\n{\"reproduced\": true}\n```" } }] as never })).toMatchObject({ key: "deadend:prove", label: "Prove: Showed the grader still faulting Anna." });
    expect(failCause({ fail_reason: "no outgoing edge from implement (outcome failure, review_verdict none)" })).toMatchObject({ step: "implement", label: "Implement ended without a report" });
    expect(failCause({ fail_reason: "hand jx7f7qs killed after 180m at implement" })).toMatchObject({ step: "implement", label: "Out of time, 3h" });
    expect(failCause({ fail_reason: "something odd (detail)", current_node_id: "ship" })).toMatchObject({ step: "ship", label: "something odd", raw: "something odd (detail)" });
    const row = (k: string, reason: string, at: number): InboxRow => ({ key: k, kind: "failed", at, projectId: "p1", title: k, ref: k, detail: null, caseId: k, runId: k, cardId: null, cardRef: null, fail: failCause({ fail_reason: reason }) });
    const groups = groupFailures([
      row("a", "max_visits=3 exceeded on implement", 1), row("b", "max_visits=3 exceeded on implement", 5), row("c", "max_visits=3 exceeded on implement", 2),
      row("d", "hand x killed after 180m at implement", 3), row("e", "hand y killed after 90m at implement", 4),
      row("f", "max_visits=2 exceeded on prove", 9),
    ]);
    expect(groups.map((g) => [g.step, g.label, g.rows.length])).toEqual([["implement", "Implement went round 3 times and stopped", 3], ["implement", "Out of time", 2], ["prove", "Prove went round 2 times and stopped", 1]]);
    expect(groups[0].rows.map((r) => r.key)).toEqual(["b", "c", "a"]);
    expect(groups[0].newest).toBe(5);
  });

  test("a project's counts are the same picked or not: for you never exceeds open, and the projects sum to the whole", () => {
    const groups = buildLineInbox({
      signals: [],
      tasks: [cause("1"), cause("2", { project_id: "p2" }), cause("3")] as never,
      runs: [], decisions: [{ _id: "d1", short_id: "sd-1", status: "pending", blocking: true, task_id: "1", workflow_run_id: "r1", created_at: now - H }, { _id: "d2", short_id: "sd-2", status: "pending", blocking: true, task_id: "2", workflow_run_id: "r2", created_at: now - H }], projects: [{ _id: "p1", title: "P1" }, { _id: "p2", title: "P2" }],
      rollups: [rollup({ causes: 1, hold: "off", startingOff: true })], admissions: new Map([["p1", off]]), now,
    });
    const of = inboxProcessOf([], [{ _id: "1", project_id: "p1" }, { _id: "2", project_id: "p2" }, { _id: "3", project_id: "p1" }]);
    const drawn = of.task({ _id: "1", project_id: "p1" });
    const projectOf = (id: string) => (id === "2" ? "p2" : "p1");
    // Issue 3 is open and waits on no one; the two with a fix to decide wait on the viewer.
    const issue = (id: string, status: string) => ({ id, status, history: { attempts: [], closes: [], watches: [], occurrences: [], regressions: [], recurrences: [], ships: [], regressed: false, cameBack: false } } as unknown as LineIssue);
    const counts = lineProjectCounts(groups, of, drawn, [issue("1", "in_review"), issue("2", "in_review"), issue("3", "open")], projectOf);
    expect(counts.get("p1")).toEqual({ forYou: 1, open: 2 });
    expect(counts.get("p2")).toEqual({ forYou: 1, open: 1 });
    expect([...counts.values()].reduce((n, c) => n + c.forYou, 0)).toBe(inboxCount(groups));
    // Over every process (drawn null), as Problems lists them: a row in another process counts too.
    const other = inboxProcessOf([{ _id: "r", task_id: "2", workflow_slug: "agentwatch", created_at: now } as never], [{ _id: "1", project_id: "p1" }, { _id: "2", project_id: "p2" }, { _id: "3", project_id: "p1" }]);
    expect(lineProjectCounts(groups, other, "a-process-with-nothing", [], projectOf).get("p2")?.forYou ?? 0).toBe(0);
    expect(lineProjectCounts(groups, other, null, [], projectOf).get("p2")?.forYou).toBe(1);
  });

  test("a waiting trial card no session asked is a proposal that only opens; an answered one waits on no one, and its problem leaves the later groups", () => {
    const card = (id: string, task: string, over: Record<string, unknown> = {}) => ({
      _id: id, short_id: `tc-${id}`, project_id: "p1", task_id: task, task_short_id: `ct-${task}`, task_title: `Problem ${task}`, run_id: `run-${id}`,
      kind: "card" as const, question: "Ship this change? Let close notes ask who else", card: { headline: "Let close notes ask who else", checks: [] },
      options: [{ key: "S", label: "Ship" }, { key: "R", label: "Revise" }, { key: "D", label: "Drop" }], status: "waiting" as const, created_at: now - 2 * H, ...over,
    });
    const groups = buildLineInbox({
      signals: [], tasks: [cause("7"), cause("8", { readiness: "needs_context" })] as never,
      runs: [], decisions: [], projects: [], rollups: [], admissions: new Map(), now,
      trialCards: [
        card("2", "8", { created_at: now - H }),
        card("1", "7", { kind: "gate", question: "When a contact goes quiet, should the broker stop? Built on three findings.", card: undefined, options: [{ key: "A", label: "Approve" }] }),
        card("3", "7", { status: "answered" }),
        card("4", "9", { created_at: now - 3 * H }),
      ],
    });
    // No station posted these as decisions: nobody can take an answer, so they are proposals to read, never "for you".
    const trial = groups.find((g) => g.kind === "proposal")!;
    // A proposal holds nothing back: problem 8's own ask, which a person can answer, is listed ahead of it.
    expect(groups.map((g) => g.kind)).toEqual(["confirm", "proposal"]);
    expect(trial.label).toBe("Runs to ask again");
    expect(trial.rows.map((r) => r.cardRef)).toEqual(["tc-4", "tc-1", "tc-2"]);
    expect(trial.rows[1]).toMatchObject({ ref: "ct-7", title: "Problem 7", ask: "When a contact goes quiet, should the broker stop?", runId: "run-1", cardId: "1", caseId: "7", projectId: "p1", at: now - 2 * H, trial: true });
    // A row carries no answers: it opens the card's decision, where the answer is given.
    expect("options" in trial.rows[1]).toBe(false);
    // A problem out of view still names itself from the card.
    expect(trial.rows[0]).toMatchObject({ ref: "ct-9", title: "Problem 9", ask: "Let close notes ask who else" });
    expect(inboxCount(groups)).toBe(0);
    expect(trialAsk({ kind: "card", question: "Ship it?", card: null })).toBe("Ship it?");
  });
});

describe("a card its run asks at its own gate", () => {
  // ct-59535: a judge fix whose run waits at Reviewer, carded before stations posted their cards as decisions. The run
  // takes the answer at its gate (lineTrial answerTrialCardCore), so the card is a fix to decide, never "no session".
  const gateCard = { _id: "c52", short_id: "tc-52", project_id: "p1", task_id: "t1", task_short_id: "ct-59535", task_title: "Rep follow-ups flagged as switches", run_id: "r1", kind: "card" as const,
    question: "Publish this change to the match extractor?", status: "waiting" as const, created_at: 1, decision: null, run_status: "paused",
    options: [{ key: "P", label: "Publish" }, { key: "R", label: "Revise" }, { key: "D", label: "Not now" }], judge_fix: { ab: { verdict: "better" } } };
  const rows = (card: object) => buildLineInbox({ tasks: [], runs: [], decisions: [], signals: [], projects: [], rollups: [], admissions: new Map(), now: 10, trialCards: [card] } as never).flatMap((g) => g.rows);
  test("is answerable while its run is paused there, a fix to decide that publishes", () => {
    expect(trialCardAnswerable(gateCard)).toBe(true);
    expect(rows(gateCard)[0]).toMatchObject({ kind: "decide", cardRef: "tc-52", decisionRef: null, recommend: "better", publishes: true, ask: "Publish this change to the match extractor?" });
    const need = lineNeeds([{ kind: "decide", label: "", rows: rows(gateCard) } as never])[0];
    expect(need).toMatchObject({ kind: "decision", ref: "tc-52", cardRef: "tc-52" });
    // Publish writes the judges: it is counted with the fixes to decide, never a trial's practice answer.
    expect(isPractice(need)).toBe(false);
  });
  test("asks again once its run left the gate or its step was removed", () => {
    expect(trialCardAnswerable({ ...gateCard, run_status: "running" })).toBe(false);
    expect(trialCardAnswerable({ ...gateCard, stale_gate: true })).toBe(false);
    expect(rows({ ...gateCard, stale_gate: true })[0]).toMatchObject({ kind: "proposal" });
  });
});

describe("trial cards in the Inbox", () => {
  const base = { _id: "c1", short_id: "tc-14", project_id: "p1", task_id: "t1", task_short_id: "ct-1", task_title: "A problem", run_id: "r1", kind: "card" as const, question: "Ship?", status: "waiting" as const, created_at: 1,
    options: [{ key: "S", label: "Ship" }, { key: "R", label: "Revise" }, { key: "D", label: "Drop" }],
    card: { headline: "Stop it", recommend: { verdict: "ship", why: "x" }, checks: [] } as never,
    evidence: { findings: 3, conversations: 2, withdrawn: 0, moved_to: [] } };
  const listed = (card: object) => buildLineInbox({ tasks: [], runs: [], decisions: [], signals: [], projects: [], rollups: [], admissions: new Map(), now: 10, trialCards: [card] } as never).flatMap((g) => g.rows).map((r) => r.cardRef);
  const holds = (card: object) => buildLineInbox({ tasks: [], runs: [], decisions: [], signals: [], projects: [], rollups: [], admissions: new Map(), now: 10, trialCards: [card] } as never).flatMap((g) => g.rows).map((r) => r.hold ?? null);
  test("every card the run waits on is listed; a hold is a chip on its row, never a reason to hide it", () => {
    const posted = { ...base, decision: { _id: "d1", short_id: "sd-9", status: "pending" } };
    expect(listed(posted)).toEqual(["tc-14"]);
    expect(holds(posted)).toEqual([null]);
    expect(holds({ ...posted, tooling: "judge" })).toEqual(["review tooling"]);
    expect(holds({ ...posted, card: { ...(base.card as object), risk: { class: "medium", reason: "x" } }, evidence: { findings: 1, conversations: 1, withdrawn: 0, moved_to: [] } })).toEqual(["1 conversation · waits for a second"]);
    expect(holds({ ...posted, evidence: { findings: 0, conversations: 0, withdrawn: 2, moved_to: ["ct-59425"] } })).toEqual(["Drop: evidence gone"]);
    // A card on its way to the next one waits on nobody now.
    expect(listed({ ...base, rebuilding: { since: 1, node: "build" } })).toEqual([]);
  });
  test("a card its station posted is a fix to decide that opens its decision, listed while the decision is pending", () => {
    const decision = { _id: "d1", short_id: "sd-9", status: "pending" };
    const rows = (status: string) => buildLineInbox({ tasks: [], runs: [], signals: [], projects: [], rollups: [], admissions: new Map(), now: 10,
      decisions: [{ ...decision, status, blocking: true, workflow_run_id: "r1", task_id: "t1", trial: true }],
      trialCards: [{ ...base, decision }] } as never).flatMap((g) => g.rows);
    expect(rows("pending").map((r) => [r.kind, r.decisionRef ?? null, r.trial])).toEqual([["decide", "sd-9", true]]);
    // The decision's own row is its home: answered there a moment ago, the card's stale copy no longer lists it.
    expect(rows("answered")).toEqual([]);
  });
  test("a card that cannot take an answer is a run to ask again, never a fix to decide: no session asked it, or its step left the line", () => {
    const decision = { _id: "d1", short_id: "sd-9", status: "pending" };
    const rows = (card: object) => buildLineInbox({ tasks: [], runs: [], decisions: [], signals: [], projects: [], rollups: [], admissions: new Map(), now: 10, trialCards: [card] } as never);
    const stale = rows({ ...base, decision, stale_gate: true });
    expect(stale.map((g) => [g.kind, g.label])).toEqual([["proposal", "Runs to ask again"]]);
    // It still opens its decision, where the session can be talked to; the chip says why it cannot be answered.
    expect(stale[0].rows[0]).toMatchObject({ decisionRef: "sd-9", holdLabel: "step removed", ref: "ct-1" });
    expect(rows(base)[0].rows[0]).toMatchObject({ kind: "proposal", holdLabel: "no session", decisionRef: null });
    expect(inboxCount(stale)).toBe(0);
    expect(trialCardAnswerable({ status: "waiting", decision })).toBe(true);
    expect(trialCardAnswerable({ status: "waiting", decision, stale_gate: true })).toBe(false);
    expect(trialCardAnswerable({ status: "waiting" })).toBe(false);
  });
  test("one predicate says whether a card waits: the Inbox, a run's chip and the Problems banner read it", () => {
    expect(trialCardWaits({ status: "waiting" })).toBe(true);
    expect(trialCardWaits({ status: "answered" })).toBe(false);
    expect(trialCardWaits({ status: "waiting", decision: { _id: "d", short_id: "sd-1", status: "pending" } })).toBe(true);
    expect(trialCardWaits({ status: "waiting", decision: { _id: "d", short_id: "sd-1", status: "pending" } }, "answered")).toBe(false);
    expect(trialCardWaits({ status: "waiting", decision: { _id: "d", short_id: "sd-1", status: "withdrawn" } })).toBe(false);
    expect(trialCardWaits({ status: "waiting", rebuilding: { since: 1 } })).toBe(false);
  });
});

describe("a trial project", () => {
  test("never waits on a start switch: its runs start on their own", () => {
    const rollup1 = { key: "p1", title: "AgentWatch Trial", causes: 4, hold: "no lead", startingOff: true } as never;
    const input = { tasks: [], runs: [], decisions: [], signals: [], projects: [{ _id: "p1", title: "AgentWatch Trial" }], rollups: [rollup1], admissions: new Map(), now: 10 } as never;
    expect(buildLineInbox(input).some((g) => g.kind === "stuck")).toBe(true);
    expect(buildLineInbox({ ...(input as object), trialProjects: new Set(["p1"]) } as never).some((g) => g.kind === "stuck")).toBe(false);
  });
});

describe("an ask whose whether is one part of it (ct-57427)", () => {
  test("is read as written, never cut down to its whether", () => {
    const note = "The title is about stop/unsubscribe handling (suppression scope, no acknowledgement), but the only evidence describes Jill getting three personas on two domains, which is a different problem. A person needs to say which behavior the cluster is about, and whether the persona rule under review already covers it, before anyone works on it.";
    const ask = askLine(note);
    expect(askAsQuestion(ask).question).toBe("Say which behavior the cluster is about, and whether the persona rule under review already covers it, before anyone works on it.");
    // A plain whether still reads as the question it is.
    expect(askAsQuestion("Nothing says whether Quinn has actually left (so Riley is correct) or is still active (so the switch is the bug).").question).toBe("Has Quinn actually left, or is Quinn still active?");
  });
});

test("a note ending on a bare request asks what nobody knows instead (ct-57501)", () => {
  const note = "The expert rejected the draft because another email on the same topic had already gone to Paul Gallucci today. We can't tell whether that email came from the broker agent or was sent by the team outside the system, or whether the drafting step can see recent sends. If it can't, the fix is send-awareness or suppression logic rather than a prompt rewrite. Please name the earlier email and who sent it.";
  const ask = askLine(note);
  expect(ask).toBe("We can't tell whether that email came from the broker agent or was sent by the team outside the system, or whether the drafting step can see recent sends.");
  // Two whethers in one ask: read as written, never split into wrong choices.
  expect(askAsQuestion(ask)).toEqual({ question: ask, choices: [] });
});

describe("what else waits on the viewer: a fix main already carries, a problem assigned to them", () => {
  const base = { signals: [], decisions: [], projects: [], rollups: [], admissions: new Map(), now } as const;
  test("a run that parked a problem because main carries its fix is a need on Problems, never For you's (ct-59687)", async () => {
    const { lineNeeds } = await import("../lineNeeds");
    const groups = buildLineInbox({
      ...base,
      tasks: [cause("1", { readiness: "not_actionable", readiness_note: "Already fixed on main by fc0d85ba65 (classifies both files)", workflow_run_id: "r1" })] as never,
      runs: [{ _id: "r1", task_id: "1", status: "completed", created_at: now - 3 * H, updated_at: now - 2 * H, node_statuses: [{ node_id: "park_built", status: "completed", completed_at: now - 2 * H }, { node_id: "exit", status: "completed" }] }] as never,
    });
    const fixed = groups.find((g) => g.kind === "fixed")!;
    expect(fixed.rows[0]).toMatchObject({ ref: "ct-1", sha: "fc0d85ba65" });
    expect(lineNeeds(groups).map((n) => [n.kind, n.counted, n.sha])).toEqual([["fixed", false, "fc0d85ba65"]]);
    expect(inboxCount(groups)).toBe(0);
  });
  test("a problem assigned to the viewer that nothing runs on is theirs; one assigned to someone else is not (ct-59557)", async () => {
    const { lineNeeds } = await import("../lineNeeds");
    const groups = buildLineInbox({ ...base, viewer: "u1", runs: [], tasks: [cause("1", { assignee: "u1" }), cause("2", { assignee: "u2" }), cause("3", { assignee: "u1", status: "done" })] as never });
    expect(lineNeeds(groups).filter((n) => n.kind === "assigned").map((n) => n.problemRef)).toEqual(["ct-1"]);
  });
  test("a run's decision about a task that is not a line problem names that task, not its own question", () => {
    const d = { _id: "d1", short_id: "sd-9", status: "pending", blocking: true, workflow_run_id: "r1", task_id: "t9", question: "Should the grid pool each day's runs?", created_at: 5 };
    const rows = (otherTasks?: Map<string, { title: string; short_id: string | null; project_id: string | null }>) =>
      buildLineInbox({ tasks: [], runs: [], signals: [], projects: [], rollups: [], admissions: new Map(), now: 10, decisions: [d], otherTasks } as never).flatMap((g) => g.rows);
    expect(rows().map((r) => [r.title, r.ref])).toEqual([["Should the grid pool each day's runs?", "sd-9"]]);
    const named = rows(new Map([["t9", { title: "Evals grid empty at sparse batch density", short_id: "ct-9", project_id: "p1" }]]));
    expect(named.map((r) => [r.title, r.ref, r.projectId, r.ask])).toEqual([["Evals grid empty at sparse batch density", "ct-9", "p1", "Should the grid pool each day's runs?"]]);
  });
});

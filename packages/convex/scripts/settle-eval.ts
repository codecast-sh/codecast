// Settle-classifier eval: grade the EXACT prod prompt (buildSettlePrompt over
// shapeSettleTail) against labeled tails, real and synthetic.
//
//   ANTHROPIC_API_KEY=… bun scripts/settle-eval.ts                # run the suite
//   bun scripts/settle-eval.ts --fetch <conversation_id>…          # print shaped tails from prod (labeling aid)
//   bun scripts/settle-eval.ts --fixtures path.json                # extra labeled cases (real transcripts, kept out of the repo)
//
// A case is { name, expected: "done" | "needs_input", messages: SettleTailMessage[] }
// or { name, expected, conversation_id } (fetched live via `npx convex run`).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildSettlePrompt, parseSettleReply, shapeSettleTail, type SettleTailMessage } from "../convex/idleSummary";

type Case = { name: string; expected: "done" | "needs_input"; messages?: SettleTailMessage[]; conversation_id?: string; raw?: Array<{ role: string; content: string }> };

const tail = (turns: Array<[string, string]>): SettleTailMessage[] =>
  shapeSettleTail(turns.map(([role, content]) => ({ role, content })).reverse());

// Synthetic cases target the failure shapes seen live. Every "needs_input"
// case hides its ask where a lazy read misses it: at the END of a long
// message, after a delivery, or phrased as a deferral rather than a question.
const SYNTHETIC: Case[] = [
  {
    name: "closing report that ends by deferring the decision to a meeting",
    expected: "needs_input",
    messages: tail([
      ["assistant", "Eval gate is running with a background waiter armed — I'll be re-invoked when it completes, then deliver the closing report."],
      ["assistant", "Work complete — clean tree, fix pushed on the branch. ```cast-canvas <div>" + "x".repeat(3000) + "</div>```"],
      ["user", "<session-message from=\"unknown\" name=\"A\">can you explain a bit more clearly the options</session-message>"],
      ["assistant", "Sure — plainer version.\n\n**The problem.** " + "When someone converts they state exclusions nobody reads. ".repeat(20) + "\n\n**Fix B — built tonight.** Cheap guard before match creation. Covers path 1 only.\n\n**Fix A — not built.** Structured exclusions field, ~2 eng-days.\n\n**So the standup question is just:** ship B alone and watch, or ship B and fund A now. My recommendation is B + A."],
    ]),
  },
  {
    name: "delivered summary, no ask",
    expected: "done",
    messages: tail([
      ["user", "fix the flaky test"],
      ["assistant", "Green now (the one earlier failure was another session's fixture regeneration). The tasks snippet addition is two sentences plus two command lines; golden fixtures regenerated (19/19 pass), and the trimmed version is installed. Noted for future snippet edits: keep additions to a couple of lines."],
    ]),
  },
  {
    name: "delivered with a courtesy offer, no real question",
    expected: "done",
    messages: tail([
      ["user", "make the header sticky"],
      ["assistant", "Done — the header is sticky on scroll, verified in the browser at 3 widths, screenshots above. Shout if you want the shadow softer."],
    ]),
  },
  {
    name: "blocked on credentials",
    expected: "needs_input",
    messages: tail([
      ["user", "deploy it"],
      ["assistant", "Everything builds and tests pass. The deploy step needs the production Railway token, which isn't in the environment or 1Password — I can't push without it. Drop it in RAILWAY_TOKEN and I'll finish."],
    ]),
  },
  {
    name: "options offered with a recommendation, at the very end of a long message",
    expected: "needs_input",
    messages: tail([
      ["user", "how should we store the exclusions"],
      ["assistant", "Here is what I found. " + "The current model keeps exclusions in free text. ".repeat(60) + "\n\nTwo ways forward: (1) a structured `exclusions` field with a backfill, or (2) enforce at match creation only. I lean (1). Which do you want?"],
    ]),
  },
  {
    name: "agent finished and lists next steps IT will take",
    expected: "done",
    messages: tail([
      ["user", "audit the mobile repo"],
      ["assistant", "Audit complete — 14 findings, 3 high, written to docs/audit.md with file:line references and a fix order. Next I'll open the three high-severity fixes as tasks under pl-88 in the morning run."],
    ]),
  },
  {
    name: "waiting on another person mid-thread (not a machine)",
    expected: "needs_input",
    messages: tail([
      ["user", "get the design signed off"],
      ["assistant", "Mockups are posted in #design. Waiting on Sam's sign-off before I cut the branch — nothing more I can do until then."],
    ]),
  },
  {
    name: "earlier turn had a machine wait; final message delivers",
    expected: "done",
    messages: tail([
      ["assistant", "CI is running in the background — I'll be re-invoked when it finishes."],
      ["user", "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>"],
      ["assistant", "CI green: 212 tests, 0 failures. Merged the branch and closed ct-4102. That's the whole request."],
    ]),
  },
  {
    name: "half-delivered, then stopped mid-work on a tool call (no closing message)",
    expected: "needs_input",
    messages: shapeSettleTail([
      { role: "assistant", content: "", tool_calls: [{ name: "Bash" }] },
      { role: "assistant", content: "OTA is live. Now the native build so the TestFlight binary carries the dependency pin and permission strings:" },
      { role: "user", content: "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>" },
      { role: "user", content: "ship it" },
    ] as any),
  },
  {
    name: "findings report with problems listed but no ask",
    expected: "done",
    messages: tail([
      ["user", "check inventory coverage"],
      ["assistant", "Report sent to team-lead.\n\n**Findings: six real omissions, roughly 12,600 lines of uncovered code.**\n\nMethod was a literal name match against the inventory. Of 102 route files, 2 are unmatched; of 88 lib files, 4. I added rows S29–S34 for them. I also confirmed `routes/webhooks/**` is genuinely covered. The common cause: boundaries enumerate files by name, so anything whose name never surfaced ended up with no owner."],
    ]),
  },
  {
    name: "report that explicitly hands the human decisions",
    expected: "needs_input",
    messages: tail([
      ["user", "audit the outreach repo"],
      ["assistant", "Audit complete: 34 subsystems, 67 verified findings, report in docs/audit.md. Three product/engineering calls are yours: whether to delete the abandoned prompt-optimization pipeline and its five tables (nothing reads it), whether geo constraints should be enforced or stop being collected, and whether the worker-invite signup flow should be opened. The report ends with a ranked plan and four first slices."],
    ]),
  },
  {
    name: "single-word acknowledgement",
    expected: "done",
    messages: tail([["user", "reply ok"], ["assistant", "ok"]]),
  },
  {
    name: "asks a yes/no buried after a report",
    expected: "needs_input",
    messages: tail([
      ["user", "check the numbers"],
      ["assistant", "Numbers reconciled: revenue 41,203, refunds 1,120, net 40,083 — matches Stripe to the cent. One thing: the July row double-counts a refund; should I restate July or leave the historical figure alone?"],
    ]),
  },
  {
    name: "error the agent cannot resolve",
    expected: "needs_input",
    messages: tail([
      ["user", "run the migration"],
      ["assistant", "The migration fails at step 3: `permission denied for schema billing`. My role has no DDL on that schema and I can't grant it to myself. Someone with the admin role needs to run `GRANT CREATE ON SCHEMA billing TO app_migrator`."],
    ]),
  },
  {
    name: "final message is a plan the agent is about to execute (mid-work settle, no ask)",
    expected: "done",
    messages: tail([
      ["user", "go"],
      ["assistant", "Refactor landed: 9 files, all typechecks green, screenshots attached. Wrapping up."],
    ]),
  },
  // The done/needs_input line for deliveries that START work rather than finish
  // it: a diagnosis or design with the build still ahead is the human's
  // go-ahead moment, not a delivery — even when the message asks nothing.
  {
    name: "root cause found and fix proposed, nothing changed yet, no question",
    expected: "needs_input",
    messages: tail([
      ["user", "the inbox sometimes jumps to a random session — figure out what's going on"],
      ["assistant", "Root cause found: the tab URL's ?s= param re-asserts after the nav guard runs, so the stale param wins and moves the view. The fix is to gate the re-assert on a user-initiated source and drop the param echo on machine navs — about 30 lines in viewNav.ts plus a regression test. Nothing is changed yet."],
    ]),
  },
  {
    name: "design spec delivered for a feature, implementation still ahead",
    expected: "needs_input",
    messages: tail([
      ["user", "add multi-account switching to the CLI"],
      ["assistant", "Design written to docs/account-switch.md: token storage per account, proactive refresh, daemon handshake changes, and a two-step migration. Implementation touches auth.ts, daemon.ts and the keychain wrapper."],
    ]),
  },
];

function fetchTail(conversationId: string): SettleTailMessage[] {
  const r = spawnSync("npx", ["convex", "run", "idleSummary:getMessagesForSummary", JSON.stringify({ conversation_id: conversationId })], {
    encoding: "utf8",
    env: { ...process.env, CONVEX_DEPLOYMENT: "" },
    cwd: new URL("..", import.meta.url).pathname,
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

async function classify(messages: SettleTailMessage[], apiKey: string): Promise<{ verdict: string | null; summary: string; raw: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200, temperature: 0, messages: [{ role: "user", content: buildSettlePrompt(messages) }] }),
  });
  const data: any = await res.json();
  const raw = data.content?.[0]?.text?.trim() ?? JSON.stringify(data).slice(0, 200);
  return { ...parseSettleReply(raw), raw };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--fetch") {
    for (const id of argv.slice(1)) {
      const msgs = fetchTail(id);
      console.log(`\n=== ${id} (${msgs.length} msgs)`);
      for (const m of msgs) console.log(`--- ${m.role}${m.isFinal ? " [FINAL]" : ""} (${m.content.length})\n${m.content.slice(0, 1200)}${m.content.length > 1200 ? "\n[…]" : ""}`);
    }
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY required");
  const cases: Case[] = [...SYNTHETIC];
  const fi = argv.indexOf("--fixtures");
  if (fi >= 0) cases.push(...(JSON.parse(readFileSync(argv[fi + 1], "utf8")) as Case[]));

  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    const messages = c.messages ?? (c.raw ? shapeSettleTail([...c.raw].reverse()) : fetchTail(c.conversation_id!));
    const got = await classify(messages, apiKey);
    const ok = got.verdict === c.expected;
    if (ok) pass++;
    else failures.push(`✗ ${c.name}\n    expected ${c.expected}, got ${got.verdict ?? "null"} — ${got.raw.replace(/\n/g, " | ").slice(0, 200)}`);
    process.stdout.write(ok ? "." : "F");
  }
  console.log(`\n${pass}/${cases.length} correct`);
  for (const f of failures) console.log(f);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });

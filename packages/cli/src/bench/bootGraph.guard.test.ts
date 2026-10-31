// What every `cast` invocation pays before it does anything.
//
// ES imports are hoisted, so a single static `import` of a command group in
// index.ts is paid by `cast --help`, by `cast send`, and by a typo — none of
// which will ever run that group. commandGroups.ts exists to keep those groups
// behind a dynamic `import()`, and this guard is what keeps them there: it
// walks the static import graph from each entry and fails by name, with the
// chain that put the module back on the graph.
//
// It fails on the two ways the property is lost. Someone writes
// `import { registerBrowserCommand } from "./browser/cli.js"` in index.ts
// again — the direct way. Or a leaf module index.ts already loads grows an
// import of a group module, and the whole group arrives sideways; that is how
// the daemon ended up carrying `cast state` and `cast publish` before ct-49546.
//
// The ceilings are the same idea one level up, and they sit AT the last
// measurement so the graph can only shrink. A change that lifts one should say
// why in its commit, and say what grew.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_GROUPS } from "../commandGroups.js";
import { buildBootGraph, importChain, repoRootFrom, staticImportSpecifiers } from "./bootGraph.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = repoRootFrom(SRC);
const rel = (file: string) => path.relative(ROOT, file);

/** The two big walks read and parse ~200 and ~270 files. They sit just over
 *  bun's 5 s default on an idle box and well over it on a loaded agent box. */
const GRAPH_WALK_TIMEOUT = 60_000;

/** The group modules, as absolute paths. `./browser/cli.js` is `browser/cli.ts` on disk. */
const GROUP_MODULES = COMMAND_GROUPS.map((group) => {
  const spec = /import\("([^"]+)"\)/.exec(group.load.toString())?.[1];
  return { token: group.token, spec, file: path.join(SRC, (spec ?? "").replace(/^\.\//, "").replace(/\.js$/, ".ts")) };
});

function assertOffGraph(entry: string) {
  const graph = buildBootGraph(entry);
  const onGraph = GROUP_MODULES.filter((m) => graph.nodes.has(m.file)).map((m) => {
    const chain = importChain(graph, m.file)?.map(rel).join("\n    -> ") ?? "?";
    return `${m.token} (${rel(m.file)}) reached by:\n    ${chain}`;
  });
  expect(onGraph.join("\n\n"), `command groups on the static graph of ${rel(entry)}`).toBe("");
  return graph;
}

describe("command groups stay off the boot graph", () => {
  test("every listed group resolves to a module that exists", () => {
    for (const m of GROUP_MODULES) {
      expect(m.spec, `${m.token} must reach its module through a dynamic import("...")`).toBeTruthy();
      expect(Bun.file(m.file).size, `${rel(m.file)} (for group "${m.token}")`).toBeGreaterThan(0);
    }
  });

  test("index.ts, the CLI's command tree, statically imports no command group", () => {
    const graph = assertOffGraph(path.join(SRC, "index.ts"));
    // Budgets, set at the measurement so they ratchet. index.ts was 260 files
    // and 5.5 MB with the groups inlined. Lifted to 205 when ct-49546 landed on
    // a tree 35 commits newer than the one it was measured on, because the
    // eager graph had gained 14 `workers/*` modules; ct-49758 put those behind
    // dynamic imports and it came back to 190 against a measured 187/2,628 KB.
    //
    // Now 188 files and 2,663 KB, re-measured on the tree that finally wires
    // `cast computer` and `cast guide` (ct-49848, ct-49849). Neither costs
    // anything here: both are COMMAND_GROUPS entries, so assertOffGraph above
    // is what proves they are absent, and `cast computer setup` (ct-49790)
    // arrives with them for free — setup.ts is reached through run.ts, two
    // dynamic imports deep, so the file COUNT did not move when it landed.
    // The KB did, by 2: A10's longer doctor lines and setup guidance are prose
    // inside modules already on the graph, not new reach.
    //
    // The one file over ct-49758's number is shared/network/index.ts, which
    // main itself added under syncService.ts in 12ba53b50; the other candidate,
    // config/readAuthConfig.ts, WAS arriving through snippets.ts and was sent
    // back off the graph rather than paid for.
    //
    // Before lifting either number, find out WHY the graph grew. A group coming
    // back, or a whole subsystem arriving sideways through a leaf, is what this
    // exists to catch; a genuinely new module is not.
    //
    // 220 after the pl-552 landing. The 32 additions were checked one by one
    // against the rule above and every one is a genuinely new leaf: the shared
    // contracts the landing introduced (fence, liveness, sessionRead,
    // triggerPrecheck, plan foreign text), the codex account modules, the one
    // config-directory resolver, the workers' type-only modules, and three
    // workspace helpers. No command group is among them — that is the check
    // above, and it passes.
    //
    // 2,995 KB after ct-49854, at the same 220 files. The file count is the
    // number that answers the question this guard asks, and it did not move:
    // githubAppInstallState.ts arrived and sessionUpdates.ts left with the
    // batching it belonged to, so nothing reached anywhere new. The 9 KB is
    // modules already on the graph getting longer where ct-49854 added code —
    // shared/entities/index.ts (+3.5 KB), cloud/mirror/transform.ts (+2.4 KB)
    // and discovery.ts (+1.9 KB), appDescriptors.ts, workspace/chrome.ts,
    // syncScope.ts, syncService.ts — plus triggerPrecheck.ts from c1463717a.
    // Every import path was traced and each one predates the landing. A guard
    // on reach cannot hold a byte budget flat against features written into
    // files it has already accepted, so the bytes are re-pinned and the file
    // count is what stays honest.
    //
    // 2,998 with ct-49915, still at 220 files: the widened env rule in
    // workers/operations.ts and the one-shot report in slowSync.ts, both files
    // the graph already carried. Code, not reach — which is the distinction
    // this guard is for, and why the file count is the number to watch.
    //
    // 209 files and 2,867 KB after ct-49905, which is the first time these
    // numbers have come DOWN since the landing. Three clusters index.ts
    // imported eagerly now load inside the command that uses them:
    // codexAccounts.ts and codexResetCredit.ts inside `cast accounts codex
    // reset-credit`, and statuslineHook.ts with capabilities/hooks.ts inside
    // `installStatusLineHook` and `cast uninstall`. Neither is a COMMAND_GROUPS
    // entry: a group is a whole verb, and these are individual symbols used by
    // one action apiece, so a dynamic import at the use site is the same
    // laziness without a placeholder command nobody would name.
    //
    // Measured, not estimated: dropping the four import lines and rebuilding
    // the graph gives 209/2,866, and the implementation lands on 209/2,867 —
    // the extra KB is the comments at the new import sites. The four together
    // are worth more than the sum of their parts (1+4+1+2 = 8 files apart, 11
    // together), because the two codex modules share reach that only leaves
    // when both of them do.
    //
    // 214 files and 2,990 KB after the 2026-09-13 release sweep: six new
    // leaves, none of them a command group. taskPulse.ts (the decide default
    // reads the session's task pulse from sync helpers, so it stays eager),
    // userFiles.ts under parser.ts (files an agent sends ride the transcript
    // parse), shared/files/index.ts under syncService.ts (the media table those
    // files use) and three contracts the shared barrel now carries
    // (agentDefinitions, forkSeed, liveActivity). The command-only modules the
    // sweep added load at their use sites instead: forkFanout.ts inside
    // `cast fork`, orgTarget.ts inside the org verbs that resolve a target.
    //
    // 216 files, 2,998 KB and 301 after the 2026-09-14 release, down from the
    // 218 / 3,020 / 303 the second cut pinned. toolKinds.ts is a split of
    // shared/render/toolCall.ts (its family classifiers, no new reach) and
    // sits on both graphs where toolCall.ts already was. orgInit.ts registers
    // the `cast org init` verbs; their bodies, the analyzer prompt and the
    // proposal contract it embeds load inside each action (orgInitRun.ts).
    // browser/desktopPaneRegistry.ts is the daemon's own record of the
    // desktop panes it pins, read by the watch source that feeds them.
    // The bundled skills, the brief lines and the two new contracts
    // (orgProposal, browserPaneOffer) stay off: loaded at their use sites, and
    // the contracts are imported by path, never through the barrel.
    //
    // 218 after the third 2026-09-15 cut: orgTemplate.ts, the org template
    // registrar (its verb bodies load inside each action, like orgInit), and the
    // unattended contract the shared barrel now exports.
    //
    // 3,032 KB at the same 218 files after ct-51367: the `cast chat slack`
    // verbs (the two way Slack mirror of team chat) are 11 KB of code in
    // index.ts itself, reaching nothing new. Code, not reach, again.
    //
    // 219 after ct-51435: triggerLifecycle.ts, the run completion vocabulary
    // the scheduler and the Convex writer both state. A leaf of pure strings
    // through the barrel, importing nothing; no subsystem arrived with it.
    // 220 after the 2026-09-15 sweep: convexConnectionState.ts, a leaf the
    // CLI command tree reads for connection copy.
    //
    // 231 files and 3,204 KB after the cloud host landing (pl-549), measured
    // against a main that had itself grown to 223 files without re-pinning.
    // Eight new leaves, none a command group: remote/agentAuth.ts,
    // agentAuthReceiver.py.ts, agentSpawnPath.ts and config/readLocalConfig.ts
    // arrive through remote/session-move.ts (the trust-only push a session
    // move runs needs the bundle shape and the receiver script);
    // codexAuthDecode.ts is the auth.json decoder split out of
    // codexAccounts.ts so that bundle does not drag the codex usage cluster
    // off this graph; shared/contracts/cloudPlacement.ts and cloudWorkspace.ts
    // come through the contracts barrel. The rest of the bytes are the cloud
    // placement, seed and `cast git-credential` fast path code written into
    // files already here (cloud/cli.ts, cloud/prepare.ts, cloud/transfer.ts,
    // hosts/cli.ts, fastPath.ts, index.ts). The credential helper's own module
    // stays off this graph: it is a COMMAND_GROUPS entry that fastPath reaches
    // through a dynamic import, which assertOffGraph above proves.
    //
    // 232 after ct-52405: selfExec.ts, the one "run this build again" resolver
    // index.ts and the daemon each used to carry a copy of. Imports only node.
    //
    // 247 after the 2026-09-19 landing: eleven leaves, each work the command
    // tree itself does rather than a group arriving sideways. The three Claude
    // Code hook handlers with their shared hookJson.ts (cast runs them as
    // hooks, so index.ts dispatches them), initiativeCommand.ts with its
    // contracts/initiative.ts (the initiative line formatters index.ts renders)
    // and the four org/idle/handoff contracts the tree reads directly.
    // 253 after hook admission: statusHook.ts now reads its token through
    // hookIdentity.ts (node and atomicWrite only), and session-move.ts copies
    // worktree files through workspace/copyFiles.ts.
    // 263 after sync exclusions: syncScope.ts reads its folder lists through
    // @codecast/shared/team/syncPlan (no imports), the rule the settings page
    // and `cast sharing` read too.
    // 262 after the 2026-09-30 cloud agents landing, which had pushed it to 280.
    // Its new leaves stay: the `cast sync` verb registrar cloud/syncCli.ts
    // (bodies load inside each action), shared/search for the operator help
    // text, cloudAgents/transcript.ts under parser.ts, cloud/gitOrigin.ts under
    // gitPlane.ts, cloud/mirror/bundle.ts and seven contracts through the
    // barrel. What left: ccAccounts.ts read the Claude login through
    // remote/session-move.ts, which dragged the whole session move cluster
    // (12 files) onto every command; the read now lives in ccKeychain.ts beside
    // the item names it reads. The usage poll loads cloudAgents/http.ts and
    // usageRetry.ts when it runs, and `cast doctor` loads doctor.ts (5 files).
    // One leaf arrived: cliVersion.ts, the version read update.ts and the
    // harness ledger share, so the worker runtime no longer loads the updater.
    // Plus cloudAgents/apiError.ts, the provider error reader transcript.ts
    // uses; it is a leaf so the HTTP client stays off this graph.
    // Plus shared/contracts/levenshtein.ts, the edit distance commandSuggestion.ts
    // shares with the convex sim backend. It is a subpath import, not part of
    // the contracts barrel, so the daemon graph does not carry it.
    // Plus the `cast doc` drafting verbs: docDraftingCommand.ts, a registrar
    // whose bodies load inside each action, and shared/docs/drafting.ts, a
    // pure leaf with the constants its help text names.
    // Re-measured at 324 files and 4462 KB on 2026-10-15, after two weeks no
    // run reached this case and the graph had grown to 420 and 5668 KB. Two
    // cuts brought it down: `cast line` became a command group (lineCommand.ts,
    // 80 files of line profile, moments, trials, dissolves and judges), and
    // taskGraphCommands.ts stopped importing shq from remote/session-move.ts,
    // which had put the session move cluster back on every command (17 files).
    // The rest is real growth: 22 contracts through the barrel, 6 shared/tasks
    // modules and about 25 small leaves index.ts uses. Owed next: the shared
    // contracts barrel, 77 files that reach this graph only through it, moved
    // to subpath imports.
    // 325 on 2026-10-16: the workflows section of the agent instructions moved
    // to contracts/snippetsWorkflow.ts to keep snippets.ts under its max-lines
    // pin. snippets.ts composes it, and the barrel carries snippets.ts, so any
    // split of that file adds one here until the barrel is gone.
    // Held at 325 on 2026-10-24 when the ship of that day brought 8 files: the
    // workspace manifest and transcript redaction took the Vault contract
    // (secrets.ts with productView.ts) for a name check and two size limits, so
    // those pure rules moved to the leaf contracts/secretRules.ts, and the new
    // contracts/teamHosts.ts left the barrel for a subpath import. What stays is
    // directoryTeam.ts (stableContext), loginShellPath.ts, shellQuote.ts
    // (launchCommand), secretShapes.ts (redaction) and render/structuredResult.ts.
    // 326 on 2026-10-26: ccAdoptLogin.ts, the cloud Mac's keychain adopt job,
    // split out of ccAccounts.ts to hold that file under its max-lines pin.
    // 328 on 2026-10-26: managed policy (MDM), config/managedPolicy.ts, which
    // every config reader overlays, and the barrel's contracts/managedPolicy.ts.
    // 329 on 2026-10-26: managedInstall.ts, whether this binary is the MDM
    // .pkg's root-owned copy (self-update steps aside for it).
    // 327 on 2026-10-26: jsonlGenerator.ts took only encodePiCwdSlug from
    // transcriptDirWatcher.ts, which carried recursiveWatcher.ts along; the pi
    // slug pair moved beside claudeProjectDirName in projectPathResolver.ts.
    // 328 on 2026-10-26: the barrel's contracts/decisionAnswers.ts, split out of
    // contracts/machineMessages.ts for its max-lines pin. The same pass's other
    // splits went into files already here: the resume flag readers into
    // resumeCommand.ts, live process discovery into sessionProcessMatcher.ts.
    // 329 on 2026-10-27: psTerminal.ts, the ps terminal tokens as a leaf. They
    // lived in resourceMonitor.ts, which processTable.ts reads at load time
    // through the cycle processTable -> resourceMonitor -> sessionProcessMatcher
    // -> tmux, so loading resourceMonitor first threw a TDZ ReferenceError.
    // 330 on 2026-10-29: contracts/inboxFields.ts, the inbox field ownership
    // lists split out of contracts/inboxProjection.ts for its max-lines pin.
    expect(graph.nodes.size, "source files on index.ts's static graph").toBeLessThanOrEqual(330);
    // 3404 KB with those eleven leaves and the growth of index.ts itself.
    // 3407 after ct-52819: the watchdog pass deadline in supervision.ts and the
    // launchd kickstart in index.ts's startDaemon. No new file.
    // 3474 after hook admission: the two leaves above, plus the token read and
    // the legacy grace in statusHook.ts and the copy step in session-move.ts.
    // 4462 on 2026-10-15, re-measured with the file count above.
    // 4339 on 2026-10-16: orgProposal.ts left the graph. rolePlaybook.ts took
    // only everyWords from it and orgTemplateManifest.ts only LINE_SLUG_RE
    // (now in the lineSlug.ts leaf), so the whole proposal module and, since
    // bc5b8ded2, orgSessionFiling.ts under it rode along on every command.
    // 4340 on 2026-10-16: the snippets workflow split (see the file count)
    // adds its header, import and re-export.
    // 4343 with the pinned state rows: threadStateRows, the ask split and the
    // new card line in contracts/threadState.ts (+2.6 KB), and the longer
    // Thread state section in snippets.ts (+0.6 KB). No new file.
    // 4360 on 2026-10-24: that day's ship added 68.7 KB here after the Vault
    // contract and contracts/teamHosts.ts were taken off (see the count above).
    // The Vault's redaction leads it (secretShapes.ts +10.8, secretRules.ts +7,
    // knownValueRedaction.ts +4.4), then installed guidance in snippets.ts
    // (+8.3), render/structuredResult.ts (+7.8) and handoffPrompt.ts (+4.8).
    // 4405 on 2026-10-26: managed policy (MDM), which every config read
    // overlays: contracts/managedPolicy.ts (+14.5), config/managedPolicy.ts
    // (+13.5), managedInstall.ts (+2.4), the policy guards and the enroll
    // retry hint in index.ts (4406).
    // 4374 on 2026-10-26: the Flows feature state in contracts/teamFeatures.ts
    // (+1.3) and the pool's flows_on read in stableContext.ts (+0.4) went past
    // 4406; the watcher pair above leaving (-36) more than pays for them.
    // 4379 on 2026-10-26: the max-lines splits above moved code between files
    // already on this graph (resumeCommand.ts, sessionProcessMatcher.ts,
    // contracts/decisionAnswers.ts), adding their headers and imports, and
    // ccAccounts.ts grew; still under the 4406 this pass started from.
    // 4380 on 2026-10-27: `cast workflow resume --current-flow` in index.ts
    // (+0.25), which moves a failed run onto its flow's current version.
    // 4380 on 2026-10-27: the timeline group's one help line in
    // commandGroups.ts (ct-70247); timelineCommand.ts loads lazily.
    // 4384 on 2026-10-27: snippets.ts's one section writer the capability
    // driver shares, and project instruction targets (ct-42887, ct-74443).
    // 4397 on 2026-10-28: goals and projects read live numbers from metric
    // series. contracts/initiative.ts (+6.4: series readings, pace, the
    // metric spec, the value formatter) and contracts/rolePlaybook.ts (+5:
    // the Experiments section and the climbing guidance `cast brief` prints),
    // folded into files already here rather than two new leaves.
    // 4400 on 2026-10-28: managed devices (MDM). contracts/managedPolicy.ts
    // (+2: each policy's refusal words and the removed-device message) and
    // index.ts printing that message when a team has removed the device.
    // 4401 on 2026-10-29: contracts/inboxProjection.ts lifting a hidden role
    // lead whose only live work is a nested subagent (child_live).
    // 4405 on 2026-10-31: that day's ship grew files already here: castApi.ts
    // (+1.1, publish limits), index.ts and parser.ts (+0.6 each),
    // contracts/threadState.ts (+0.5), contracts/lineProfile.ts,
    // analytics/events.ts and contracts/transcriptChunk.ts (+0.4 each).
    // +1 on 2026-11-01: the `herd take` subcommand registration in index.ts
    // (its module, herdCommand.ts, loads lazily).
    expect(Math.round(graph.totalBytes / 1024), "KB of source on index.ts's static graph").toBeLessThanOrEqual(4406);
  }, GRAPH_WALK_TIMEOUT);

  test("main.ts, the process entry, reaches only the fast path", () => {
    const graph = buildBootGraph(path.join(SRC, "main.ts"));
    // Plus syncStdio.ts, installed before anything can write so a large write
    // into a pipe arrives whole (fe4d8f0da), and proc.ts, which main.ts's
    // dry-run hand-off spawns through like every caller (the child_process
    // ratchet), with its two leaves: slowSync.ts and workers/bridge.ts, whose
    // worker modules stay behind import type and a dynamic import (2026-10-15).
    expect([...graph.nodes.keys()].map(rel).sort()).toEqual([
      "packages/cli/src/fastPath.ts", "packages/cli/src/main.ts", "packages/cli/src/proc.ts",
      "packages/cli/src/slowSync.ts", "packages/cli/src/syncStdio.ts", "packages/cli/src/workers/bridge.ts",
    ]);
  });

  test("the daemon carries no CLI command group either", () => {
    const graph = assertOffGraph(path.join(SRC, "daemon.ts"));
    // 273 measured on the union (ct-49848). The daemon is the process that RUNS
    // the workers, so all 26 `workers/*` modules are work it actually does
    // rather than a graph it carries by accident (ct-49758) — but the command
    // groups are not its work, which is what assertOffGraph checks above.
    // 290 after the landing, from the same new leaves index.ts picked up.
    // 291 after ct-49854, which is one new leaf: pendingPromptHold.ts, imported
    // by daemon.ts directly. Holding a prompt the daemon has not delivered yet
    // is the daemon's own work, so it is a leaf it legitimately gained rather
    // than a subsystem arriving sideways.
    // 300 after the 2026-09-13 release sweep: nine leaves that are the daemon's
    // own work or the shared contracts index.ts also gained. tmuxDeliveryJournal.ts
    // and tmuxSessionLookup.ts (delivery repair), agentLaunch.ts through
    // taskScheduler.ts (the scheduler launches hands from definitions),
    // messagePreparationValidation.ts under the ingest client, userFiles.ts,
    // shared/files and the three contracts. reopenTab.ts left the graph at the
    // same time: focusHttp.ts loads it on the reopen route only.
    // The daemon reaches render/toolKinds.ts through tmuxSpawns.ts.
    // 305 after the third 2026-09-15 cut: escapeInterrupt.ts (the daemon decides
    // an Escape itself), desktopPaneRegistry.ts and realChrome.ts under the watch
    // source that feeds desktop panes, and the unattended contract via the barrel.
    // 306 after ct-51435: triggerLifecycle.ts, the same run completion leaf,
    // reached through taskScheduler.ts which already sat on this graph.
    // 310 after the 2026-09-15 sweep: idleProbe, keepalive, convexConnectionState
    // and watchActions, the daemon's own cloud and browser-watch work.
    // 320 after the cloud host landing (pl-549), against a main that had grown
    // to 312 on its own: the same eight leaves index.ts
    // picked up through remote/session-move.ts (remote/agentAuth.ts, its
    // receiver script, codexAuthDecode.ts, config/readLocalConfig.ts, the two
    // cloud contracts, cloud/ghWrapper.ts) plus cloud/agentBridge.ts, imported by daemon.ts
    // directly. The agent logins fan out and the ssh agent bridge are the
    // daemon's own work (it runs both on its credential tick), so these are
    // leaves it legitimately gained rather than a subsystem arriving sideways.
    // 321 after ct-52405: selfExec.ts (above). Imports only node.
    // 326 after the same landing: the daemon picked up the leaves index.ts did
    // where they are its own work too (the hook handlers it dispatches and the
    // shared contracts), not a command group.
    // 349 after hook admission: the daemon authenticates hook posts
    // (hookIdentity.ts, hookAdmission.ts) and upgrades the hook scripts it
    // installed, so it carries the script constants and the handler modules that
    // define them; plus deviceAccount.ts, vault/vaultCapability.ts and
    // workspace/copyFiles.ts, all leaves on node alone or the workspace manifest.
    // 358 after sync exclusions: the shared folder list rule in syncScope.ts.
    // 389 after the 2026-09-30 cloud agents, cloud sync and usage retry work,
    // every file of it the daemon's own: the Cursor and Codex cloud agent
    // registry (cloudAgents/*, 12 files, built when daemon.ts loads: the
    // OpenAI Agents API adapter openaiAgents.ts and streams.ts, the stream
    // reader it shares with the Cursor adapter, are the last two, beside
    // apiError.ts, the leaf error reader the transcript writer shares) with the
    // sse.ts parser those streams read, claudeCloud.ts (the claude.ai
    // session watcher, started on every boot), workers/cursorObservation.ts
    // under the ingest worker, typedPollAnswer.ts in message delivery,
    // usageRetry.ts with cloudAgents/http.ts for the usage polls,
    // cloud/syncSide.ts under worktreeGc.ts, cloud/tailnet.ts under
    // cloudHost.ts, browser/hostScreen.ts under browser/instance.ts,
    // cloud/gitOrigin.ts, cloud/mirror/bundle.ts, shared/blame under
    // repoMirror.ts, search/tokenize.ts under the vault index, and seven
    // contracts through the barrel. A dynamic import of the registry or the
    // watcher would lower this number without lowering what the daemon
    // loads, since both run at boot. Plus cliVersion.ts, the same leaf as above.
    // Plus cloudAgents/shape.ts, the payload shape check http.ts runs on each
    // cloud agent answer (the Codex Cloud kill switch).
    // Re-measured at 488 on 2026-10-15, after two weeks no run reached this
    // case (the cli job bailed earlier). The growth is the daemon's own work
    // landing: the shared contracts barrel (85 files only the daemon reaches
    // through it), the evals server with its api contract, the execution
    // layer, the browser watch source, capability reconcile, more cloud agent
    // modules, the session move cluster and the snippets package. Daemon boot
    // is not on any command's latency path, and no single import here is an
    // accident to cut.
    // 483 on 2026-10-16: orgProposal.ts and the five files only it brought
    // (orgSessionFiling, orgLead, initiative, roleAutonomy, chat/handles) left
    // when rolePlaybook.ts, reached through the barrel, stopped importing it.
    // 484 on 2026-10-16: contracts/snippetsWorkflow.ts, split out of
    // snippets.ts for its line pin (see the index.ts count).
    // 493 on 2026-10-20, again after days no run reached this case: the
    // daemon's own modules (interactivePrompt.ts split out of daemon.ts,
    // heicImage, tmuxSuspendedAgent, pendingDeliveryBatches, threadQos,
    // backgroundPriority, systemdDaemonUnit, localData) and contracts/lineDeploy.ts,
    // the profile leaf split out of deploys.ts so the line profile no longer
    // brings the deploy history (causeHistory.ts, changeCard.ts) along.
    // 494 on 2026-10-24: resumePlacement.ts, split out of daemon.ts for its
    // line pin (where a resume may run, and the refusal texts).
    // 497 on 2026-10-24: diskFull.ts (a full disk holds the host's line runs),
    // worktreeLegacy.ts (split out of daemon.ts for its line pin) and
    // workflow/runDirs.ts, which the daemon now reads to release finished runs'
    // worktrees.
    // 510 on 2026-10-24, the daemon's own work from that day's ship: the Vault's
    // redaction source (secrets/redactionSource.ts with the secrets contract,
    // productView.ts, secretShapes.ts and the secretRules.ts leaf), the team
    // host marker (hosts/teamMarker.ts, contracts/teamHosts.ts), the agent
    // preflight's loginShellPath.ts and shellQuote.ts, permissionHookWait.ts,
    // loadGovernor.ts, directoryTeam.ts and render/structuredResult.ts.
    // 511 on 2026-10-26: cursorDbPath.ts, the leaf every Cursor database open
    // goes through (a closed WAL workspace opens immutable).
    // 512 on 2026-10-26: ccAdoptLogin.ts, split out of ccAccounts.ts (above).
    // 514 on 2026-10-26: managed policy, the same two files as index.ts's (above).
    // 515 on 2026-10-26: managedInstall.ts (above).
    // 516 on 2026-10-26: contracts/deliveryFailed.ts, the row the daemon writes
    // when it stops delivering a message (a subpath import, off the barrel).
    // 518 on 2026-10-26, two splits for max-lines pins: tmuxPaneState.ts (the
    // pane classifiers, out of daemon.ts) and contracts/decisionAnswers.ts (above).
    // 519 on 2026-10-27: psTerminal.ts, the ps terminal tokens as a leaf. They
    // lived in resourceMonitor.ts, which processTable.ts reads at load time
    // through the cycle processTable -> resourceMonitor -> sessionProcessMatcher
    // -> tmux, so loading resourceMonitor first threw a TDZ ReferenceError.
    // 521 on 2026-10-27: handEdit.ts and projectWrites.ts, which the capability
    // driver's markdown_section arm judges every owned region with (ct-42887).
    // 522 on 2026-10-29: planHandoff.ts, the one plan-handoff parser the daemon
    // and the ingest worker share (a compaction summary self-linked a session).
    // 523 on 2026-10-29: contracts/inboxFields.ts, split out of
    // contracts/inboxProjection.ts for its max-lines pin.
    // 524 on 2026-10-31: herdTake.ts, the swap hold and the take route's
    // orchestration and client (the CLI loads the same file lazily).
    // 525 on 2026-10-31: transcriptTurn.ts, the unanswered-turn reading the
    // take's busy check makes of a transcript tail.
    expect(graph.nodes.size, "source files on daemon.ts's static graph").toBeLessThanOrEqual(525);
  }, GRAPH_WALK_TIMEOUT);

  test("commandGroups.ts is a leaf: it imports no repo module at runtime", () => {
    const graph = buildBootGraph(path.join(SRC, "commandGroups.ts"));
    expect([...graph.nodes.keys()].map(rel)).toEqual(["packages/cli/src/commandGroups.ts"]);
  });
});

describe("the import walker the guard is built on", () => {
  test("reads static imports and ignores dynamic ones", () => {
    const source = [
      'import { a } from "./a.js";',
      'import type { T } from "./type-only.js";',
      'import { type U, type V } from "./also-type-only.js";',
      'export { b } from "./b.js";',
      'import "./side-effect.js";',
      'const late = await import("./lazy.js");',
      'const chained = import("./chained.js").then((m) => m.go);',
    ].join("\n");
    expect(staticImportSpecifiers(source)).toEqual(["./a.js", "./b.js", "./side-effect.js"]);
  });

  test("a `from` inside a later statement is not paired with an earlier import()", () => {
    const source = 'import("./lazy.js").then(go);\nconst note = "read from disk";\nimport { real } from "./real.js";';
    expect(staticImportSpecifiers(source)).toEqual(["./real.js"]);
  });
});
